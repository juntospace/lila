// Synthetic BAC statement fixture mirroring the real export's shape:
// preamble (KV pairs) → column-header row → transaction rows → footer text.
//
// Amounts are picked so the integrity check passes:
//   saldo_inicial 1000.00 + credits 250.50 - debits 50.50 = saldo_final 1200.00.

type Cell = string | number | Date | null;

export const minimalBACSheet: Cell[][] = [
  ['Estado de Cuenta', null, null, null, null, null, null, null, null, null],
  ['Cliente', 'JUNTO SOLUCIONES, S.A.', null, null, null, null, null, null, null, null],
  ['Cuenta', '100412600', null, null, null, null, null, null, null, null],
  ['Moneda', 'USD', null, null, null, null, null, null, null, null],
  ['Período', '05/04/2026 - 07/04/2026', null, null, null, null, null, null, null, null],
  ['Saldo Inicial', '1,000.00', null, null, null, null, null, null, null, null],
  ['Saldo Final', '1,200.00', null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null, null, null],
  // Column header row (col 2 and 5/6 left intentionally blank to match real layout).
  ['Fecha', 'Referencia', null, 'Código', 'Descripción', null, 'Débitos', 'Créditos', 'Balance', null],
  // PR — Junto-initiated ACH credit (will go pending).
  ['05/04/2026', 'REF001', null, 'PR', 'Tef DCD de Jorge Miguel Diaz P', null, '', '50.50', '1,050.50', null],
  // 4C — irrevocable inbound ACH credit.
  ['05/04/2026', 'REF002', null, '4C', 'ACH CRE Maria Lopez', null, '', '200.00', '1,250.50', null],
  // DA — DVTO reversal of REF001.
  ['06/04/2026', 'REF003', null, 'DA', 'DVTO AM04-JORGE MIGUEL DIAZ P', null, '50.50', '', '1,200.00', null],
  // Footer disclaimer (no parseable Fecha — must be skipped).
  ['* El balance mostrado es el balance en libros.', null, null, null, null, null, null, null, null, null],
];
