// BG ingest pipeline. Two entry points (one per file shape):
//
//   ingestBGStatementFile  — writes statement rows to recon_transactions.
//   ingestBGAchDetailFile  — writes detail rows to recon_ach_batch_lines.
//
// Both follow the BAC pattern:
//   1. Insert a recon_uploads row keyed on (account_id, file_sha256).
//      Duplicate bytes short-circuit and the caller sees fileWasDuplicate.
//   2. Compute per-row hash + upsert with onConflict=ignoreDuplicates so
//      re-uploading the same logical line collapses cleanly.
//   3. Finalize the upload row.
//
// No reconciliation logic here yet — the matching engines for BG land in
// chunks 2/3. This file is just parse → store.

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  classifyBGCode,
  computeBGAchDetailRowHash,
  computeBGStatementRowHash,
  type BGAchDetailParseResult,
  type BGStatementParseResult,
} from "./parser";

export interface BGStatementIngestArgs {
  supabase: SupabaseClient;
  accountId: string;
  fileBytes: Uint8Array;
  originalFilename: string;
  uploadedBy?: string | null;
  parseResult: BGStatementParseResult;
}

export interface BGStatementIngestResult {
  uploadId: string | null;
  fileWasDuplicate: boolean;
  rowsTotal: number;
  rowsNew: number;
  rowsDuplicate: number;
  loanInflowRows: number;
  nonLoanRows: number;
  unknownCodeRows: number;
  warnings: string[];
}

export interface BGAchDetailIngestArgs {
  supabase: SupabaseClient;
  accountId: string;
  fileBytes: Uint8Array;
  originalFilename: string;
  uploadedBy?: string | null;
  parseResult: BGAchDetailParseResult;
}

export interface BGAchDetailIngestResult {
  uploadId: string | null;
  fileWasDuplicate: boolean;
  rowsTotal: number;
  rowsNew: number;
  rowsDuplicate: number;
  approvedRows: number;
  rejectedRows: number;
  warnings: string[];
}

function computeFileSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// =============================================================
// Statement
// =============================================================

export async function ingestBGStatementFile(
  args: BGStatementIngestArgs,
): Promise<BGStatementIngestResult> {
  const { supabase, accountId, fileBytes, originalFilename, uploadedBy, parseResult } = args;
  const { header, rows } = parseResult;
  const warnings = [...parseResult.warnings];
  const fileSha256 = computeFileSha256(fileBytes);

  // 1. Upload row (dedup by file bytes per account).
  const uploadInsert = {
    account_id: accountId,
    method: "statement_bg_excel",
    file_sha256: fileSha256,
    original_filename: originalFilename,
    uploaded_by: uploadedBy ?? null,
    date_range_start: header.dateRangeStart || null,
    date_range_end: header.dateRangeEnd || null,
    saldo_inicial_minor: "0",
    saldo_final_minor: "0",
    integrity_ok: null,
    rows_total: rows.length,
    status: "parsed",
  };
  const { data: insertedUpload, error: insertErr } = await supabase
    .from("recon_uploads")
    .insert(uploadInsert)
    .select("id")
    .single();
  if (insertErr) {
    if (insertErr.code === "23505") {
      return {
        uploadId: null,
        fileWasDuplicate: true,
        rowsTotal: rows.length,
        rowsNew: 0,
        rowsDuplicate: rows.length,
        loanInflowRows: 0,
        nonLoanRows: 0,
        unknownCodeRows: 0,
        warnings,
      };
    }
    throw insertErr;
  }
  const uploadId = insertedUpload!.id as string;

  // 2. Build txn inserts.
  type BgTxnInsert = {
    upload_id: string;
    account_id: string;
    posted_at: string;
    rail_native_ref: string | null;
    code: string;
    description: string;
    debit_minor: string;
    credit_minor: string;
    balance_minor: string;
    currency: string;
    return_code: string | null;
    payer_name_raw: string | null;
    kind: string;
    state: string;
    confirmable_after: string | null;
    row_hash: string;
  };
  let loanInflowRows = 0;
  let nonLoanRows = 0;
  let unknownCodeRows = 0;
  const txnsToInsert: BgTxnInsert[] = rows.map((r) => {
    const kind = classifyBGCode(r.code);
    if (kind === "loan_inflow") loanInflowRows++;
    else if (kind === "non_loan") nonLoanRows++;
    else unknownCodeRows++;
    // BG statement rows are individually committed when they post:
    //   - loan_inflow → "pending" (awaits operator matching to a loan;
    //     chunk 3 will move them to a confirmed/rejected state)
    //   - non_loan    → "non_loan" (never reconciled)
    //   - unknown     → "pending" (so it surfaces in the UI for review)
    const state = kind === "non_loan" ? "non_loan" : "pending";
    return {
      upload_id: uploadId,
      account_id: accountId,
      posted_at: r.postedAt,
      rail_native_ref: r.reference || null,
      code: r.code,
      description: r.description,
      debit_minor: r.debitMinor.toString(),
      credit_minor: r.creditMinor.toString(),
      balance_minor: r.balanceMinor.toString(),
      currency: "USD",
      return_code: null,
      payer_name_raw: r.payerNameRaw ?? null,
      kind,
      state,
      confirmable_after: null,
      row_hash: computeBGStatementRowHash({
        accountId,
        postedAt: r.postedAt,
        reference: r.reference,
        code: r.code,
        description: r.description,
        debitMinor: r.debitMinor,
        creditMinor: r.creditMinor,
        balanceMinor: r.balanceMinor,
      }),
    };
  });

  // 3. Chunked upsert.
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

  // 4. Finalize.
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
    loanInflowRows,
    nonLoanRows,
    unknownCodeRows,
    warnings,
  };
}

