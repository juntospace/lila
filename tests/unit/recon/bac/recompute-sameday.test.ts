import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { isSameDayBatchCompensated } from '@/lib/recon/bac/recompute';
import { parseBACSheet } from '@/lib/recon/bac';

describe('isSameDayBatchCompensated', () => {
  it('returns true when saldo_diferido_minor == 0 regardless of time of day (Darwins / Operations rule)', () => {
    // 09:57:29 Panama time (morning reconciliation)
    const morningPanama = '2026-04-22T09:57:29-05:00';
    expect(isSameDayBatchCompensated(morningPanama, 0n)).toBe(true);
    expect(isSameDayBatchCompensated(morningPanama, '0')).toBe(true);

    // 10:59:00 Panama time
    const midMorningPanama = '2026-04-22T10:59:00-05:00';
    expect(isSameDayBatchCompensated(midMorningPanama, 0n)).toBe(true);

    // 14:15:00 Panama time
    const earlyAfternoon = '2026-04-22T14:15:00-05:00';
    expect(isSameDayBatchCompensated(earlyAfternoon, 0n)).toBe(true);

    // Even if statementDownloadedAt is not present, saldo_diferido == 0 proves bank settled all items
    expect(isSameDayBatchCompensated(null, 0n)).toBe(true);
  });

  it('returns false whenever saldo_diferido_minor > 0 (pending in-flight clearings)', () => {
    const morningPanama = '2026-04-22T09:57:29-05:00';
    expect(isSameDayBatchCompensated(morningPanama, 50000n)).toBe(false);

    const afternoonPanama = '2026-04-22T14:45:00-05:00';
    expect(isSameDayBatchCompensated(afternoonPanama, 50000n)).toBe(false);
    expect(isSameDayBatchCompensated(afternoonPanama, 100n)).toBe(false);
  });

  it('falls back to timestamp cutoff when saldo_diferido_minor is null/undefined', () => {
    const morningPanama = '2026-04-22T09:57:29-05:00';
    expect(isSameDayBatchCompensated(morningPanama, null)).toBe(false);
    expect(isSameDayBatchCompensated(morningPanama, undefined)).toBe(false);

    const afternoonPanama = '2026-04-22T14:45:00-05:00';
    expect(isSameDayBatchCompensated(afternoonPanama, null)).toBe(true);
    expect(isSameDayBatchCompensated(afternoonPanama, undefined)).toBe(true);
  });

  it('correctly parses the real 16-Oct statement and marks same-day compensated', () => {
    if (!fs.existsSync('/tmp/16oct.xls')) return;
    const bytes = fs.readFileSync('/tmp/16oct.xls');
    const wb = XLSX.read(bytes, { type: 'buffer', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as unknown[][];
    const parsed = parseBACSheet(matrix);

    expect(parsed.header.saldoInicialMinor).toBe(936338n);
    expect(parsed.header.saldoFinalMinor).toBe(1321133n);
    expect(parsed.header.saldoDisponibleMinor).toBe(1321133n);
    expect(parsed.header.saldoDiferidoMinor).toBe(0n);
    expect(parsed.header.statementDownloadedAt).toBe('2026-10-16T21:38:39.000Z');
    expect(parsed.integrity.ok).toBe(true);

    // Must qualify as same-day compensated!
    expect(
      isSameDayBatchCompensated(
        parsed.header.statementDownloadedAt,
        parsed.header.saldoDiferidoMinor,
      ),
    ).toBe(true);
  });
});

