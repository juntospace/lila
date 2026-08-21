"use server";

import { revalidatePath } from "next/cache";
import * as XLSX from "xlsx";
import { z } from "zod";

import { requireReconWriter } from "@/lib/auth/guard";
import { type IngestResult } from "@/lib/recon/bac";
import { recomputeAccount } from "@/lib/recon/bac/recompute";
import {
  BGParseError,
  ingestBGAchDetailFile,
  ingestBGStatementFile,
  isBGAchDetailSheet,
  isBGStatementSheet,
  parseBGAchDetail,
  parseBGStatement,
  type BGAchDetailIngestResult,
  type BGStatementIngestResult,
} from "@/lib/recon/bg";
import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";

// =============================================================
// createBankAccount
// =============================================================

const AccountSchema = z.object({
  rail: z.enum(["bac", "bg"]),
  account_number: z
    .string()
    .trim()
    .min(3, "Account number is too short")
    .max(40, "Account number is too long"),
  holder_name: z
    .string()
    .trim()
    .min(2, "Holder name is required")
    .max(160, "Holder name is too long"),
  currency: z.enum(["USD"]),
});

export type AccountActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Partial<Record<keyof z.infer<typeof AccountSchema>, string>>;
};

export async function createBankAccount(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  await requireReconWriter();

  const parsed = AccountSchema.safeParse({
    rail: formData.get("rail") ?? "bac",
    account_number: formData.get("account_number"),
    holder_name: formData.get("holder_name"),
    currency: formData.get("currency") ?? "USD",
  });

  if (!parsed.success) {
    const fieldErrors: AccountActionState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof z.infer<typeof AccountSchema>;
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { status: "error", message: "Please fix the errors below.", fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("bank_accounts").insert({
    rail: parsed.data.rail,
    account_number: parsed.data.account_number,
    holder_name: parsed.data.holder_name,
    currency: parsed.data.currency,
  });

  if (error) {
    if (error.code === "23505") {
      return {
        status: "error",
        message: "An account with that number already exists on this rail.",
      };
    }
    return { status: "error", message: "Could not create account. Try again." };
  }

  revalidatePath("/recon/upload");
  return { status: "success", message: "Account added." };
}

// =============================================================
// uploadStatement
// =============================================================

const UploadSchema = z.object({
  account_id: z.string().uuid("Pick an account."),
});

export type BACIngestSurface = IngestResult & {
  rail: "bac";
  accountLabel?: string;
};

export type BGStatementIngestSurface = BGStatementIngestResult & {
  rail: "bg";
  fileKind: "statement";
  accountLabel?: string;
};

export type BGAchDetailIngestSurface = BGAchDetailIngestResult & {
  rail: "bg";
  fileKind: "ach_detail";
  accountLabel?: string;
};

export type UploadResultSurface =
  | BACIngestSurface
  | BGStatementIngestSurface
  | BGAchDetailIngestSurface;

export type UploadActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  result?: UploadResultSurface;
};

const ALLOWED_MIME = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls (BAC's default export)
  "application/octet-stream", // some browsers omit MIME
]);

