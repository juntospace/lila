import { NextRequest, NextResponse } from "next/server";

import { requireOperator } from "@/lib/auth/guard";
import { getPortfolioClient } from "@/lib/portfolio/client";
import { loadCollectionsPlan } from "@/lib/portfolio/collections-loader";
import { generateCollectionsWorkbook } from "@/lib/portfolio/excel";

export async function GET(request: NextRequest) {
  await requireOperator();
  const searchParams = request.nextUrl.searchParams;
  const targetDate = searchParams.get("date");
  const entityCode = searchParams.get("entity") || "crediclaro";

  const supabase = await getPortfolioClient();
  const loaded = await loadCollectionsPlan(supabase, entityCode, targetDate);

  if (!loaded) {
    return new NextResponse("Snapshot not found", { status: 404 });
  }

  const { plan, resumen, asOfDate, policy } = loaded;

  const buffer = await generateCollectionsWorkbook(
    plan,
    resumen,
    asOfDate,
    policy.version,
  );

  const filename = `acciones_${asOfDate}.xlsx`;
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
