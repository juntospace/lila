import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { isSameDayBatchCompensated } from '@/lib/recon/bac/recompute';
import { parseBACSheet } from '@/lib/recon/bac';

describe('isSameDayBatchCompensated', () => {
  it('returns false when statementDownloadedAt is null or undefined', () => {
    expect(isSameDayBatchCompensated(null, 0n)).toBe(false);
    expect(isSameDayBatchCompensated(undefined, 0n)).toBe(false);
    expect(isSameDayBatchCompensated('invalid-date', 0n)).toBe(false);
  });

  it('returns false when download time in Panama is before 14:30 (morning/early afternoon)', () => {
    // 09:57:29 Panama time (UTC-5) -> 14:57:29 UTC
    const morningPanama = '2026-04-22T09:57:29-05:00';
    expect(isSameDayBatchCompensated(morningPanama, 0n)).toBe(false);

    // 11:30:00 Panama time
    const lateMorningPanama = '2026-04-22T11:30:00-05:00';
    expect(isSameDayBatchCompensated(lateMorningPanama, 0n)).toBe(false);

    // 14:15:00 Panama time (15 mins before cutoff)
    const justBeforeCutoff = '2026-04-22T14:15:00-05:00';
    expect(isSameDayBatchCompensated(justBeforeCutoff, 0n)).toBe(false);
  });

  it('returns false when download time is after 14:30 but saldo_diferido_minor > 0', () => {
    // 14:45:00 Panama time, but $500.00 still retained/deferred
    const afternoonPanama = '2026-04-22T14:45:00-05:00';
    expect(isSameDayBatchCompensated(afternoonPanama, 50000n)).toBe(false);
    expect(isSameDayBatchCompensated(afternoonPanama, 100n)).toBe(false);
    expect(isSameDayBatchCompensated(afternoonPanama, null)).toBe(false);
    expect(isSameDayBatchCompensated(afternoonPanama, undefined)).toBe(false);
  });

  it('returns true when download time is >= 14:30 Panama time AND saldo_diferido_minor == 0', () => {
    // Exactly at cutoff: 14:30:00 Panama time
    const exactCutoff = '2026-04-22T14:30:00-05:00';
    expect(isSameDayBatchCompensated(exactCutoff, 0n)).toBe(true);
    expect(isSameDayBatchCompensated(exactCutoff, '0')).toBe(true);

    // Typical afternoon reconciliation: 14:45:00 Panama time
    const afternoon = '2026-04-22T14:45:00-05:00';
    expect(isSameDayBatchCompensated(afternoon, 0n)).toBe(true);

    // Late afternoon: 17:00:00 Panama time
    const lateAfternoon = '2026-04-22T17:00:00-05:00';
    expect(isSameDayBatchCompensated(lateAfternoon, 0n)).toBe(true);
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

