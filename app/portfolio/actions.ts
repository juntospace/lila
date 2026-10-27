"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";

import { requirePortfolioWriter } from "@/lib/auth/guard";
import { getPortfolioClient } from "@/lib/portfolio/client";
import { ingestSnapshot } from "@/lib/portfolio/ingest";
import {
  extractDateFromName,
  parseCsv,
  parsePortfolioZip,
} from "@/lib/portfolio/parser";

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

  // Accept primary ZIP file ("file" or "zipFile"), or fallback to legacy separate CSVs ("loansFile")
  const file = (formData.get("file") || formData.get("zipFile")) as File | null;
  const legacyLoansFile = formData.get("loansFile") as File | null;
  const legacyRepaymentsFile = formData.get("repaymentsFile") as File | null;

  const targetFile = file || legacyLoansFile;

  if (!targetFile || targetFile.size === 0) {
    throw new Error("Debes seleccionar un archivo ZIP de respaldo.");
  }

  const isZip =
    targetFile.name.toLowerCase().endsWith(".zip") ||
    targetFile.type === "application/zip" ||
    targetFile.type === "application/x-zip-compressed";

  let loansRaw: Record<string, string>[];
  let repaymentsRaw: Record<string, string>[] = [];
  let hasRepaymentsFile = false;
  let loansSha256: string;
  let repaymentsSha256: string | null = null;
  let sourceFiles: Record<string, unknown>;

  if (isZip) {
    const arrayBuffer = await targetFile.arrayBuffer();
    const parsedZip = await parsePortfolioZip(arrayBuffer, targetFile.name);

    if (!snapshotDate) {
      snapshotDate = parsedZip.snapshotDate;
    }

    loansRaw = parsedZip.loansRaw;
    repaymentsRaw = parsedZip.repaymentsRaw;
    hasRepaymentsFile = parsedZip.hasRepaymentsFile;
    loansSha256 = parsedZip.loansSha256;
    repaymentsSha256 = parsedZip.repaymentsSha256;

    sourceFiles = {
      zipFile: targetFile.name,
      loansFile: parsedZip.loansFileName,
      repaymentsFile: parsedZip.repaymentsFileName,
      borrowersFile: parsedZip.borrowersFileName,
      hasRepaymentsFile: parsedZip.hasRepaymentsFile,
    };
  } else {
    // Legacy separate CSV file handling
    if (!snapshotDate) {
      snapshotDate =
        extractDateFromName(targetFile.name) ||
        (legacyRepaymentsFile ? extractDateFromName(legacyRepaymentsFile.name) : null);
    }

    const loansText = await targetFile.text();
    loansSha256 = sha256Hex(loansText);
    loansRaw = parseCsv(loansText);

    hasRepaymentsFile = Boolean(legacyRepaymentsFile && legacyRepaymentsFile.size > 0);
    if (hasRepaymentsFile && legacyRepaymentsFile) {
      const repaymentsText = await legacyRepaymentsFile.text();
      repaymentsSha256 = sha256Hex(repaymentsText);
      repaymentsRaw = parseCsv(repaymentsText);
    }

    sourceFiles = {
      loansFile: targetFile.name,
      repaymentsFile: hasRepaymentsFile ? legacyRepaymentsFile?.name : undefined,
      hasRepaymentsFile,
    };
  }

  if (!snapshotDate) {
    throw new Error(
      "No se pudo detectar la fecha del corte (AAAA-MM-DD). Por favor indícala en el campo Fecha de corte.",
    );
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
    sourceFiles,
  });

  revalidatePath("/portfolio");
  revalidatePath("/portfolio/board");
  revalidatePath("/portfolio/collections");

  return { success: true, result };
}
