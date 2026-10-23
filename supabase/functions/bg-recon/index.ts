import "@supabase/functions-js/edge-runtime.d.ts";

import { requireAuth, getAdminClient } from "../_shared/auth.ts";
import { computeFileSha256, uploadToStorage } from "../_shared/storage.ts";
import {
  detectAndParseBgFile,
  serializeBgParsedFile,
  BG_PARSER_VERSION,
} from "./parsers/sniffer.ts";
import { recomputeBgAccount } from "./recompute.ts";
import { toCanonicalJsonContract } from "./formatters.ts";
import type {
  BgParsedAchDetail,
  BgParsedStatement,
  BgParsedYappyReport,
} from "./types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export default {
  fetch: async (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    try {
      // 1. Authenticate Request
      const session = await requireAuth(req);
      const url = new URL(req.url);
      const accountIdParam = url.searchParams.get("account_id");
      const isRecomputeParam = url.searchParams.get("recompute") === "true";
      const skipRecomputeParam = url.searchParams.get("skip_recompute") === "true";

      const adminSupabase = getAdminClient();

      let accountId = accountIdParam || "";
      let skipRecompute = skipRecomputeParam;
      const parsedFilesSummary: Array<{
        filename: string;
        fileType: string;
        rowsCount: number;
        isDuplicate: boolean;
      }> = [];
      const newCachedFiles: Array<{
        filename: string;
        bytes: Uint8Array;
        parsed?: BgParsedStatement | BgParsedAchDetail | BgParsedYappyReport;
      }> = [];
      const warnings: string[] = [];

      const contentType = req.headers.get("content-type") || "";

      if (contentType.includes("multipart/form-data")) {
        const formData = await req.formData();
        accountId = (formData.get("account_id") as string) || accountId;
        if (formData.get("skip_recompute") === "true") {
          skipRecompute = true;
        }

        for (const [_, value] of formData.entries()) {
          if (value instanceof File) {
            const buf = new Uint8Array(await value.arrayBuffer());
            const sha = await computeFileSha256(buf);

            // 1. Duplicate detection
            const { data: existingUpload } = await adminSupabase
              .from("recon_uploads")
              .select("id")
              .eq("account_id", accountId)
              .eq("file_sha256", sha)
              .maybeSingle();

            if (existingUpload) {
              parsedFilesSummary.push({
                filename: value.name,
                fileType: "unknown",
                rowsCount: 0,
                isDuplicate: true,
              });
              continue;
            }

            // 2. Parse file with sniffer
            const parsed = detectAndParseBgFile(buf, value.name);
            if (!parsed) {
              warnings.push(`File "${value.name}" was not recognized as a Banco General statement, ACH detail, or Yappy report.`);
              continue;
            }

            const ext = value.name.endsWith(".xls") ? "xls" : value.name.endsWith(".pdf") ? "pdf" : "xlsx";
            const storagePath = `${accountId}/${sha}.${ext}`;

            // 3. Save raw file in Supabase Storage
            await uploadToStorage(storagePath, buf, value.type || "application/octet-stream");

            let uploadMethod: "statement_bg_excel" | "ach_detail_bg_excel" | "yappy_bg_excel" = "statement_bg_excel";
            let startDate: string | null = null;
            let endDate: string | null = null;
            const rowsCount = parsed.rows.length;

            if (parsed.fileType === "statement") {
              uploadMethod = "statement_bg_excel";
              startDate = parsed.startDate || null;
              endDate = parsed.endDate || null;
            } else if (parsed.fileType === "ach_detail") {
              uploadMethod = "ach_detail_bg_excel";
              startDate = parsed.effectiveDate || parsed.batchDate || null;
              endDate = startDate;
            } else if (parsed.fileType === "yappy") {
              uploadMethod = "yappy_bg_excel";
              if (parsed.rows.length > 0) {
                const sortedDates = parsed.rows.map((r) => r.date).filter(Boolean).sort();
                startDate = sortedDates[0] || null;
                endDate = sortedDates[sortedDates.length - 1] || null;
              }
            }

            // 4. Record in recon_uploads table
            await adminSupabase.from("recon_uploads").insert({
              account_id: accountId,
              original_filename: value.name,
              file_sha256: sha,
              uploaded_by: session.userId,
              storage_path: storagePath,
              method: uploadMethod,
              rows_total: rowsCount,
              rows_new: rowsCount,
              rows_duplicate: 0,
              date_range_start: startDate,
              date_range_end: endDate,
              status: "committed",
              parsed_payload: serializeBgParsedFile(parsed),
              parser_version: BG_PARSER_VERSION,
            });

            parsedFilesSummary.push({
              filename: value.name,
              fileType: parsed.fileType,
              rowsCount,
              isDuplicate: false,
            });

            newCachedFiles.push({
              filename: value.name,
              bytes: buf,
              parsed,
            });
          }
        }
      } else if (contentType.includes("application/json")) {
        const body = await req.json().catch(() => ({}));
        accountId = body.account_id || accountId;
        if (body.skip_recompute != null) {
          skipRecompute = Boolean(body.skip_recompute);
        }
      }

      if (!accountId) {
        return new Response(
          JSON.stringify({ error: "account_id is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Verify account belongs to 'bg' rail
      const { data: account, error: accError } = await adminSupabase
        .from("bank_accounts")
        .select("id, account_number, holder_name, rail")
        .eq("id", accountId)
        .single();

      if (accError || !account) {
        return new Response(
          JSON.stringify({ error: `Bank account ${accountId} not found` }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (account.rail !== "bg") {
        return new Response(
          JSON.stringify({ error: `Bank account ${accountId} rail is "${account.rail}", expected "bg"` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // If purely uploading and skip_recompute requested, return upload summary without full recompute
      if (skipRecompute && !isRecomputeParam) {
        return new Response(
          JSON.stringify({
            status: "ok",
            user_id: session.userId,
            account_id: accountId,
            files_processed: parsedFilesSummary,
            warnings,
            recompute_skipped: true,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Execute full recompute across all active files for this account
      const recomputeResult = await recomputeBgAccount(adminSupabase, accountId, {
        cachedFiles: newCachedFiles.length > 0 ? newCachedFiles : undefined,
      });

      const canonicalContract = recomputeResult.snapshot
        ? toCanonicalJsonContract(recomputeResult.snapshot)
        : null;

      return new Response(
        JSON.stringify({
          status: "ok",
          user_id: session.userId,
          account_id: accountId,
          files_processed: parsedFilesSummary,
          warnings,
          recompute: recomputeResult,
          contract: canonicalContract,
          controls: recomputeResult.snapshot?.controls ?? null,
          alerts_count: recomputeResult.snapshot?.alerts.length ?? 0,
          pending_tasks_count: recomputeResult.snapshot?.pendingTasks.length ?? 0,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    } catch (err: any) {
      console.error("Error in bg-recon Edge Function:", err);
      return new Response(
        JSON.stringify({ error: err.message || "Internal server error in bg-recon" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  },
};
