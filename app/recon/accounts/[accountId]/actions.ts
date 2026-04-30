"use server";

import { revalidatePath } from "next/cache";

import { requireReconWriter } from "@/lib/auth/guard";
import { parseDvtoDescription } from "@/lib/recon/bac";
import { recomputeAccount, type RecomputeStats } from "@/lib/recon/bac/recompute";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type BackfillResult = {
  status: "ok" | "error";
  scanned: number;
  updated: number;
  message?: string;
};

/**
 * One-shot fix for DA rows whose `return_code` is null because the original
 * parser regex was stricter than real BAC descriptions. Re-runs the (now
 * permissive) parseDvtoDescription against each candidate and writes back
 * any extracted code + payer name. Idempotent: rerun is a no-op once
 * everything is filled in.
 */
export async function backfillDvtoCodes(
  accountId: string,
): Promise<BackfillResult> {
  await requireReconWriter();
  const supabase = await createSupabaseServerClient();

  const { data: candidates, error } = await supabase
    .from("recon_transactions")
    .select("id, description, return_code, payer_name_raw")
    .eq("account_id", accountId)
    .eq("code", "DA")
    .is("return_code", null);

  if (error) return { status: "error", scanned: 0, updated: 0, message: error.message };

  let updated = 0;
  for (const row of candidates ?? []) {
    const desc = (row.description as string | null) ?? "";
    const parsed = parseDvtoDescription(desc);
    if (!parsed.returnCode) continue;
    const { error: upErr } = await supabase
      .from("recon_transactions")
      .update({
        return_code: parsed.returnCode,
        payer_name_raw: row.payer_name_raw ?? parsed.payerNameRaw ?? null,
      })
      .eq("id", row.id);
    if (!upErr) updated++;
  }

  revalidatePath(`/recon/accounts/${accountId}`);
  return { status: "ok", scanned: candidates?.length ?? 0, updated };
}

// =============================================================
// recomputeAccountAction
// =============================================================

export type RecomputeActionResult = {
  status: "ok" | "error";
  message?: string;
  stats?: RecomputeStats;
};

/**
 * Pair every unpaired DA in the account and re-evaluate PR/DA states
 * against link presence + file-clock cutoff. Idempotent. Use to heal bad
 * state from earlier ingests that hit the upsert-response 1000-row cap.
 */
export async function recomputeAccountAction(
  accountId: string,
): Promise<RecomputeActionResult> {
  const session = await requireReconWriter();
  const supabase = await createSupabaseServerClient();

  try {
    const stats = await recomputeAccount(supabase, accountId, session.userId);
    revalidatePath(`/recon/accounts/${accountId}`);
    return { status: "ok", stats };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
