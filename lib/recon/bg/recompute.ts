// Deterministic Account-wide Recompute Engine for Banco General (CCBG v2).
// Reloads all active statement, ACH detail, and Yappy exports from private storage,
// re-runs full cross-file reconciliation, and synchronizes the canonical snapshot to the database.

import type { SupabaseClient } from "@supabase/supabase-js";

import { detectAndParseBgFile } from "./parsers/sniffer";
import { reconcileBancoGeneral } from "./reconcile";
import {
  fetchManualAssignments,
  syncSnapshotToDatabase,
  type SyncSnapshotResult,
} from "./snapshot-sync";
import type {
  BgParsedAchDetail,
  BgParsedStatement,
  BgParsedYappyReport,
  BgReconciliationSnapshot,
} from "./types";

export interface RecomputeBgAccountResult {
  status: "ok" | "empty" | "error";
  message?: string;
  uploadsProcessed: number;
  snapshot: BgReconciliationSnapshot | null;
  syncResult?: SyncSnapshotResult;
}

export async function recomputeBgAccount(
  supabase: SupabaseClient,
  accountId: string,
  options?: {
    storageClient?: SupabaseClient;
    cachedFiles?: Array<{
      filename: string;
      bytes: Uint8Array;
      parsed?: BgParsedStatement | BgParsedAchDetail | BgParsedYappyReport;
    }>;
  },
): Promise<RecomputeBgAccountResult> {
  // 1. Verify account exists on BG rail
  const { data: account, error: accErr } = await supabase
    .from("bank_accounts")
    .select("id, account_number, holder_name, rail")
    .eq("id", accountId)
    .single();

  if (accErr || !account) {
    throw new Error(`Bank account ${accountId} not found`);
  }
  if (account.rail !== "bg") {
    throw new Error(`Bank account ${accountId} is on rail "${account.rail}", expected "bg"`);
  }

  // 2. Fetch all active uploads for this account
  const { data: uploads, error: upErr } = await supabase
    .from("recon_uploads")
    .select("id, original_filename, storage_path, method, date_range_start, date_range_end")
    .eq("account_id", accountId)
    .order("created_at", { ascending: true });

  if (upErr) {
    throw new Error(`Failed to query recon_uploads: ${upErr.message}`);
  }

  // 3. If no active uploads remain, cleanly purge all BG tables and transactions
  if (!uploads || uploads.length === 0) {
    await supabase.from("recon_bg_coverage").delete().eq("account_id", accountId);
    await supabase.from("recon_bg_batches").delete().eq("account_id", accountId);
    await supabase.from("recon_bg_ach_items").delete().eq("account_id", accountId);
    await supabase.from("recon_bg_ach_reversals").delete().eq("account_id", accountId);
    await supabase.from("recon_bg_yappy_batches").delete().eq("account_id", accountId);
    await supabase.from("recon_bg_yappy_lines").delete().eq("account_id", accountId);
    await supabase.from("recon_bg_pending_tasks").delete().eq("account_id", accountId);
    await supabase.from("recon_bg_audit_alerts").delete().eq("account_id", accountId);
    await supabase.from("recon_transactions").delete().eq("account_id", accountId);

    return {
      status: "empty",
      message: "No active uploads remain for this account. Cleared all BG reconciliation data.",
      uploadsProcessed: 0,
      snapshot: null,
    };
  }

  // 4. Download and parse all active uploads
  const statements: BgParsedStatement[] = [];
  const achDetails: BgParsedAchDetail[] = [];
  const yappyReports: BgParsedYappyReport[] = [];

  let adminSupabase = options?.storageClient;
  if (!adminSupabase) {
    const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
    adminSupabase = createSupabaseServiceClient();
  }
  const cachedMap = new Map<
    string,
    {
      bytes: Uint8Array;
      parsed?: BgParsedStatement | BgParsedAchDetail | BgParsedYappyReport;
    }
  >();

  if (options?.cachedFiles) {
    for (const cf of options.cachedFiles) {
      cachedMap.set(cf.filename, cf);
    }
  }

  let processedCount = 0;

  for (const up of uploads) {
    let parsed = cachedMap.get(up.original_filename)?.parsed;

    if (!parsed) {
      let bytes = cachedMap.get(up.original_filename)?.bytes;
      if (!bytes && up.storage_path) {
        const { data: blob, error: dlErr } = await adminSupabase.storage
          .from("recon-statements")
          .download(up.storage_path);
        if (dlErr || !blob) {
          console.warn(`Could not download "${up.storage_path}" from storage:`, dlErr);
          continue;
        }
        bytes = new Uint8Array(await blob.arrayBuffer());
      }

      if (bytes) {
        parsed = detectAndParseBgFile(bytes, up.original_filename) || undefined;
      }
    }

    if (!parsed) continue;
    processedCount++;

    if (parsed.fileType === "statement") {
      statements.push(parsed);
    } else if (parsed.fileType === "ach_detail") {
      achDetails.push(parsed);
    } else if (parsed.fileType === "yappy") {
      yappyReports.push(parsed);
    }
  }

  // 5. Fetch manual operator assignments
  const manualAssignments = await fetchManualAssignments(supabase, accountId);

  // 6. Execute deterministic reconciliation
  const snapshot = reconcileBancoGeneral(statements, achDetails, yappyReports, {
    expectedAccount: account.account_number,
    manualAssignments,
  });

  // 7. Purge existing recon_transactions for this account to guarantee clean state
  await supabase.from("recon_transactions").delete().eq("account_id", accountId);

  // 8. Synchronize fresh snapshot to database
  const syncResult = await syncSnapshotToDatabase(supabase, accountId, snapshot);

  return {
    status: "ok",
    uploadsProcessed: processedCount,
    snapshot,
    syncResult,
  };
}
