// Synthetic BG fixtures mirroring the real export shape. Real exports
// have the headers in row 6 (statement) / row 8 (ACH detail) with merged
// preamble cells above; we replicate that so the parser exercises its
// "find the header row" path the same way it will in production.

type Cell = string | number | Date | null;

export const minimalBGStatementSheet: Cell[][] = [
  ["", "", "", "", "", "", "", ""],
  ["Numero de Cuenta: 03-43-01-106691-6", "", "", "", "", "", "", ""],
  ["Empresa: CREDICLARO, S.A.", "", "", "", "", "", "", ""],
  ["Movimientos desde 13-abr-2026 hasta 16-may-2026", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", ""],
  ["Fecha", "Referencia", "Transacción", "Descripción", "Débito", "Crédito", "Saldo total", ""],
  // 2627 — same-bank in, plain name, no DBA, no comment trailer
  [
    "2026-04-13T23:59:26.000Z",
    "1080644554",
    "2627",
    "BANCA EN LINEA TRANSFERENCIA DE MARISELA LOPEZ PERALTA BANCA EN LINEA TRANSFERENCIA A TERC",
    "",
    8.33,
    31973.07,
    "",
  ],
  // 2627 — same-bank in, with DBA in parentheses
  [
    "2026-04-13T23:59:26.000Z",
    "1080644800",
    "2627",
    "BANCA EN LINEA TRANSFERENCIA DE NUBIA SIKIU VELASQUEZ RUIZ (FASHION KIDS SALON) CAPAES0001",
    "",
    15,
    31988.07,
    "",
  ],
  // 48 — ACH in, plain "ACH - {NAME}"
  [
    "2026-04-13T23:59:26.000Z",
    "93",
    "48",
    "ACH - JUAN CARLOS MONTENEGRO CEDENO",
    "",
    13.19,
    32001.26,
    "",
  ],
  // 40 — Yappy deposit aggregate
  [
    "2026-04-14T23:59:26.000Z",
    "457",
    "40",
    "DEPOSITO YAPPY - financieracrediclaro (1 TRANSACCIONES)",
    "",
    24.67,
    32025.93,
    "",
  ],
  // 40 — bare deposit
  [
    "2026-04-15T23:59:26.000Z",
    "1102446463",
    "40",
    "DEPOSITO",
    "",
    41.05,
    32066.98,
    "",
  ],
  // 50 — Yappy commission (non-loan)
  [
    "2026-04-15T23:59:26.000Z",
    "458",
    "50",
    "COMISION TRANSACCIONES YAPPY financieracrediclaro",
    0.27,
    "",
    32066.71,
    "",
  ],
  // 2520 — same-bank transfer OUT (non-loan)
  [
    "2026-04-15T23:59:26.000Z",
    "1100251235",
    "2520",
    "BANCA EN LINEA TRANSFERENCIA A 0472982574047 EMILI COROMOTO URIBE GARCIA Pago Liquidacion",
    4754.24,
    "",
    27312.47,
    "",
  ],
];

export const minimalBGAchDetailSheet: Cell[][] = [
  ["Detalles del  Archivo ACH", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", ""],
  ["Nombre de archivo: 20260229 - Crediclaro - LOTE ACH BG 30.txt", "", "", "", "", "", "", ""],
  ["3 transacciones 1 realizada 2 rechazadas", "", "", "", "", "", "", ""],
  ["Fecha efectiva 02-mar-2026", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", ""],
  [
    "CODIGO DE RUTA",
    "CUENTA",
    "MONTO",
    "BENEFICIARIO",
    "NOMBRE DEL BENEFICIARIO",
    "ADDENDA",
    "DESCRIPCION DE ERROR",
    "OBSERVACIONES",
  ],
  // Rejected — R10
  [
    "0071",
    "0443982533439",
    "$108.33",
    "8-499-770",
    "ALEX ANTONIO DAVIS LOP",
    "REF*TXT**DESC FINANCIAMIENTO MES DE FEBRERO",
    "R10 NO EXISTE AUTORIZACION DEL RECIBIDOR",
    "",
  ],
  // Approved (empty error)
  [
    "0071",
    "0443995115548",
    "$332.00",
    "8-492-277",
    "MIGUEL ANTONIO AMADO O",
    "REF*TXT**DESC FINANCIAMIENTO MES DE FEBRERO",
    "",
    "",
  ],
  // Rejected — R01
  [
    "0071",
    "0449999384370",
    "$166.00",
    "3-700-1884",
    "LIZBELLE MERCEDES MEZA",
    "REF*TXT**DESC FINANCIAMIENTO MES DE FEBRERO",
    "R01 FONDOS INSUFICIENTES",
    "",
  ],
];
