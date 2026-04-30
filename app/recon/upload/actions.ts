"use server";

import { revalidatePath } from "next/cache";
import * as XLSX from "xlsx";
import { z } from "zod";

import { requireReconWriter } from "@/lib/auth/guard";
import {
  BACParseError,
  ingestBACFile,
  parseBACSheet,
  type IngestResult,
} from "@/lib/recon/bac";
import { recomputeAccount } from "@/lib/recon/bac/recompute";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// =============================================================
// createBankAccount
// =============================================================

const AccountSchema = z.object({
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
    rail: "bac",
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

export type UploadActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  result?: IngestResult & { accountLabel?: string };
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

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Pick an Excel file (.xlsx) to upload." };
  }
  if (file.size > 10 * 1024 * 1024) {
    return { status: "error", message: "File is larger than 10 MB." };
  }
  if (file.type && !ALLOWED_MIME.has(file.type)) {
    return {
      status: "error",
      message: `Unsupported file type "${file.type}". Upload a .xlsx export.`,
    };
  }

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

  let matrix: unknown[][];
  try {
    // SheetJS handles both .xlsx (OOXML zip) and .xls (legacy OLE compound
    // document) — BAC's default export is .xls. We pull the first sheet as
    // an array-of-arrays matching the parser's Cell[][] contract.
    const workbook = XLSX.read(fileBytes, { type: "array", cellDates: true });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      return { status: "error", message: "The workbook has no sheets." };
    }
    matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[firstSheetName], {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    });
  } catch (err) {
    return {
      status: "error",
      message: `Could not read the Excel file: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  let parseResult;
  try {
    // The parser tolerates Cell = string | number | Date | null | undefined,
    // which is exactly what read-excel-file/node returns.
    parseResult = parseBACSheet(matrix as never);
  } catch (err) {
    if (err instanceof BACParseError) {
      return { status: "error", message: `Parser: ${err.message}` };
    }
    throw err;
  }

  // Sanity check: the file's account number must match the picked account.
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

  let result: IngestResult;
  try {
    result = await ingestBACFile({
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
      ? "Same file was already ingested — no new rows."
      : `Ingested ${result.rowsNew} new rows.`,
    result: {
      ...result,
      accountLabel: `${account.account_number} · ${account.holder_name}`,
    },
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
 * so any PRs whose linked DA was just deleted (or that were file-clock-
 * confirmed because of this file's posted_at advancing the cutoff) settle
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
    .select("id, account_id, original_filename")
    .eq("id", uploadId)
    .maybeSingle();
  if (lookupErr) return { status: "error", message: lookupErr.message };
  if (!upload) return { status: "error", message: "Upload not found." };

  const accountId = upload.account_id as string;
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

  // 3. Delete the transactions themselves.
  const { error: txnErr } = await supabase
    .from("recon_transactions")
    .delete()
    .eq("upload_id", uploadId);
  if (txnErr) return { status: "error", message: txnErr.message };

  // 4. Delete the upload row.
  const { error: upErr } = await supabase.from("recon_uploads").delete().eq("id", uploadId);
  if (upErr) return { status: "error", message: upErr.message };

  // 5. Recompute the account so PRs whose linked DA just disappeared, or
  //    that were auto-confirmed via file-clock past this file's range,
  //    settle back to the correct state given the remaining data.
  try {
    await recomputeAccount(supabase, accountId);
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
