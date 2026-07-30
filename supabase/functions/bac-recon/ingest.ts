// BAC bank-statement ingest: turns a parsed BACParseResult into committed
// recon_uploads + recon_transactions + recon_links rows, advancing the
// file-clock so eligible pending PRs flip to confirmed.
//
// Idempotency model:
//   - File-level: (account_id, file_sha256) UNIQUE on recon_uploads. Re-
//     uploading the same bytes returns fileWasDuplicate=true without writing.
//   - Row-level: (account_id, row_hash) UNIQUE on recon_transactions. Re-
//     ingesting overlapping rows is silently absorbed; the operator diff
//     surfaces how much was new vs duplicate.
//   - Link-level: recon_links has pr_txn_id as PRIMARY KEY and da_txn_id as
//     UNIQUE, so first-DA-wins-per-PR is enforced by the database.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

import {
  classifyBACRow,
  computeFileSha256,
  computeRowHash,
} from "./classify.ts";
import type { BACParseResult } from "./parser.ts";
import { recomputeAccount } from "./recompute.ts";

export interface IngestArgs {
  supabase: SupabaseClient;
  accountId: string;
  fileBytes: Uint8Array;
  originalFilename: string;
  uploadedBy?: string;
  parseResult: BACParseResult;
  storagePath?: string;
}

export interface IngestResult {
  uploadId: string | null;
  fileWasDuplicate: boolean;
  rowsTotal: number;
  rowsNew: number;
  rowsDuplicate: number;
  dateRangeAdded: { start: string; end: string } | null;
  dateRangeOverlap: { start: string; end: string } | null;
  prsConfirmedThisRun: number;
  reversalsPaired: number;
  reversalsUnpaired: number;
  /** Account-wide after this ingest: PR batches with no DA pairings. The
   *  operator can manually confirm those, or wait — they may pair with a
   *  future file's DA batch. */
  prBatchesPending: number;
  warnings: string[];
}

interface ReconTxnInsert {
  upload_id: string;
  account_id: string;
  posted_at: string;
  rail_native_ref: string;
  code: string;
  description: string;
  debit_minor: string; // bigint as string for PostgREST
  credit_minor: string;
  balance_minor: string;
  currency: string;
  return_code: string | null;
  payer_name_raw: string | null;
  kind: string;
  state: string;
  confirmable_after: string | null;
  row_hash: string;
}

