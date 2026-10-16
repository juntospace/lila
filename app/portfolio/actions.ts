"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";

import { requirePortfolioWriter } from "@/lib/auth/guard";
import { getPortfolioClient } from "@/lib/portfolio/client";
import { ingestSnapshot } from "@/lib/portfolio/ingest";
import { extractDateFromName, parseCsv } from "@/lib/portfolio/parser";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function deleteSnapshotAction(snapshotId: string) {
  await requirePortfolioWriter();
  const supabase = await getPortfolioClient();

  const { error } = await supabase
    .from("portfolio_snapshots")
    .delete()
    .eq("id", snapshotId);

  if (error) {
    throw new Error(`Error al eliminar snapshot: ${error.message}`);
  }

  revalidatePath("/portfolio");
  revalidatePath("/portfolio/board");
  revalidatePath("/portfolio/collections");
  return { success: true };
}

export async function uploadPortfolioBackupAction(formData: FormData) {
  const session = await requirePortfolioWriter();
  const supabase = await getPortfolioClient();

  const entityCode = (formData.get("entityCode") as string) || "crediclaro";
  let snapshotDate = formData.get("snapshotDate") as string | null;

  const loansFile = formData.get("loansFile") as File | null;
  const repaymentsFile = formData.get("repaymentsFile") as File | null;

  if (!loansFile || loansFile.size === 0) {
    throw new Error("El archivo de préstamos (*loans*.csv) es requerido.");
  }

  // Attempt to deduce date from filename if not explicitly provided
  if (!snapshotDate) {
    snapshotDate =
      extractDateFromName(loansFile.name) ||
      (repaymentsFile ? extractDateFromName(repaymentsFile.name) : null);
  }

  if (!snapshotDate) {
    throw new Error(
      "No se pudo detectar la fecha del lote (AAAA-MM-DD). Por favor especifícala manualmente.",
    );
  }

  const loansText = await loansFile.text();
  const loansSha256 = sha256Hex(loansText);
  const loansRaw = parseCsv(loansText);

  const hasRepaymentsFile = Boolean(repaymentsFile && repaymentsFile.size > 0);
  let repaymentsRaw: Record<string, string>[] = [];
  let repaymentsSha256: string | null = null;

  if (hasRepaymentsFile && repaymentsFile) {
    const repaymentsText = await repaymentsFile.text();
    repaymentsSha256 = sha256Hex(repaymentsText);
    repaymentsRaw = parseCsv(repaymentsText);
  }

  const result = await ingestSnapshot(supabase, {
    entityCode,
    snapshotDate,
    loansRaw,
    repaymentsRaw,
    hasRepaymentsFile,
    loansSha256,
    repaymentsSha256,
    rejectDuplicateSha: true,
    uploadedBy: session.userId,
    sourceFiles: {
      loansFile: loansFile.name,
      repaymentsFile: hasRepaymentsFile ? repaymentsFile?.name : undefined,
      hasRepaymentsFile,
    },
  });

  revalidatePath("/portfolio");
  revalidatePath("/portfolio/board");
  revalidatePath("/portfolio/collections");

  return { success: true, result };
}
