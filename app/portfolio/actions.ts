"use server";

import { readFile } from "node:fs/promises";
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

const SAMPLE_DIR = join(process.cwd(), "tmp", "samples", "70136");
const SAMPLE_FILES = {
  borrowers: "borrowers_branch1.csv",
  loans: "loans_branch1.csv",
  repayments: "repayments_branch1.csv",
} as const;

/**
 * Ingest the Crediclaro LoanDisk sample bundle from tmp/samples/70136
 * as a snapshot for today's date. Local-dev convenience — production
 * ingest will run via a scheduled job + remote file delivery (open
 * question O5).
 */
export async function ingestCrediclaroSample(): Promise<IngestSampleState> {
  const session = await requirePortfolioWriter();

  try {
    const [borrowersBytes, loansBytes, repaymentsBytes] = await Promise.all([
      readFile(join(SAMPLE_DIR, SAMPLE_FILES.borrowers)),
      readFile(join(SAMPLE_DIR, SAMPLE_FILES.loans)),
      readFile(join(SAMPLE_DIR, SAMPLE_FILES.repayments)),
    ]);

    const bundle = parseLoanDiskBundle({
      borrowers: {
        filename: SAMPLE_FILES.borrowers,
        bytes: new Uint8Array(borrowersBytes),
      },
      loans: {
        filename: SAMPLE_FILES.loans,
        bytes: new Uint8Array(loansBytes),
      },
      repayments: {
        filename: SAMPLE_FILES.repayments,
        bytes: new Uint8Array(repaymentsBytes),
      },
    });

    const supabase = await createSupabaseServerClient();
    const snapshotDate = todayIso();

    const result = await ingestPortfolioSnapshot(supabase, {
      entityCode: "crediclaro",
      snapshotDate,
      bundle,
      uploadedBy: session.userId,
    });

    revalidatePath("/portfolio");
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
        message: `Sample CSVs not found under ${SAMPLE_DIR}. Drop the three branch1 files there and try again.`,
      };
    }
    return { status: "error", message: detail };
  }
}

function todayIso(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