export async function ingestBACFile(args: IngestArgs): Promise<IngestResult> {
  const { supabase, accountId, fileBytes, originalFilename, uploadedBy, parseResult, storagePath } = args;
  const warnings = [...parseResult.warnings];

  const fileSha256 = await computeFileSha256(fileBytes);
  const { header, rows, integrity } = parseResult;

  // ----- recon_uploads (file-level dedup) ----------------------------------
  const uploadInsert = {
    account_id: accountId,
    method: "statement_excel",
    file_sha256: fileSha256,
    storage_path: storagePath ?? null,
    original_filename: originalFilename,
    uploaded_by: uploadedBy ?? null,
    date_range_start: header.dateRangeStart || null,
    date_range_end: header.dateRangeEnd || null,
    saldo_inicial_minor: header.saldoInicialMinor.toString(),
    saldo_final_minor: header.saldoFinalMinor.toString(),
    integrity_ok: integrity.ok,
    rows_total: rows.length,
    status: "parsed",
  };

  const { data: insertedUpload, error: insertErr } = await supabase
    .from("recon_uploads")
    .insert(uploadInsert)
    .select("id")
    .single();

  if (insertErr) {
    // 23505 = unique_violation → same bytes already ingested for this account.
    if (insertErr.code === "23505") {
      const { data: existing } = await supabase
        .from("recon_uploads")
        .select("id")
        .eq("account_id", accountId)
        .eq("file_sha256", fileSha256)
        .single();
      return {
        uploadId: existing?.id ?? null,
        fileWasDuplicate: true,
        rowsTotal: rows.length,
        rowsNew: 0,
        rowsDuplicate: rows.length,
        dateRangeAdded: null,
        dateRangeOverlap: rangeOrNull(header.dateRangeStart, header.dateRangeEnd),
        prsConfirmedThisRun: 0,
        reversalsPaired: 0,
        reversalsUnpaired: 0,
        prBatchesPending: 0,
        warnings,
      };
    }
    throw insertErr;
  }
  const uploadId = insertedUpload!.id as string;

  // ----- date-range overlap (computed BEFORE any rows are inserted) --------
  const [{ data: minRow }, { data: maxRow }] = await Promise.all([
    supabase
      .from("recon_transactions")
      .select("posted_at")
      .eq("account_id", accountId)
      .order("posted_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("recon_transactions")
      .select("posted_at")
      .eq("account_id", accountId)
      .order("posted_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const priorStart = (minRow?.posted_at as string | undefined) ?? null;
  const priorEnd = (maxRow?.posted_at as string | undefined) ?? null;
  const overlap = rangeIntersection(
    header.dateRangeStart,
    header.dateRangeEnd,
    priorStart,
    priorEnd,
  );
  const added = rangeMinus(
    header.dateRangeStart,
    header.dateRangeEnd,
    overlap,
  );

  // ----- recon_transactions (row-level dedup, classification) --------------
  const txnsToInsert: ReconTxnInsert[] = await Promise.all(
    rows.map(async (r) => {
      const classification = classifyBACRow(r);
      const rowHash = await computeRowHash({
        accountId,
        postedAt: r.postedAt,
        reference: r.reference,
        code: r.code,
        description: r.description,
        debitMinor: r.debitMinor,
        creditMinor: r.creditMinor,
        balanceMinor: r.balanceMinor,
      });
      return {
        upload_id: uploadId,
        account_id: accountId,
        posted_at: r.postedAt,
        rail_native_ref: r.reference,
        code: r.code,
        description: r.description,
        debit_minor: r.debitMinor.toString(),
        credit_minor: r.creditMinor.toString(),
        balance_minor: r.balanceMinor.toString(),
        currency: header.currency,
        return_code: r.returnCode ?? null,
        payer_name_raw: r.payerNameRaw ?? null,
        kind: classification.kind,
        state: classification.state,
        confirmable_after: classification.confirmableAfter,
        row_hash: rowHash,
      };
    })
  );

  // Insert in chunks of 500 — keeps any single PostgREST request under
  // the body-size limit, and we don't rely on the .select() response to
  // discover newly-inserted rows (Supabase JS caps responses at 1000,
  // which silently dropped DAs from the pairing loop on large uploads).
  const INSERT_CHUNK = 500;
  let rowsNew = 0;
  for (let i = 0; i < txnsToInsert.length; i += INSERT_CHUNK) {
    const chunk = txnsToInsert.slice(i, i + INSERT_CHUNK);
    const { data: inserted, error: txnErr } = await supabase
      .from("recon_transactions")
      .upsert(chunk, { onConflict: "account_id,row_hash", ignoreDuplicates: true })
      .select("id");
    if (txnErr) {
      await markUploadFailed(supabase, uploadId, txnErr.message);
      throw txnErr;
    }
    rowsNew += inserted?.length ?? 0;
  }
  const rowsDuplicate = rows.length - rowsNew;

  // ----- Finalize the upload row -------------------------------------------
  await supabase
    .from("recon_uploads")
    .update({
      rows_new: rowsNew,
      rows_duplicate: rowsDuplicate,
      status: "committed",
    })
    .eq("id", uploadId);

  return {
    uploadId,
    fileWasDuplicate: false,
    rowsTotal: rows.length,
    rowsNew,
    rowsDuplicate,
    dateRangeAdded: added,
    dateRangeOverlap: overlap,
    prsConfirmedThisRun: 0,
    reversalsPaired: 0,
    reversalsUnpaired: 0,
    prBatchesPending: 0,
    warnings,
  };
}

async function markUploadFailed(
  supabase: SupabaseClient,
  uploadId: string,
  message: string,
): Promise<void> {
  await supabase
    .from("recon_uploads")
    .update({ status: "failed", error_message: message })
    .eq("id", uploadId);
}

// =============================================================
// Pure date-range helpers (exported for tests)
// =============================================================

export function rangeOrNull(start: string, end: string): { start: string; end: string } | null {
  return start && end ? { start, end } : null;
}

export function rangeIntersection(
  aStart: string,
  aEnd: string,
  bStart: string | null,
  bEnd: string | null,
): { start: string; end: string } | null {
  if (!aStart || !aEnd || !bStart || !bEnd) return null;
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  if (start > end) return null;
  return { start, end };
}

export function rangeMinus(
  aStart: string,
  aEnd: string,
  carve: { start: string; end: string } | null,
): { start: string; end: string } | null {
  if (!aStart || !aEnd) return null;
  if (!carve) return { start: aStart, end: aEnd };
  // Single carve is one of: identical, prefix, suffix, or interior.
  // We only report a single contiguous "added" range — if the carve is
  // interior, both sides are technically new, but for the operator diff a
  // single contiguous gap is a fine approximation; surface a warning later
  // if this becomes an actual concern in production.
  if (carve.start <= aStart && carve.end >= aEnd) return null;
  if (carve.start <= aStart) return { start: nextDay(carve.end), end: aEnd };
  if (carve.end >= aEnd) return { start: aStart, end: prevDay(carve.start) };
  return { start: nextDay(carve.end), end: aEnd };
}

function nextDay(iso: string): string {
  const t = Date.parse(iso + "T00:00:00Z");
  return new Date(t + 86400000).toISOString().slice(0, 10);
}

function prevDay(iso: string): string {
  const t = Date.parse(iso + "T00:00:00Z");
  return new Date(t - 86400000).toISOString().slice(0, 10);
}