// =============================================================
// ACH detail
// =============================================================

export async function ingestBGAchDetailFile(
  args: BGAchDetailIngestArgs,
): Promise<BGAchDetailIngestResult> {
  const { supabase, accountId, fileBytes, originalFilename, uploadedBy, parseResult } = args;
  const { envelope, rows } = parseResult;
  const warnings = [...parseResult.warnings];
  const fileSha256 = computeFileSha256(fileBytes);

  // 1. Upload row.
  const uploadInsert = {
    account_id: accountId,
    method: "ach_detail_bg_excel",
    file_sha256: fileSha256,
    original_filename: originalFilename,
    uploaded_by: uploadedBy ?? null,
    date_range_start: envelope.effectiveDate,
    date_range_end: envelope.effectiveDate,
    saldo_inicial_minor: "0",
    saldo_final_minor: "0",
    integrity_ok: null,
    rows_total: rows.length,
    status: "parsed",
  };
  const { data: insertedUpload, error: insertErr } = await supabase
    .from("recon_uploads")
    .insert(uploadInsert)
    .select("id")
    .single();
  if (insertErr) {
    if (insertErr.code === "23505") {
      return {
        uploadId: null,
        fileWasDuplicate: true,
        rowsTotal: rows.length,
        rowsNew: 0,
        rowsDuplicate: rows.length,
        approvedRows: 0,
        rejectedRows: 0,
        warnings,
      };
    }
    throw insertErr;
  }
  const uploadId = insertedUpload!.id as string;

  // 2. Build detail-line inserts.
  type AchLineInsert = {
    upload_id: string;
    account_id: string;
    batch_filename: string;
    batch_effective_date: string;
    routing_code: string;
    target_account: string;
    amount_minor: string;
    beneficiary_id: string | null;
    beneficiary_name: string | null;
    addenda: string | null;
    error_code: string | null;
    error_description: string | null;
    observations: string | null;
    row_hash: string;
  };
  let approvedRows = 0;
  let rejectedRows = 0;
  const linesToInsert: AchLineInsert[] = rows.map((r) => {
    if (r.errorCode || r.errorDescription) rejectedRows++;
    else approvedRows++;
    return {
      upload_id: uploadId,
      account_id: accountId,
      batch_filename: envelope.filename,
      batch_effective_date: envelope.effectiveDate,
      routing_code: r.routingCode,
      target_account: r.targetAccount,
      amount_minor: r.amountMinor.toString(),
      beneficiary_id: r.beneficiaryId,
      beneficiary_name: r.beneficiaryName,
      addenda: r.addenda,
      error_code: r.errorCode,
      error_description: r.errorDescription,
      observations: r.observations,
      row_hash: computeBGAchDetailRowHash({
        accountId,
        batchFilename: envelope.filename,
        routingCode: r.routingCode,
        targetAccount: r.targetAccount,
        amountMinor: r.amountMinor,
        beneficiaryId: r.beneficiaryId,
        errorCode: r.errorCode,
      }),
    };
  });

  // 3. Chunked upsert.
  const INSERT_CHUNK = 500;
  let rowsNew = 0;
  for (let i = 0; i < linesToInsert.length; i += INSERT_CHUNK) {
    const chunk = linesToInsert.slice(i, i + INSERT_CHUNK);
    const { data: inserted, error: lineErr } = await supabase
      .from("recon_ach_batch_lines")
      .upsert(chunk, {
        onConflict: "account_id,row_hash",
        ignoreDuplicates: true,
      })
      .select("id");
    if (lineErr) {
      await markUploadFailed(supabase, uploadId, lineErr.message);
      throw lineErr;
    }
    rowsNew += inserted?.length ?? 0;
  }
  const rowsDuplicate = rows.length - rowsNew;

  // 4. Finalize.
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
    approvedRows,
    rejectedRows,
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
