"use server";

import { revalidatePath } from "next/cache";

import { requirePortfolioWriter } from "@/lib/auth/guard";
import { ingestSnapshot } from "@/lib/portfolio/ingest";
import { extractDateFromName, parseCsv } from "@/lib/portfolio/parser";
import { isPreviewMode } from "@/lib/preview";
import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";

export async function deleteSnapshotAction(snapshotId: string) {
  await requirePortfolioWriter();
  const supabase = isPreviewMode()
    ? createSupabaseServiceClient()
    : await createSupabaseServerClient();

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
  await requirePortfolioWriter();
  const supabase = isPreviewMode()
    ? createSupabaseServiceClient()
    : await createSupabaseServerClient();

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
  const loansRaw = parseCsv(loansText);

  let repaymentsRaw: Record<string, string>[] = [];
  if (repaymentsFile && repaymentsFile.size > 0) {
    const repaymentsText = await repaymentsFile.text();
    repaymentsRaw = parseCsv(repaymentsText);
  }

  const result = await ingestSnapshot(supabase, {
    entityCode,
    snapshotDate,
    loansRaw,
    repaymentsRaw,
    sourceFiles: {
      loansFile: loansFile.name,
      repaymentsFile: repaymentsFile?.name,
    },
  });

  revalidatePath("/portfolio");
  revalidatePath("/portfolio/board");
  revalidatePath("/portfolio/collections");

  return { success: true, result };
}

