import { describe, expect, it } from 'vitest';
import {
  BACParseError,
  parseBACSheet,
  parseDvtoDescription,
  parseMinor,
  parseSpanishDate,
} from '@/lib/recon/bac/parser';
import { minimalBACSheet } from './fixtures/minimal-statement';

describe('parseMinor', () => {
  it('handles plain decimals', () => {
    expect(parseMinor('50.50')).toBe(5050n);
    expect(parseMinor('1,234.56')).toBe(123456n);
    expect(parseMinor(50.5)).toBe(5050n);
  });

  it('handles parenthesized and signed negatives', () => {
    expect(parseMinor('(1,234.56)')).toBe(-123456n);
    expect(parseMinor('-50.50')).toBe(-5050n);
  });

  it('handles blanks and dashes', () => {
    expect(parseMinor('')).toBe(0n);
    expect(parseMinor('-')).toBe(0n);
    expect(parseMinor('—')).toBe(0n);
    expect(parseMinor(null)).toBe(0n);
    expect(parseMinor(undefined)).toBe(0n);
  });
});

describe('parseSpanishDate', () => {
  it('parses DD/MM/YYYY', () => {
    expect(parseSpanishDate('05/04/2026')).toBe('2026-04-05');
  });

  it('parses Date objects', () => {
    expect(parseSpanishDate(new Date('2026-04-05T00:00:00Z'))).toBe('2026-04-05');
  });

  it('returns null on garbage', () => {
    expect(parseSpanishDate('Total mes')).toBeNull();
    expect(parseSpanishDate('')).toBeNull();
  });
});

describe('parseDvtoDescription', () => {
  it('extracts return code and payer name', () => {
    expect(parseDvtoDescription('DVTO AM04-JORGE MIGUEL DIAZ P')).toEqual({
      returnCode: 'AM04',
      payerNameRaw: 'JORGE MIGUEL DIAZ P',
    });
  });

  it('handles em-dash separators', () => {
    expect(parseDvtoDescription('DVTO AC01 — MARIA LOPEZ')).toEqual({
      returnCode: 'AC01',
      payerNameRaw: 'MARIA LOPEZ',
    });
  });

  it('returns empty object for non-DVTO text', () => {
    expect(parseDvtoDescription('Tef DCD de Maria Lopez')).toEqual({});
  });
});

