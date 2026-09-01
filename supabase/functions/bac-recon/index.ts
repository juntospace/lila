import "@supabase/functions-js/edge-runtime.d.ts";
import * as XLSX from "npm:xlsx@0.18.5";

import { requireAuth, getAdminClient } from "../_shared/auth.ts";
import { parseBACSheet } from "./parser.ts";
import {
  computeFileSha256,
  uploadToStorage,
  removeFromStorage,
} from "../_shared/storage.ts";
import { ingestBACFile, type IngestResult } from "./ingest.ts";
import {
  buildStream,
  reconcile,
  feeChecks,
  feeBatchTable,
  MIN_PREFIX,
  formatDayMonth,
} from "./reconcile.ts";
import { writeReport } from "./report.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export default {
  fetch: async (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    let storagePathToRollback: string | null = null;

    try {
      // 1. Authenticate Request
      const session = await requireAuth(req);

      const url = new URL(req.url);
      const formatParam = url.searchParams.get("format") || "xlsx";
      const minPrefixParam = parseInt(url.searchParams.get("min_prefix") || String(MIN_PREFIX), 10);
      const accountIdParam = url.searchParams.get("account_id");
      const skipRecomputeParam = url.searchParams.get("skip_recompute") === "true";

      const formData = await req.formData();
      const files: { filename: string; content: Uint8Array; file: File }[] = [];
      const accountId = (formData.get("account_id") as string) || accountIdParam || "";

      for (const [_, value] of formData.entries()) {
        if (value instanceof File) {
          const content = new Uint8Array(await value.arrayBuffer());
          files.push({
            filename: value.name,
            content,
            file: value,
          });
        }
      }

      if (files.length === 0) {
        return new Response(
          JSON.stringify({ error: "No se subieron archivos .xls/.xlsx en el multipart/form-data" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Optimized path for JSON ingestion requests
      if (formatParam.toLowerCase() === "json") {
        const adminSupabase = getAdminClient();
        let aggregatedResult: IngestResult | null = null;

        for (const f of files) {
          const workbook = XLSX.read(f.content, { type: "array", cellDates: true });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as any[][];
          const parsed = parseBACSheet(matrix);

          const sha = await computeFileSha256(f.content);
          const ext = f.filename.endsWith(".xls") ? "xls" : "xlsx";
          const storagePath = `${accountId}/${sha}.${ext}`;

          await uploadToStorage(
            storagePath,
            f.content,
            f.file.type || "application/octet-stream"
          ).catch(() => {});

          const res = await ingestBACFile({
            supabase: adminSupabase,
            accountId,
            fileBytes: f.content,
            originalFilename: f.filename,
            uploadedBy: session.userId,
            parseResult: parsed,
            storagePath,
            skipRecompute: skipRecomputeParam,
          });

          if (!aggregatedResult) {
            aggregatedResult = { ...res };
          } else {
            aggregatedResult.rowsTotal += res.rowsTotal;
            aggregatedResult.rowsNew += res.rowsNew;
            aggregatedResult.rowsDuplicate += res.rowsDuplicate;
            if (res.fileWasDuplicate) aggregatedResult.fileWasDuplicate = true;
            aggregatedResult.warnings.push(...res.warnings);
            aggregatedResult.reversalsPaired += res.reversalsPaired;
            aggregatedResult.reversalsUnpaired = res.reversalsUnpaired;
            aggregatedResult.prBatchesPending = res.prBatchesPending;
          }
        }

        return new Response(
          JSON.stringify({ ingestResult: aggregatedResult }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Legacy path for report downloads
      const parsedFiles = files.map((f) => {
        const workbook = XLSX.read(f.content, { type: "array", cellDates: true });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as any[][];
        return {
          filename: f.filename,
          parsed: parseBACSheet(matrix),
        };
      });

      const { stream, issues: streamIssues, chainOk } = buildStream(parsedFiles);
      if (stream.length === 0) {
        throw new Error("Los archivos provistos no contienen movimientos validos");
      }
      const res = reconcile(stream, minPrefixParam, chainOk);
      const issues = [...streamIssues, ...feeChecks(stream)];
      const feeTbl = feeBatchTable(stream, res);

      // 4. Build Alerts
      const alerts: [string, string][] = [];
      res.items.forEach((it: any) => {
        if (it.reject_lag_bd && it.reject_lag_bd > 1) {
          const amt = typeof it.credit === "number" ? it.credit : (it.creditMinor ? Number(it.creditMinor) / 100 : 0);
          alerts.push([
            it.reject?.dateStr ?? it.dateStr,
            `LATE REJECTION (${it.reject_lag_bd} b.d.): ${it.name_raw ?? it.description} $${amt.toFixed(2)} sent ${formatDayMonth(it.dateStr)} - verify if previously reported as confirmed`,
          ]);
        }
      });
      res.rejects.forEach((rj: any) => {
        const amt = typeof rj.debit === "number" ? rj.debit : (rj.debitMinor ? Number(rj.debitMinor) / 100 : 0);
        if (rj.src === "sin-origen") {
          alerts.push([
            rj.dateStr,
            `DA ${rj.ref ?? rj.reference} ${rj.name_raw ?? rj.description} $${amt.toFixed(2)} (${rj.reason ?? rj.returnCode ?? "DA"}): NO MATCHING PR in loaded history`,
          ]);
        } else if (rj.ambiguous) {
          alerts.push([
            rj.dateStr,
            `DA ${rj.ref ?? rj.reference} ${rj.name_raw ?? rj.description} $${amt.toFixed(2)}: different clients share prefix+amount - attributed to most recent; verify`,
          ]);
        }
      });
      feeTbl.forEach((tbl: any) => {
        if (!tbl.total_ok) {
          alerts.push([
            tbl.dateStr,
            `Daily AD fees do not match assigned AM04 - possible incomplete day or uncaptured rejection`,
          ]);
        }
      });
      issues.forEach((msg) => {
        if (res.last_date) {
          alerts.push([res.last_date, "INTEGRITY: " + msg]);
        }
      });

      const reportBytes = writeReport(res, stream, issues, feeTbl);
      return new Response(reportBytes, {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": 'attachment; filename="conciliacion_ach.xlsx"',
        },
      });
    } catch (err: any) {
      console.error("Error in bac-recon Edge Function:", err);

      // Rollback storage if needed
      if (storagePathToRollback) {
        await removeFromStorage(storagePathToRollback);
      }

      return new Response(
        JSON.stringify({ error: err.message || "Internal Server Error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  },
};
