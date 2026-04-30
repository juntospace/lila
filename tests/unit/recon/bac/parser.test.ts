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

  it.each(['Cuenta', 'No. de Cuenta', 'No Cuenta', 'N° Cuenta', 'Núm. Cuenta', 'Número de Cuenta'])(
    'accepts "%s" as the account-number label',
    (label) => {
      const sheet = minimalBACSheet.map((row) => row.slice());
      sheet[2] = [label, '100412600', null, null, null, null, null, null, null, null];
      const result = parseBACSheet(sheet);
      expect(result.header.accountNumber).toBe('100412600');
      expect(result.warnings).not.toContain('Account number not found in header preamble.');
    },
  );

  it('still rejects "Estado de Cuenta" as the account-number label', () => {
    const result = parseBACSheet(minimalBACSheet);
    // "Estado de Cuenta" sits at row 0 as the doc title — must not capture it.
    expect(result.header.accountNumber).toBe('100412600');
  });
});
