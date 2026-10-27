/**
 * Bulk Ingestion CLI for LoanDisk Historical Backups
 *
 * Scans a folder containing multiple dated folders or CSV files,
 * sorts them chronologically, and ingests them idempotently into Supabase.
 *
 * Usage:
 *   npx tsx scripts/portfolio/bulk-ingest.ts <directory-path> [--entity=crediclaro] [--force]
 *
 * Examples:
 *   npx tsx scripts/portfolio/bulk-ingest.ts /home/carluis/Downloads/lila-reportes/lila-board-report/input
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { ingestSnapshot } from "../../lib/portfolio/ingest";
import { extractDateFromName, parseCsv } from "../../lib/portfolio/parser";

// 1. Load environment variables
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
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  }
}

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ ERROR: SUPABASE_SERVICE_ROLE_KEY no está definido en .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

interface BatchItem {
  date: string;
  loansFile: string;
  repaymentsFile?: string;
  sourceDir: string;
}

function findBatchesInDir(dirPath: string): BatchItem[] {
  const batches: Map<string, BatchItem> = new Map();

  function scan(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    // Check for zip files and extract if folder doesn't exist
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".zip")) {
        const date = extractDateFromName(entry.name);
        if (date) {
          const targetExtract = path.join(currentDir, date);
          if (!fs.existsSync(targetExtract)) {
            try {
              console.log(`📦 Descomprimiendo ${entry.name}...`);
              fs.mkdirSync(targetExtract, { recursive: true });
              execSync(`unzip -q -o "${path.join(currentDir, entry.name)}" -d "${targetExtract}"`);
            } catch (err: unknown) {
              console.warn(`⚠️ Error al descomprimir ${entry.name}:`, err instanceof Error ? err.message : err);
            }
          }
        }
      }
    }

    // Refresh entries after any unzip
    const updatedEntries = fs.readdirSync(currentDir, { withFileTypes: true });

    let loansPath: string | null = null;
    let repsPath: string | null = null;

    for (const entry of updatedEntries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".csv")) {
        const lower = entry.name.toLowerCase();
        if (lower.includes("loans") && !lower.includes("repayments") && !lower.includes("borrowers")) {
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
  return Array.from(batches.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function run() {
  const args = process.argv.slice(2);
  const targetDir = args.find((a) => !a.startsWith("--"));
  const entityCode =
    args.find((a) => a.startsWith("--entity="))?.split("=")[1] || "crediclaro";

  if (!targetDir) {
    console.log(`
Uso:
  npx tsx scripts/portfolio/bulk-ingest.ts <directorio-de-backups> [--entity=crediclaro]

Ejemplo:
  npx tsx scripts/portfolio/bulk-ingest.ts /home/carluis/Downloads/lila-reportes/lila-board-report/input
`);
    process.exit(1);
  }

  const resolvedDir = path.resolve(process.cwd(), targetDir);
  if (!fs.existsSync(resolvedDir)) {
    console.error(`❌ El directorio no existe: ${resolvedDir}`);
    process.exit(1);
  }

  console.log(`\n🔍 Buscando respaldos de LoanDisk en: ${resolvedDir}`);
  const batches = findBatchesInDir(resolvedDir);

  if (batches.length === 0) {
    console.log("⚠️ No se encontraron archivos de préstamos (*loans*.csv) con fecha en la carpeta.");
    process.exit(0);
  }

  console.log(`✓ Se encontraron ${batches.length} lote(s) de fecha para procesar:\n`);
  for (const b of batches) {
    console.log(`  • [${b.date}] loans: ${path.basename(b.loansFile)} | reps: ${b.repaymentsFile ? path.basename(b.repaymentsFile) : "(sin pagos)"}`);
  }

  console.log(`\n🚀 Iniciando ingesta masiva para entidad '${entityCode}'...\n`);

  let count = 0;
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    const prefix = `[${i + 1}/${batches.length}] ${b.date}:`;
    try {
      const loansCsv = fs.readFileSync(b.loansFile, "utf-8");
      const loansRaw = parseCsv(loansCsv);

      let repaymentsRaw: Record<string, string>[] = [];
      if (b.repaymentsFile && fs.existsSync(b.repaymentsFile)) {
        const repsCsv = fs.readFileSync(b.repaymentsFile, "utf-8");
        repaymentsRaw = parseCsv(repsCsv);
      }

      const res = await ingestSnapshot(supabase, {
        entityCode,
        snapshotDate: b.date,
        loansRaw,
        repaymentsRaw,
        sourceFiles: {
          loans: path.basename(b.loansFile),
          repayments: b.repaymentsFile ? path.basename(b.repaymentsFile) : null,
        },
      });

      console.log(
        `✓ ${prefix} Ingestados ${res.openLoans} préstamos abiertos ($${Math.round(res.openBalance).toLocaleString()}), CER30: ${res.cer30Percentage}%, CER90: ${res.cer90Percentage}%, ${res.repaymentsCount} pagos.`
      );
      count++;
    } catch (err: unknown) {
      console.error(`❌ ${prefix} Error al procesar:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\n🎉 Ingesta completada con éxito: ${count} de ${batches.length} lotes procesados.`);
}

run().catch((err) => {
  console.error("Error fatal en bulk-ingest:", err);
  process.exit(1);
});

