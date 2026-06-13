"use server";

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { revalidatePath } from "next/cache";

import { requirePortfolioWriter } from "@/lib/auth/guard";
import { ingestPortfolioSnapshot } from "@/lib/portfolio/ingest";
import { parseLoanDiskBundle } from "@/lib/portfolio/parser";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface IngestSampleState {
  status: "idle" | "success" | "error";
  message?: string;
  snapshotId?: string;
}

const SAMPLES_ROOT = join(process.cwd(), "tmp", "samples");
const FILES = {
  borrowers: "borrowers_branch1.csv",
  loans: "loans_branch1.csv",
  repayments: "repayments_branch1.csv",
} as const;
const LEGACY_DIR = "70136"; // first sample drop, dated as today

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// LoanDisk's native daily-export folder name: `70136 (06JUN)` etc.
// Year is assumed current; if a December export is dropped in January
// the user should rename to the explicit YYYY-MM-DD form.
const LOANDISK_PATTERN = /^70136\s*\((\d{1,2})([A-Z]{3})\)$/;
const MONTH_CODES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/**
 * Derive the snapshot ISO date for a sample folder. Accepts:
 *   YYYY-MM-DD                — used as-is
 *   70136                     — today
 *   70136 (06JUN) / 70136(06JUN) — DDMMM in current year
 * Returns null if the folder name doesn't fit any supported format.
 */
function folderToSnapshotDate(folder: string): string | null {
  if (DATE_PATTERN.test(folder)) return folder;
  if (folder === LEGACY_DIR) return todayIso();
  const m = LOANDISK_PATTERN.exec(folder);
  if (!m) return null;
  const day = Number.parseInt(m[1], 10);
  const month = MONTH_CODES[m[2]];
  if (!month) return null;
  if (day < 1 || day > 31) return null;
  const year = new Date().getUTCFullYear();
  return `${year}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

// =============================================================
// Discovery
// =============================================================

export interface AvailableBackfill {
  /** Folder under tmp/samples/. Either an ISO date or "70136" (legacy). */
  folder: string;
  /** ISO snapshot_date this folder will ingest as. */
  snapshotDate: string;
  /** True if all three CSVs are present. */
  ready: boolean;
  /** Missing filenames, if any. */
  missing: string[];
}

/**
 * Scan tmp/samples/ for ingestable folders. Each YYYY-MM-DD folder
 * becomes a snapshot at that date; the legacy `70136` folder maps to
 * today's date (compat with the first sample drop).
 */
export async function discoverAvailableBackfills(): Promise<AvailableBackfill[]> {
  await requirePortfolioWriter();
  let dirs: string[];
  try {
    dirs = (await readdir(SAMPLES_ROOT, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const candidates: Array<{ folder: string; snapshotDate: string }> = [];
  for (const d of dirs) {
    const snapshotDate = folderToSnapshotDate(d);
    if (snapshotDate) candidates.push({ folder: d, snapshotDate });
  }
  // Order by snapshot date ascending so backfill runs oldest-first.
  candidates.sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));

  const results: AvailableBackfill[] = [];
  for (const { folder, snapshotDate } of candidates) {
    const dir = join(SAMPLES_ROOT, folder);
    const missing: string[] = [];
    for (const f of Object.values(FILES)) {
      try {
        await stat(join(dir, f));
      } catch {
        missing.push(f);
      }
    }
    results.push({
      folder,
      snapshotDate,
      ready: missing.length === 0,
      missing,
    });
  }
  return results;
}

// =============================================================
// Ingest
// =============================================================

/**
 * Backward-compat — ingest the original tmp/samples/70136 bundle as today.
 */
export async function ingestCrediclaroSample(): Promise<IngestSampleState> {
  return ingestCrediclaroFolder(LEGACY_DIR);
}

/**
 * Ingest a single tmp/samples/<folder> for Crediclaro. The snapshot_date
 * is the folder name (YYYY-MM-DD) or today (legacy 70136 folder).
 */
export async function ingestCrediclaroFolder(
  folder: string,
): Promise<IngestSampleState> {
  const session = await requirePortfolioWriter();

  const snapshotDate = folderToSnapshotDate(folder);
  if (!snapshotDate) {
    return {
      status: "error",
      message: `Unsupported folder name "${folder}". Use YYYY-MM-DD or LoanDisk's "70136 (DDMMM)" form.`,
    };
  }
  const dir = join(SAMPLES_ROOT, folder);

  try {
    const [borrowersBytes, loansBytes, repaymentsBytes] = await Promise.all([
      readFile(join(dir, FILES.borrowers)),
      readFile(join(dir, FILES.loans)),
      readFile(join(dir, FILES.repayments)),
    ]);

    const bundle = parseLoanDiskBundle({
      borrowers: {
        filename: FILES.borrowers,
        bytes: new Uint8Array(borrowersBytes),
      },
      loans: {
        filename: FILES.loans,
        bytes: new Uint8Array(loansBytes),
      },
      repayments: {
        filename: FILES.repayments,
        bytes: new Uint8Array(repaymentsBytes),
      },
    });

    const supabase = await createSupabaseServerClient();
    const result = await ingestPortfolioSnapshot(supabase, {
      entityCode: "crediclaro",
      snapshotDate,
      bundle,
      uploadedBy: session.userId,
    });

    revalidatePath("/portfolio");
    revalidatePath("/portfolio/board");
    revalidatePath(`/portfolio/snapshots/${result.snapshotId}`);

    return {
      status: "success",
      message: `Ingested ${result.borrowerRowCount} borrowers, ${result.loanRowCount} loans, ${result.repaymentRowCount} repayments for ${snapshotDate}.`,
      snapshotId: result.snapshotId,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (detail.includes("ENOENT")) {
      return {
        status: "error",
        message: `CSVs not found under ${dir}. Drop the three branch1 files there and try again.`,
      };
    }
    return { status: "error", message: detail };
  }
}

/**
 * Ingest every ready folder under tmp/samples/, oldest first, so the
 * snapshot history builds up sequentially. Reports per-folder results.
 */
export interface BackfillRunState {
  status: "idle" | "success" | "partial" | "error";
  message?: string;
  results?: Array<{
    folder: string;
    snapshotDate: string;
    status: "success" | "error";
    detail: string;
  }>;
}

export async function runFullBackfill(): Promise<BackfillRunState> {
  await requirePortfolioWriter();
  const backfills = (await discoverAvailableBackfills()).filter((b) => b.ready);
  if (backfills.length === 0) {
    return {
      status: "error",
      message: `No ready folders under ${SAMPLES_ROOT}.`,
    };
  }
  const results: BackfillRunState["results"] = [];
  let successCount = 0;
  for (const b of backfills) {
    const r = await ingestCrediclaroFolder(b.folder);
    const status = r.status === "success" ? "success" : "error";
    if (status === "success") successCount++;
    results.push({
      folder: b.folder,
      snapshotDate: b.snapshotDate,
      status,
      detail: r.message ?? "",
    });
  }
  return {
    status:
      successCount === backfills.length
        ? "success"
        : successCount === 0
          ? "error"
          : "partial",
    message: `${successCount} / ${backfills.length} folders ingested.`,
    results,
  };
}

// =============================================================
// Helpers
// =============================================================

function todayIso(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
