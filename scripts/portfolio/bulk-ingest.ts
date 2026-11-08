/**
 * Bulk Ingestion CLI for LoanDisk Historical Backups (.zip & CSV folders)
 *
 * Scans a folder containing multiple dated .zip files or CSV folders,
 * sorts them chronologically, and ingests them idempotently and resumably
 * into Supabase (defaults to linked remote Supabase project unless --local is passed).
 *
 * Features:
 * - Resumable: Skips snapshots already marked as 'completed' in Supabase (unless --force).
 *   If any file fails, completed snapshots are NEVER deleted; re-running continues where it left off.
 * - Zero System Impact: Parses .zip files in-memory one by one without disk bloat,
 *   omits redundant raw CSV JSONB payloads, precomputes lastRealPaymentMap per snapshot,
 *   stores cumulative repayment rows on the latest snapshot, and pre-warms Board cache.
 *
 * Usage:
 *   npx tsx scripts/portfolio/bulk-ingest.ts <directory-path> [--entity=crediclaro] [--remote|--local] [--force]
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadBoardDataset } from "../../lib/portfolio/board";
import { enrichRepayments } from "../../lib/portfolio/enrich";
import { ingestSnapshot } from "../../lib/portfolio/ingest";
import {
  extractDateFromName,
  parseCsv,
  parsePortfolioZip,
} from "../../lib/portfolio/parser";
import { loadActivePolicy } from "../../lib/portfolio/policy";

// 1. Load environment variables from .env.local / .env
function loadEnv() {
  const envPaths = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), ".env"),
  ];
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed
            .slice(eqIdx + 1)
            .trim()
            .replace(/^["']|["']$/g, "");
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  }
}

loadEnv();

interface SupabaseConnectionConfig {
  url: string;
  serviceRoleKey: string;
  isRemote: boolean;
  projectRef?: string;
}

function resolveSupabaseConnection(
  preferLocal: boolean,
): SupabaseConnectionConfig {
  if (preferLocal) {
    const url =
      process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    if (!key) {
      throw new Error(
        "SUPABASE_SERVICE_ROLE_KEY no está definido para conexión local.",
      );
    }
    return { url, serviceRoleKey: key, isRemote: false };
  }

  // Check if explicit remote env vars are provided
  if (
    process.env.SUPABASE_REMOTE_URL &&
    process.env.SUPABASE_REMOTE_SERVICE_ROLE_KEY
  ) {
    return {
      url: process.env.SUPABASE_REMOTE_URL,
      serviceRoleKey: process.env.SUPABASE_REMOTE_SERVICE_ROLE_KEY,
      isRemote: true,
    };
  }

  // Check linked project in supabase/.temp/linked-project.json or project-ref
  let projectRef = process.env.SUPABASE_PROJECT_REF || "";
  const linkedJsonPath = path.resolve(
    process.cwd(),
    "supabase/.temp/linked-project.json",
  );
  const projectRefPath = path.resolve(
    process.cwd(),
    "supabase/.temp/project-ref",
  );

  if (!projectRef && fs.existsSync(linkedJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(linkedJsonPath, "utf-8")) as {
        ref?: string;
      };
      if (parsed.ref) projectRef = parsed.ref.trim();
    } catch {
      // ignore
    }
  }
  if (!projectRef && fs.existsSync(projectRefPath)) {
    projectRef = fs.readFileSync(projectRefPath, "utf-8").trim();
  }

  if (projectRef) {
    const remoteUrl = `https://${projectRef}.supabase.co`;
    if (
      process.env.NEXT_PUBLIC_SUPABASE_URL === remoteUrl &&
      process.env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      return {
        url: remoteUrl,
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        isRemote: true,
        projectRef,
      };
    }

    console.log(
      `🔗 Detectado proyecto Supabase remoto vinculado: ${projectRef}. Obteniendo API key via Supabase CLI...`,
    );
    try {
      const out = execSync(
        `npx supabase projects api-keys --project-ref ${projectRef} -o json`,
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const jsonStart = out.indexOf("{");
      const jsonStr = jsonStart >= 0 ? out.slice(jsonStart) : out;
      const parsed = JSON.parse(jsonStr) as {
        keys?: { id?: string; name?: string; api_key?: string }[];
      };
      const serviceKeyObj = parsed.keys?.find(
        (k) =>
          (k.id === "service_role" || k.name === "service_role") &&
          k.api_key &&
          !k.api_key.includes("····"),
      );
      if (serviceKeyObj?.api_key) {
        return {
          url: remoteUrl,
          serviceRoleKey: serviceKeyObj.api_key,
          isRemote: true,
          projectRef,
        };
      }
    } catch (err) {
      console.warn(
        "⚠️ No se pudo obtener la API key con -o json, intentando formato estándar...",
        err instanceof Error ? err.message : err,
      );
      try {
        const out = execSync(
          `npx supabase projects api-keys --project-ref ${projectRef}`,
          { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
        );
        const match = out.match(
          /"api_key"\s*:\s*"(eyJ[^"]+)"\s*,\s*"id"\s*:\s*"service_role"/,
        );
        if (match?.[1]) {
          return {
            url: remoteUrl,
            serviceRoleKey: match[1],
            isRemote: true,
            projectRef,
          };
        }
      } catch {
        // fallback below
      }
    }
  }

  // Fallback to .env.local
  const fallbackUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
  const fallbackKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!fallbackKey) {
    throw new Error(
      "No se pudo resolver SUPABASE_SERVICE_ROLE_KEY ni proyecto remoto vinculado.",
    );
  }
  return {
    url: fallbackUrl,
    serviceRoleKey: fallbackKey,
    isRemote: !fallbackUrl.includes("127.0.0.1") && !fallbackUrl.includes("localhost"),
  };
}

interface BatchItem {
  date: string;
  zipFile?: string;
  loansFile?: string;
  repaymentsFile?: string;
  sourceDir: string;
}

/**
 * Scans directory for .zip backups or CSV folders without extracting .zip files to disk.
 */