export async function uploadStatement(
  _prev: UploadActionState,
  formData: FormData,
): Promise<UploadActionState> {
  const session = await requireReconWriter();

  const parsed = UploadSchema.safeParse({
    account_id: formData.get("account_id"),
  });
  if (!parsed.success) {
    return { status: "error", message: "Pick an account before uploading." };
  }

  const rawFiles = formData.getAll("file").concat(formData.getAll("files"));
  const files = rawFiles.filter(
    (f): f is File => f instanceof File && f.size > 0
  );

  if (files.length === 0) {
    return { status: "error", message: "Pick at least one Excel file (.xlsx / .xls) to upload." };
  }

  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) {
      return { status: "error", message: `File "${f.name}" is larger than 10 MB.` };
    }
    if (f.type && !ALLOWED_MIME.has(f.type)) {
      return {
        status: "error",
        message: `Unsupported file type "${f.type}" in "${f.name}". Upload .xlsx exports.`,
      };
    }
  }

  const file = files[0];

  const supabase = await createSupabaseServerClient();

  const { data: account, error: acctErr } = await supabase
    .from("bank_accounts")
    .select("id, account_number, holder_name, rail, currency")
    .eq("id", parsed.data.account_id)
    .single();

  if (acctErr || !account) {
    return { status: "error", message: "Account not found or access denied." };
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const accountLabel = `${account.account_number} · ${account.holder_name}`;

  // ----- BG rail --------------------------------------------------------
  if (account.rail === "bg") {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBytes, { type: "array", cellDates: true });
    } catch (err) {
      return {
        status: "error",
        message: `Could not read the Excel file: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      return { status: "error", message: "The workbook has no sheets." };
    }

    if (isBGAchDetailSheet(workbook)) {
      const name = workbook.SheetNames.find((n) =>
        /BGPACHRejectedDetailList/i.test(n),
      )!;
      let parseResult;
      try {
        parseResult = parseBGAchDetail(workbook.Sheets[name]);
      } catch (err) {
        if (err instanceof BGParseError) {
          return { status: "error", message: `BG ACH detail: ${err.message}` };
        }
        throw err;
      }
      let result: BGAchDetailIngestResult;
      try {
        result = await ingestBGAchDetailFile({
          supabase,
          accountId: account.id,
          fileBytes,
          originalFilename: file.name,
          uploadedBy: session.userId,
          parseResult,
        });
      } catch (err) {
        return {
          status: "error",
          message: `Ingest failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      revalidatePath("/recon/upload");
      revalidatePath(`/recon/accounts/${account.id}`);
      return {
        status: "success",
        message: result.fileWasDuplicate
          ? "Same ACH detail file was already ingested — no new rows."
          : `Ingested ${result.rowsNew} ACH detail row${result.rowsNew === 1 ? "" : "s"}.`,
        result: { ...result, rail: "bg", fileKind: "ach_detail", accountLabel },
      };
    }
    if (isBGStatementSheet(workbook)) {
      const name = workbook.SheetNames.find((n) =>
        /BGPCheckingMovementsExcel/i.test(n),
      )!;
      let parseResult;
      try {
        parseResult = parseBGStatement(workbook.Sheets[name]);
      } catch (err) {
        if (err instanceof BGParseError) {
          return { status: "error", message: `BG statement: ${err.message}` };
        }
        throw err;
      }
      // Sanity: file must match the selected account number. BG numbers
      // carry dashes; compare digits-only.
      if (
        parseResult.header.accountNumber &&
        parseResult.header.accountNumber.replace(/\D/g, "") !==
          account.account_number.replace(/\D/g, "")
      ) {
        return {
          status: "error",
          message: `File is for account ${parseResult.header.accountNumber}, but you picked ${account.account_number}.`,
        };
      }
      let result: BGStatementIngestResult;
      try {
        result = await ingestBGStatementFile({
          supabase,
          accountId: account.id,
          fileBytes,
          originalFilename: file.name,
          uploadedBy: session.userId,
          parseResult,
        });
      } catch (err) {
        return {
          status: "error",
          message: `Ingest failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      revalidatePath("/recon/upload");
      revalidatePath(`/recon/accounts/${account.id}`);
      return {
        status: "success",
        message: result.fileWasDuplicate
          ? "Same statement was already ingested — no new rows."
          : `Ingested ${result.rowsNew} new statement row${result.rowsNew === 1 ? "" : "s"}.`,
        result: { ...result, rail: "bg", fileKind: "statement", accountLabel },
      };
    }
    return {
      status: "error",
      message:
        "Unrecognized BG file. Expected a Movimientos statement or a Detalle ACH detail file.",
    };
  }

  interface BacEdgeResponse {
    ingestResult?: IngestResult;
    items?: unknown[];
    issues?: string[];
    error?: string;
  }
  let edgeData: BacEdgeResponse | null = null;
  try {
    const edgeFormData = new FormData();
    for (const f of files) {
      const b = new Uint8Array(await f.arrayBuffer());
      const edgeFile = new File([b], f.name, {
        type: f.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      edgeFormData.append("file", edgeFile);
    }
    edgeFormData.append("account_id", account.id);

    const { publicEnv, serverEnv } = await import("@/lib/env");
    const serviceKey = serverEnv().SUPABASE_SERVICE_ROLE_KEY;
    const fnUrl = `${publicEnv.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/bac-recon?format=json&account_id=${account.id}`;

    const response = await fetch(fnUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        "x-user-id": session.userId,
      },
      body: edgeFormData,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Edge Function bac-recon returned HTTP ${response.status}: ${text}`);
    }

    edgeData = (await response.json()) as BacEdgeResponse;
    if (edgeData && typeof edgeData === "object" && "error" in edgeData && edgeData.error) {
      throw new Error(`Edge Function bac-recon error: ${edgeData.error}`);
    }
  } catch (err: unknown) {
    let errorMessage = "An unknown error occurred.";
    if (err instanceof Error) {
      errorMessage = err.message;
    } else if (err && typeof err === "object") {
      if ("message" in err && typeof err.message === "string") {
        errorMessage = err.message;
      } else if ("error_description" in err && typeof err.error_description === "string") {
        errorMessage = err.error_description;
      } else {
        try {
          errorMessage = JSON.stringify(err);
        } catch {
          errorMessage = String(err);
        }
      }
    } else if (typeof err === "string") {
      errorMessage = err;
    }

    return {
      status: "error",
      message: `Ingest failed: ${errorMessage}`,
    };
  }

  const result: IngestResult = edgeData?.ingestResult || {
    uploadId: null,
    fileWasDuplicate: false,
    rowsTotal: edgeData?.items?.length || 0,
    rowsNew: edgeData?.items?.length || 0,
    rowsDuplicate: 0,
    dateRangeAdded: null,
    dateRangeOverlap: null,
    prsConfirmedThisRun: 0,
    reversalsPaired: 0,
    reversalsUnpaired: 0,
    prBatchesPending: 0,
    warnings: edgeData?.issues || [],
  };

  if (!result.fileWasDuplicate && result.rowsNew > 0) {
    try {
      const { data: edgeRecompute, error: recomputeErr } =
        await supabase.functions.invoke("bac-recon-recompute", {
          body: { account_id: account.id },
        });

      let recomputeStats = edgeRecompute?.stats;

      if (recomputeErr || !recomputeStats) {
        console.warn("Edge Function bac-recon-recompute failed, running direct fallback:", recomputeErr);
        const { recomputeAccount } = await import("@/lib/recon/bac/recompute");
        recomputeStats = await recomputeAccount(supabase, account.id, session.userId);
      }

      if (recomputeStats) {
        result.prsConfirmedThisRun = recomputeStats.prsConfirmed;
        result.reversalsPaired = recomputeStats.reversalsPaired;
        result.reversalsUnpaired = recomputeStats.reversalsUnpaired;
        result.prBatchesPending = recomputeStats.prBatchesPending;
      }
    } catch (e) {
      console.error("Recompute post-ingest error:", e);
    }
  }

  revalidatePath("/recon/upload");
  revalidatePath(`/recon/accounts/${account.id}`);
  return {
    status: "success",
    message: result.fileWasDuplicate
      ? "Same file was already ingested — no new rows."
      : `Ingested ${result.rowsNew} new rows.`,
    result: { ...result, rail: "bac", accountLabel },
  };
}

// =============================================================
// deleteUpload
// =============================================================

export type DeleteUploadResult = {
  status: "ok" | "error";
  message?: string;
  rowsDeleted?: number;
  linksDeleted?: number;
};

/**
 * Wipe an upload's transactions + links, then run a full account recompute
 * so any PRs whose linked DA was just deleted (or that were auto-confirmed
 * because their batch was consumed by a DA batch in this file) settle
 * back to the correct state.
 *
 * Use cases: a file was manipulated before upload, an ingest finished in a
 * bad state, or ops want to re-run with newer code.
 */
export async function deleteUpload(uploadId: string): Promise<DeleteUploadResult> {
  await requireReconWriter();
  const supabase = await createSupabaseServerClient();

  const { data: upload, error: lookupErr } = await supabase
    .from("recon_uploads")
    .select("id, account_id, original_filename, storage_path")
    .eq("id", uploadId)
    .maybeSingle();
  if (lookupErr) return { status: "error", message: lookupErr.message };
  if (!upload) return { status: "error", message: "Upload not found." };

  const accountId = upload.account_id as string;
  const storagePath = upload.storage_path as string | null;
  const ID_CHUNK = 200;
  const PAGE = 1000;

  // 1. Collect every transaction id from this upload (paginated).
  const txnIds: string[] = [];
  let cursor = 0;
  while (cursor < 200_000) {
    const { data, error } = await supabase
      .from("recon_transactions")
      .select("id")
      .eq("upload_id", uploadId)
      .order("id", { ascending: true })
      .range(cursor, cursor + PAGE - 1);
    if (error) return { status: "error", message: error.message };
    if (!data || data.length === 0) break;
    for (const r of data) txnIds.push(r.id as string);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }

  // 2. Delete recon_links referencing any of these txn ids (chunked, both
  //    sides — a link can have its PR or its DA in this upload).
  let linksDeleted = 0;
  for (const side of ["pr_txn_id", "da_txn_id"] as const) {
    for (let i = 0; i < txnIds.length; i += ID_CHUNK) {
      const chunk = txnIds.slice(i, i + ID_CHUNK);
      const { data: deleted, error } = await supabase
        .from("recon_links")
        .delete()
        .in(side, chunk)
        .select("pr_txn_id");
      if (error) return { status: "error", message: error.message };
      linksDeleted += deleted?.length ?? 0;
    }
  }

  // 3. Delete the transactions themselves. recon_manual_actions.txn_id
  //    cascades on delete (migration 20260503100000), so audit rows for
  //    the deleted transactions disappear with them — no separate step
  //    needed and no API-level DELETE policy required on the audit
  //    table (it stays append-only through PostgREST).
  const { error: txnErr } = await supabase
    .from("recon_transactions")
    .delete()
    .eq("upload_id", uploadId);
  if (txnErr) return { status: "error", message: txnErr.message };

  // 4. Delete the upload row & storage file.
  const { error: upErr } = await supabase.from("recon_uploads").delete().eq("id", uploadId);
  if (upErr) return { status: "error", message: upErr.message };

  if (storagePath) {
    const adminSupabase = createSupabaseServiceClient();
    await adminSupabase.storage.from("recon-statements").remove([storagePath]).catch(() => {
      // Ignorar error si el archivo ya no existía en el bucket
    });
  }

  // 5. Recompute the account so PRs whose linked DA just disappeared, or
  //    whose batch was consumed by a now-deleted DA batch, settle back to
  //    the correct state given the remaining data.
  try {
    const { data, error } = await supabase.functions.invoke("bac-recon-recompute", {
      body: { account_id: accountId },
    });
    if (error || data?.error) {
      await recomputeAccount(supabase, accountId);
    }
  } catch (err) {
    return {
      status: "error",
      message: `Deletion completed but recompute failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  revalidatePath("/recon/upload");
  revalidatePath(`/recon/accounts/${accountId}`);
  return { status: "ok", rowsDeleted: txnIds.length, linksDeleted };
}