describe('parseBACSheet', () => {
  it('parses header, rows, and integrity from a minimal statement', () => {
    const result = parseBACSheet(minimalBACSheet);

    expect(result.header.accountNumber).toBe('100412600');
    expect(result.header.accountHolder).toBe('JUNTO SOLUCIONES, S.A.');
    expect(result.header.currency).toBe('USD');
    expect(result.header.saldoInicialMinor).toBe(100000n);
    expect(result.header.saldoFinalMinor).toBe(120000n);
    expect(result.header.dateRangeStart).toBe('2026-04-05');
    expect(result.header.dateRangeEnd).toBe('2026-04-07');

    expect(result.rows).toHaveLength(3);

    const [pr, ach, dvto] = result.rows;

    expect(pr).toMatchObject({
      postedAt: '2026-04-05',
      reference: 'REF001',
      code: 'PR',
      debitMinor: 0n,
      creditMinor: 5050n,
      balanceMinor: 105050n,
    });
    expect(pr.returnCode).toBeUndefined();

    expect(ach).toMatchObject({
      code: '4C',
      creditMinor: 20000n,
      debitMinor: 0n,
    });

    expect(dvto).toMatchObject({
      code: 'DA',
      debitMinor: 5050n,
      creditMinor: 0n,
      returnCode: 'AM04',
      payerNameRaw: 'JORGE MIGUEL DIAZ P',
    });

    expect(result.integrity.ok).toBe(true);
    expect(result.integrity.expectedFinalMinor).toBe(120000n);
    expect(result.integrity.diffMinor).toBe(0n);
  });

  it('skips footer disclaimer rows that have no parseable date', () => {
    const result = parseBACSheet(minimalBACSheet);
    expect(result.rows.every((r) => r.postedAt.match(/^\d{4}-\d{2}-\d{2}$/))).toBe(true);
  });

  it('flags an integrity mismatch as a warning, not a throw', () => {
    const tampered = minimalBACSheet.map((row) => row.slice());
    // Bump Saldo Final so the check fails (1,200 → 1,300).
    tampered[6] = ['Saldo Final', '1,300.00', null, null, null, null, null, null, null, null];

    const result = parseBACSheet(tampered);
    expect(result.integrity.ok).toBe(false);
    expect(result.integrity.diffMinor).toBe(-10000n);
    expect(result.warnings.some((w) => w.startsWith('Balance integrity'))).toBe(true);
  });

  it('throws on a sheet with no recognizable column-header row', () => {
    expect(() => parseBACSheet([['hello', 'world']])).toThrow(BACParseError);
  });

  it.each([
    'Cuenta',
    'No. de Cuenta',
    'No Cuenta',
    'N° Cuenta',
    'Núm. Cuenta',
    'Número de Cuenta',
    'Producto',
  ])('accepts "%s" as the account-number label', (label) => {
    const sheet = minimalBACSheet.map((row) => row.slice());
    sheet[2] = [label, '100412600', null, null, null, null, null, null, null, null];
    const result = parseBACSheet(sheet);
    expect(result.header.accountNumber).toBe('100412600');
    expect(result.warnings).not.toContain('Account number not found in header preamble.');
  });

  it('still rejects "Estado de Cuenta" as the account-number label', () => {
    const result = parseBACSheet(minimalBACSheet);
    // "Estado de Cuenta" sits at row 0 as the doc title — must not capture it.
    expect(result.header.accountNumber).toBe('100412600');
  });

  it('parses real BAC layout: Nombre/Producto/Saldo en Libros', () => {
    // Mirrors the actual BAC export header (col 0 left side, col 4 right).
    // Saldo Inicial 100.00 + Crédito 50.50 - Débito 0 = Saldo en Libros 150.50
    const sheet: (string | null)[][] = [
      [null, null, null, null, null, null, null, null, null, null],
      ['DETALLE DE MOVIMIENTOS DEL PERÍODO', null, null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null, null, null],
      ['Encabezado', null, null, null, null, null, null, null, null, null],
      ['Nombre', 'JUNTO SOLUCIONES, S.A.', null, null, 'Saldo Inicial', null, null, '100.00', null, null],
      ['Producto', '100412600', null, 'USD', 'Saldo en Libros', null, null, '150.50', null, null],
      ['Fecha', '22/04/2026  09:57:29', null, null, 'Retenidos y diferidos', null, null, '0.00', null, null],
      ['Mensaje', null, null, null, 'Saldo Disponible', null, null, '150.50', null, null],
      [null, null, null, null, null, null, null, null, null, null],
      ['Fecha', 'Referencia', null, 'Código', 'Descripción', null, 'Débitos', 'Créditos', 'Balance', null],
      ['05/04/2026', 'REF001', null, 'PR', 'Tef DCD de Jorge Miguel Diaz P', null, '', '50.50', '150.50', null],
    ];
    const result = parseBACSheet(sheet);
    expect(result.header.accountNumber).toBe('100412600');
    expect(result.header.accountHolder).toBe('JUNTO SOLUCIONES, S.A.');
    expect(result.header.saldoInicialMinor).toBe(10000n);
    expect(result.header.saldoFinalMinor).toBe(15050n);
    expect(result.integrity.ok).toBe(true);
    expect(result.warnings).not.toContain('Account number not found in header preamble.');
  });

  it('extracts leading digits when Producto cell merges number + currency', () => {
    const sheet = minimalBACSheet.map((row) => row.slice());
    sheet[2] = ['Producto', '100412600    USD', null, null, null, null, null, null, null, null];
    const result = parseBACSheet(sheet);
    expect(result.header.accountNumber).toBe('100412600');
  });

  it('does not match "Saldo Disponible" as saldoFinal', () => {
    const sheet = minimalBACSheet.map((row) => row.slice());
    // Replace Saldo Final with Saldo Disponible — should leave saldoFinalMinor at 0
    // and integrity.ok=false, but no false-positive on the regex.
    sheet[6] = ['Saldo Disponible', '999.00', null, null, null, null, null, null, null, null];
    const result = parseBACSheet(sheet);
    expect(result.header.saldoFinalMinor).toBe(0n);
    expect(result.integrity.ok).toBe(false);
  });
});
