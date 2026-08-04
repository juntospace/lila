import "@supabase/functions-js/edge-runtime.d.ts";
import * as XLSX from "npm:xlsx@0.18.5";

import { requireAuth } from "./auth.ts";
import { parseBACSheet, type BACParseResult } from "./parser.ts";
import {
  computeFileSha256,
  getAdminClient,
  uploadToStorage,
  removeFromStorage,
} from "./storage.ts";
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

      const primaryFile = files[0];

      // 2. Parse Excel
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

      const adminSupabase = getAdminClient();

      const ingestPromise = (async (): Promise<IngestResult | null> => {
        if (!accountId || files.length === 0) return null;

        let aggregatedResult: IngestResult | null = null;

        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const parsed = parsedFiles[i].parsed;
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

        return aggregatedResult;
      })();

      const reconcilePromise = (async () => {
        const { stream, issues: streamIssues, chainOk } = buildStream(parsedFiles);
        if (stream.length === 0) {
          throw new Error("Los archivos provistos no contienen movimientos validos");
        }
        const res = reconcile(stream, minPrefixParam, chainOk);
        const issues = [...streamIssues, ...feeChecks(stream)];
        const feeTbl = feeBatchTable(stream, res);
        return { stream, res, issues, feeTbl };
      })();

      // Run ingest and reconcile concurrently!
      const [ingestResult, reconData] = await Promise.all([
        ingestPromise,
        reconcilePromise,
      ]);

      const { stream, res, issues, feeTbl } = reconData;

      // 4. Build Alerts
      const alerts: [string, string][] = [];
      res.items.forEach((it: any) => {
        if (it.reject_lag_bd && it.reject_lag_bd > 1) {
          const amt = typeof it.credit === "number" ? it.credit : (it.creditMinor ? Number(it.creditMinor) / 100 : 0);
          alerts.push([
            it.reject?.dateStr ?? it.dateStr,
            `RECHAZO TARDÍO (${it.reject_lag_bd} d.h.): ${it.name_raw ?? it.description} $${amt.toFixed(2)} enviado ${formatDayMonth(it.dateStr)} - verificar si se reportó como confirmado antes`,
          ]);
        }
      });
      res.rejects.forEach((rj: any) => {
        const amt = typeof rj.debit === "number" ? rj.debit : (rj.debitMinor ? Number(rj.debitMinor) / 100 : 0);
        if (rj.src === "sin-origen") {
          alerts.push([
            rj.dateStr,
            `DA ${rj.ref ?? rj.reference} ${rj.name_raw ?? rj.description} $${amt.toFixed(2)} (${rj.reason ?? rj.returnCode ?? "DA"}): SIN ORIGEN en el histórico cargado`,
          ]);
        } else if (rj.ambiguous) {
          alerts.push([
            rj.dateStr,
            `DA ${rj.ref ?? rj.reference} ${rj.name_raw ?? rj.description} $${amt.toFixed(2)}: clientes distintos comparten prefijo+monto - atribución al más reciente; verificar`,
          ]);
        }
      });
      feeTbl.forEach((tbl: any) => {
        if (!tbl.total_ok) {
          alerts.push([
            tbl.dateStr,
            `Comisiones AD del día no cuadran con AM04 asignados - posible día incompleto o rechazo sin capturar`,
          ]);
        }
      });
      issues.forEach((msg) => {
        if (res.last_date) {
          alerts.push([res.last_date, "INTEGRIDAD: " + msg]);
        }
      });

      // 5. Response Formatting
      if (formatParam.toLowerCase() === "json") {
        const dmin =
          res.items.length > 0
            ? res.items.reduce((min: string, i: any) => (i.dateStr < min ? i.dateStr : min), res.items[0].dateStr)
            : null;

        const payload = {
          ingestResult,
          generated_from: files.map((f) => f.filename),
          period: dmin && res.last_date ? [dmin, res.last_date] : [],
          items: res.items.map((i: any) => ({
            date: i.dateStr,
            ref: i.ref,
            name_raw: i.name_raw,
            credit: i.credit,
            status: i.status,
            reject_ref: i.reject ? i.reject.ref : null,
            reject_reason: i.reject ? i.reject.reason : null,
            reject_date: i.reject ? i.reject.dateStr : null,
            reject_lag_bd: i.reject_lag_bd ?? null,
            file: i.file,
          })),
          rejects: res.rejects.map((r: any) => ({
            date: r.dateStr,
            ref: r.ref,
            name_raw: r.name_raw,
            debit: r.debit,
            reason: r.reason,
            src: r.src,
            matched_ref: r.matched !== null && res.items[r.matched] ? res.items[r.matched].ref : null,
            matched_date: r.matched !== null && res.items[r.matched] ? res.items[r.matched].dateStr : null,
            ambiguous: r.ambiguous,
          })),
          incoming: res.incoming.map((r: any) => ({
            date: r.dateStr,
            ref: r.ref,
            channel: r.channel || r.code,
            name_raw: r.name_raw,
            credit: r.credit,
            status: r.status,
          })),
          issues,
          alerts: alerts.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? "")).map(([d, msg]) => [d, msg]),
        };

        return new Response(JSON.stringify(payload), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

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