function findBatchesInDir(dirPath: string): BatchItem[] {
  const batches: Map<string, BatchItem> = new Map();

  function scan(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    let loansPath: string | null = null;
    let repsPath: string | null = null;

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
        const date = extractDateFromName(entry.name);
        if (date && !batches.has(date)) {
          batches.set(date, {
            date,
            zipFile: fullPath,
            sourceDir: currentDir,
          });
        }
      } else if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".csv")) {
        const lower = entry.name.toLowerCase();
        if (
          lower.includes("loans") &&
          !lower.includes("repayments") &&
          !lower.includes("borrowers")
        ) {
          loansPath = fullPath;
        } else if (lower.includes("repayments")) {
          repsPath = fullPath;
        }
      }
    }

    if (loansPath) {
      const date =
        extractDateFromName(loansPath) ||
        (repsPath ? extractDateFromName(repsPath) : null) ||
        extractDateFromName(currentDir);

      if (date && !batches.has(date)) {
        batches.set(date, {
          date,
          loansFile: loansPath,
          repaymentsFile: repsPath || undefined,
          sourceDir: currentDir,
        });
      }
    }
  }

  scan(dirPath);
  return Array.from(batches.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backfillExistingSnapshotMetadata(
  supabase: SupabaseClient,
  snap: {
    id: string;
    snapshot_date: string;
    has_repayments: boolean;
    source_files: Record<string, unknown> | null;
  },
  batchItem: BatchItem,
  policy: Awaited<ReturnType<typeof loadActivePolicy>>,
) {
  const sourceFiles = snap.source_files ?? {};
  const hasMap =
    sourceFiles.lastRealPaymentMap &&
    typeof sourceFiles.lastRealPaymentMap === "object";

  if (snap.has_repayments && hasMap) {
    return;
  }

  // Parse zip or CSV to extract lastRealPaymentMap without re-inserting loans
  let repaymentsRaw: Record<string, string>[] = [];
  let hasRepaymentsFile = false;

  if (batchItem.zipFile) {
    const buf = fs.readFileSync(batchItem.zipFile);
    const parsed = await parsePortfolioZip(
      buf,
      path.basename(batchItem.zipFile),
    );
    repaymentsRaw = parsed.repaymentsRaw;
    hasRepaymentsFile = parsed.hasRepaymentsFile;
  } else if (batchItem.repaymentsFile && fs.existsSync(batchItem.repaymentsFile)) {
    const repsCsv = fs.readFileSync(batchItem.repaymentsFile, "utf-8");
    repaymentsRaw = parseCsv(repsCsv);
    hasRepaymentsFile = true;
  }

  if (!hasRepaymentsFile) return;

  const { repayments: enrichedRepayments } = enrichRepayments(
    repaymentsRaw,
    snap.snapshot_date,
    policy,
  );
  const lastRealPaymentMap: Record<string, string> = {};
  for (const rep of enrichedRepayments) {
    if (rep.isReal && rep.loanId && rep.collectionDate) {
      const prev = lastRealPaymentMap[rep.loanId];
      if (!prev || rep.collectionDate > prev) {
        lastRealPaymentMap[rep.loanId] = rep.collectionDate;
      }
    }
  }

  await supabase
    .from("portfolio_snapshots")
    .update({
      has_repayments: true,
      source_files: {
        ...sourceFiles,
        hasRepaymentsFile: true,
        lastRealPaymentMap,
      },
    })
    .eq("id", snap.id);
}

async function run() {
  const args = process.argv.slice(2);
  const targetDir = args.find((a) => !a.startsWith("--"));
  const entityCode =
    args.find((a) => a.startsWith("--entity="))?.split("=")[1] || "crediclaro";
  const forceReingest = args.includes("--force");
  const preferLocal = args.includes("--local");
  const throttleMs = Number(
    args.find((a) => a.startsWith("--throttle-ms="))?.split("=")[1] ?? 150,
  );

  if (!targetDir) {
    console.log(`
Uso:
  npx tsx scripts/portfolio/bulk-ingest.ts <directorio-de-backups> [--entity=crediclaro] [--remote|--local] [--force]

Ejemplo:
  npx tsx scripts/portfolio/bulk-ingest.ts /home/carluis/Downloads/drive-download-20261028T210032Z-1-001
`);
    process.exit(1);
  }

  const resolvedDir = path.resolve(process.cwd(), targetDir);
  if (!fs.existsSync(resolvedDir)) {
    console.error(`❌ El directorio no existe: ${resolvedDir}`);
    process.exit(1);
  }

  const conn = resolveSupabaseConnection(preferLocal);
  console.log(
    `\n🌐 Conectando a Supabase (${conn.isRemote ? `REMOTO: ${conn.url}` : `LOCAL: ${conn.url}`})...`,
  );

  const supabase = createClient(conn.url, conn.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Resolve entity
  const { data: entity, error: entityErr } = await supabase
    .from("portfolio_entities")
    .select("id, code, display_name")
    .eq("code", entityCode)
    .maybeSingle();

  if (entityErr || !entity) {
    console.error(
      `❌ Entidad '${entityCode}' no encontrada en portfolio_entities:`,
      entityErr?.message,
    );
    process.exit(1);
  }

  console.log(`\n🔍 Escaneando respaldos de LoanDisk en: ${resolvedDir}`);
  const batches = findBatchesInDir(resolvedDir);

  if (batches.length === 0) {
    console.log(
      "⚠️ No se encontraron archivos .zip ni CSVs de préstamos (*loans*.csv) con fecha en la carpeta.",
    );
    process.exit(0);
  }

  const maxBatchDate = batches[batches.length - 1].date;
  console.log(
    `✓ Se encontraron ${batches.length} archivo(s)/lote(s) desde ${batches[0].date} hasta ${maxBatchDate}.`,
  );

  // Query already-completed snapshots in Supabase so we can resume where it left off
  const { data: existingSnapshots, error: snapQueryErr } = await supabase
    .from("portfolio_snapshots")
    .select("id, snapshot_date, status, has_repayments, source_files")
    .eq("entity_id", entity.id)
    .order("snapshot_date", { ascending: true });

  if (snapQueryErr) {
    console.error(
      "❌ Error al consultar snapshots existentes en Supabase:",
      snapQueryErr.message,
    );
    process.exit(1);
  }

  const completedMap = new Map<
    string,
    {
      id: string;
      snapshot_date: string;
      has_repayments: boolean;
      source_files: Record<string, unknown> | null;
    }
  >();

  for (const s of existingSnapshots || []) {
    if (s.status === "completed") {
      completedMap.set(s.snapshot_date as string, {
        id: s.id as string,
        snapshot_date: s.snapshot_date as string,
        has_repayments: Boolean(s.has_repayments),
        source_files: (s.source_files as Record<string, unknown> | null) ?? null,
      });
    }
  }

  // Check if the latest snapshot already has rows in portfolio_loan_repayments
  let latestSnapHasRepaymentRows = false;
  const latestExisting = completedMap.get(maxBatchDate);
  if (latestExisting && !forceReingest) {
    const { count } = await supabase
      .from("portfolio_loan_repayments")
      .select("id", { count: "exact", head: true })
      .eq("snapshot_id", latestExisting.id);
    latestSnapHasRepaymentRows = (count ?? 0) > 0;
  }

  // Pre-load policy once per run
  const basePolicy = await loadActivePolicy(supabase, maxBatchDate);

  console.log(
    `📊 Estado inicial en base de datos: ${completedMap.size} snapshot(s) completados previamente.`,
  );
  console.log(
    `🚀 Iniciando ingesta masiva para '${entity.display_name}' (${entity.code})...\n`,
  );

  let processedCount = 0;
  let skippedCount = 0;
  const failedBatches: { date: string; error: string }[] = [];

  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    const isLatestSnapshot = b.date === maxBatchDate;
    const prefix = `[${String(i + 1).padStart(3, " ")}/${batches.length}] ${b.date}`;

    const existing = completedMap.get(b.date);
    if (
      existing &&
      !forceReingest &&
      (!isLatestSnapshot || latestSnapHasRepaymentRows)
    ) {
      // Ensure existing snapshot has lastRealPaymentMap metadata if missing
      try {
        await backfillExistingSnapshotMetadata(supabase, existing, b, basePolicy);
      } catch (metaErr) {
        console.warn(
          `⚠️ ${prefix}: Advertencia al verificar metadata de snapshot existente:`,
          metaErr instanceof Error ? metaErr.message : metaErr,
        );
      }
      console.log(
        `⏭️  ${prefix}: Ya completado en base de datos (omitido, continuando...)`,
      );
      skippedCount++;
      continue;
    }

    let success = false;
    let lastError = "";
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const t0 = Date.now();
        let loansRaw: Record<string, string>[];
        let repaymentsRaw: Record<string, string>[] = [];
        let hasRepaymentsFile = false;
        let loansSha256: string | undefined;
        let repaymentsSha256: string | null | undefined;
        let sourceFiles: Record<string, unknown>;

        if (b.zipFile) {
          const zipBuffer = fs.readFileSync(b.zipFile);
          const parsedZip = await parsePortfolioZip(
            zipBuffer,
            path.basename(b.zipFile),
          );
          loansRaw = parsedZip.loansRaw;
          repaymentsRaw = parsedZip.repaymentsRaw;
          hasRepaymentsFile = parsedZip.hasRepaymentsFile;
          loansSha256 = parsedZip.loansSha256;
          repaymentsSha256 = parsedZip.repaymentsSha256;
          sourceFiles = {
            zipFile: path.basename(b.zipFile),
            loansFile: parsedZip.loansFileName,
            repaymentsFile: parsedZip.repaymentsFileName,
            borrowersFile: parsedZip.borrowersFileName,
            hasRepaymentsFile: parsedZip.hasRepaymentsFile,
          };
        } else if (b.loansFile) {
          const loansCsv = fs.readFileSync(b.loansFile, "utf-8");
          loansRaw = parseCsv(loansCsv);
          if (b.repaymentsFile && fs.existsSync(b.repaymentsFile)) {
            const repsCsv = fs.readFileSync(b.repaymentsFile, "utf-8");
            repaymentsRaw = parseCsv(repsCsv);
            hasRepaymentsFile = true;
          }
          sourceFiles = {
            loansFile: path.basename(b.loansFile),
            repaymentsFile: b.repaymentsFile
              ? path.basename(b.repaymentsFile)
              : undefined,
            hasRepaymentsFile,
          };
        } else {
          throw new Error("Lote sin archivo .zip ni archivo loans.csv.");
        }

        const res = await ingestSnapshot(supabase, {
          entityCode,
          snapshotDate: b.date,
          loansRaw,
          repaymentsRaw,
          hasRepaymentsFile,
          loansSha256,
          repaymentsSha256,
          policy: basePolicy,
          sourceFiles,
          // Avoid 500MB+ of unused raw CSV JSONB & 5.2M duplicate historical repayment rows
          includeRawJson: false,
          skipRepaymentsInsert: !isLatestSnapshot,
        });

        const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
          `✅ ${prefix}: ${res.openLoans} abiertos ($${Math.round(res.openBalance).toLocaleString("en-US")}) | CeR30: ${res.cer30Percentage}% | CeR90: ${res.cer90Percentage}% | ${res.repaymentsCount} pagos (${elapsedSec}s)`,
        );

        processedCount++;
        success = true;
        break;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts) {
          const backoffMs = attempt * 2500;
          console.warn(
            `⚠️  ${prefix}: Intento ${attempt}/${maxAttempts} falló (${lastError}). Reintentando en ${backoffMs / 1000}s...`,
          );
          await sleep(backoffMs);
        }
      }
    }

    if (!success) {
      console.error(
        `❌ ${prefix}: Falló tras ${maxAttempts} intentos: ${lastError}. Se conservan todos los snapshots previos completados.`,
      );
      failedBatches.push({ date: b.date, error: lastError });
    } else if (throttleMs > 0 && i < batches.length - 1) {
      await sleep(throttleMs);
    }
  }

  // Post-ingest optimization: if the latest snapshot is completed and has repayment rows,
  // clean up duplicate historical repayment rows from older snapshots so DB size stays compact,
  // and pre-warm the Board Report cache (cached_dataset) on the latest snapshot.
  try {
    const { data: latestSnap } = await supabase
      .from("portfolio_snapshots")
      .select("id, snapshot_date")
      .eq("entity_id", entity.id)
      .eq("snapshot_date", maxBatchDate)
      .eq("status", "completed")
      .maybeSingle();

    if (latestSnap) {
      const { count: latestRepCount } = await supabase
        .from("portfolio_loan_repayments")
        .select("id", { count: "exact", head: true })
        .eq("snapshot_id", latestSnap.id);

      if ((latestRepCount ?? 0) > 0) {
        console.log(
          `\n🧹 Optimizando almacenamiento histórico (conservando tabla de pagos íntegra en el corte más reciente ${maxBatchDate})...`,
        );
        const { data: oldSnaps } = await supabase
          .from("portfolio_snapshots")
          .select("id, snapshot_date")
          .eq("entity_id", entity.id)
          .lt("snapshot_date", maxBatchDate);

        for (const oldSnap of oldSnaps || []) {
          const { count: oldRepCount } = await supabase
            .from("portfolio_loan_repayments")
            .select("id", { count: "exact", head: true })
            .eq("snapshot_id", oldSnap.id);

          if ((oldRepCount ?? 0) > 0) {
            const { error: cleanRepsErr } = await supabase
              .from("portfolio_loan_repayments")
              .delete()
              .eq("snapshot_id", oldSnap.id);

            if (cleanRepsErr) {
              console.warn(
                `⚠️ No se pudieron limpiar pagos duplicados de ${oldSnap.snapshot_date}:`,
                cleanRepsErr.message,
              );
            }
          }
        }
      }

      // Invalidate any stale cached_dataset across entity snapshots and precompute for latest
      console.log(
        `⚡ Pre-calculando caché del Reporte de Junta (cached_dataset) para ${maxBatchDate}...`,
      );
      await supabase
        .from("portfolio_snapshots")
        .update({ cached_dataset: null })
        .eq("entity_id", entity.id)
        .not("cached_dataset", "is", null);

      const dataset = await loadBoardDataset(supabase, entityCode, maxBatchDate);
      if (dataset) {
        await supabase
          .from("portfolio_snapshots")
          .update({ cached_dataset: dataset })
          .eq("id", latestSnap.id);
        console.log(
          `✓ Caché del Reporte de Junta actualizada (${Object.keys(dataset.snapshots).length} cortes históricos integrados).`,
        );
      }
    }
  } catch (postErr) {
    console.warn(
      "⚠️ Advertencia en paso de post-optimización:",
      postErr instanceof Error ? postErr.message : postErr,
    );
  }

  console.log("\n======================================================");
  console.log("📋 RESUMEN DE INGESTA MASIVA DE COBRANZAS Y CARTERA");
  console.log("======================================================");
  console.log(`• Total de archivos detectados : ${batches.length}`);
  console.log(`• Snapshots nuevos procesados  : ${processedCount}`);
  console.log(`• Snapshots ya existentes      : ${skippedCount}`);
  console.log(`• Archivos con error           : ${failedBatches.length}`);

  if (failedBatches.length > 0) {
    console.log("\n⚠️ Detalle de archivos con error (re-ejecuta el comando para reintentarlos desde donde quedó):");
    for (const f of failedBatches) {
      console.log(`  - [${f.date}]: ${f.error}`);
    }
    process.exit(1);
  } else {
    console.log("\n🎉 ¡Carga masiva completada al 100% sin errores!");
  }
}

run().catch((err) => {
  console.error("Error fatal en bulk-ingest:", err);
  process.exit(1);
});
