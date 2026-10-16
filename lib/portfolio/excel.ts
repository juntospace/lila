// Native Excel generator (.xlsx) using exceljs
// Replicates exact openpyxl visual formatting from generar_acciones.py

import ExcelJS from "exceljs";

import type { ActionPlanItem, ActionPlanSummary } from "./types";

const FONT_NAME = "Arial";
const HEADER_FILL_COLOR = "FFEDEAFB"; // ARGB
const HEADER_FONT_COLOR = "FF4A3FB0"; // ARGB
const TITLE_COLOR = "FF1E1B2E";
const SUBTITLE_COLOR = "FF6E6A82";
const BORDER_COLOR = "FFE7E4F1";

const PRIO_FILL_COLORS: Record<number, string> = {
  1: "FFF8E4E4", // Soft red
  2: "FFFAF0DD", // Soft amber
  3: "FFE3F3EC", // Soft green
};

const HDRS = [
  "Prio",
  "Préstamo #",
  "Cliente",
  "Celular",
  "Segmento",
  "DPD",
  "Tramo",
  "Saldo",
  "Monto a cobrar",
  "Último pago",
  "Motivo / acción",
];

const COL_WIDTHS = [6, 15, 30, 13, 17, 6, 9, 12, 13, 11, 78];
const CURRENCY_FORMAT = '"$"#,##0.00';

export async function generateCollectionsWorkbook(
  plan: ActionPlanItem[],
  resumen: ActionPlanSummary,
  snapshotDate: string,
  policyVersion?: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Lila · Plataforma de Cobranzas";
  wb.created = new Date();

  function buildSheet(
    ws: ExcelJS.Worksheet,
    title: string,
    subtitle: string,
    items: ActionPlanItem[],
  ) {
    // Title & subtitle
    ws.getCell("A1").value = title;
    ws.getCell("A1").font = {
      name: FONT_NAME,
      size: 13,
      bold: true,
      color: { argb: TITLE_COLOR },
    };

    ws.getCell("A2").value = subtitle;
    ws.getCell("A2").font = {
      name: FONT_NAME,
      size: 9,
      color: { argb: SUBTITLE_COLOR },
    };

    const headerRowIdx = 4;
    const headerRow = ws.getRow(headerRowIdx);

    for (let c = 0; c < HDRS.length; c++) {
      const cell = headerRow.getCell(c + 1);
      cell.value = HDRS[c];
      cell.font = {
        name: FONT_NAME,
        size: 9,
        bold: true,
        color: { argb: HEADER_FONT_COLOR },
      };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: HEADER_FILL_COLOR },
      };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = {
        bottom: { style: "thin", color: { argb: BORDER_COLOR } },
      };
      ws.getColumn(c + 1).width = COL_WIDTHS[c];
    }

    // Freeze panes below header
    ws.views = [{ state: "frozen", ySplit: headerRowIdx }];

    // Populate data rows (Fase 2.8: no centered alignments on data rows, matching Python)
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const rowIdx = headerRowIdx + 1 + i;
      const row = ws.getRow(rowIdx);

      const rowValues = [
        `P${it.prio}`,
        it.loanno,
        it.cliente,
        it.cel,
        it.seg,
        it.dpd,
        it.tramo,
        it.saldo,
        it.cura,
        it.ultpago,
        it.motivo,
      ];

      for (let c = 0; c < rowValues.length; c++) {
        const cell = row.getCell(c + 1);
        cell.value = rowValues[c];
        cell.font = { name: FONT_NAME, size: 9 };
        cell.border = {
          bottom: { style: "thin", color: { argb: BORDER_COLOR } },
        };
      }

      // Format priority badge (bold + fill, no horizontal alignment in Python)
      const prioCell = row.getCell(1);
      prioCell.font = { name: FONT_NAME, size: 9, bold: true };
      prioCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: PRIO_FILL_COLORS[it.prio] ?? PRIO_FILL_COLORS[3] },
      };

      // Currency format on Saldo and Cura
      row.getCell(8).numFmt = CURRENCY_FORMAT;
      row.getCell(9).numFmt = CURRENCY_FORMAT;
    }
  }

  // 1. Sheet: Hoy (Top 40)
  const wsHoy = wb.addWorksheet("Hoy");
  const top40 = plan.slice(0, 40);
  buildSheet(
    wsHoy,
    `Plan de ataque · ${snapshotDate}`,
    `Top ${Math.min(40, plan.length)} por impacto en el envejecimiento. P1 rojo = ya se movió / gratis · P2 ámbar = curar antes de que ruede · P3 verde = formalizar pagadores.`,
    top40,
  );

  // 2. Sheet: Todos los accionables
  const wsTodos = wb.addWorksheet("Todos los accionables");
  buildSheet(
    wsTodos,
    "Todos los préstamos accionables",
    "Misma priorización, lista completa (excluye candidatos a castigo).",
    plan,
  );

  // 3. Sheet: Resumen (Fase 2.8: no color on A1 title)
  const wsResumen = wb.addWorksheet("Resumen");
  wsResumen.getCell("A1").value = "Resumen";
  wsResumen.getCell("A1").font = {
    name: FONT_NAME,
    size: 13,
    bold: true,
  };

  if (policyVersion) {
    wsResumen.getCell("A2").value = `Política ${policyVersion}`;
    wsResumen.getCell("A2").font = {
      name: FONT_NAME,
      size: 9,
      color: { argb: SUBTITLE_COLOR },
    };
  }

  const filas: [string, string | number, boolean][] = [
    ["Fecha del batch", snapshotDate, false],
    [
      "Instantánea previa (para 'rodó de tramo')",
      resumen.prev_date || "(sin historial suficiente)",
      false,
    ],
    ["Préstamos abiertos", resumen.abiertos, false],
    ["Saldo abierto", resumen.saldo, true],
    ["Préstamos accionables", resumen.accionables, false],
    [
      "Excluidos por castigo (umbral vencido, sin pagos ≥180d)",
      resumen.castigo_excl,
      false,
    ],
    ["Saldo excluido por castigo", resumen.castigo_saldo, true],
    ["Cobro objetivo del Top (suma 'Monto a cobrar')", resumen.top40_cura, true],
    ["Saldo que ese cobro re-envejece", resumen.top40_saldo, true],
  ];

  for (let idx = 0; idx < filas.length; idx++) {
    const rIdx = idx + 3;
    const [label, val, isMoney] = filas[idx];

    const c1 = wsResumen.getCell(`A${rIdx}`);
    c1.value = label;
    c1.font = { name: FONT_NAME, size: 10 };

    const c2 = wsResumen.getCell(`B${rIdx}`);
    c2.value = val;
    c2.font = { name: FONT_NAME, size: 10, bold: true };
    if (isMoney) {
      c2.numFmt = CURRENCY_FORMAT;
    }
  }

  wsResumen.getColumn(1).width = 52;
  wsResumen.getColumn(2).width = 18;

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
