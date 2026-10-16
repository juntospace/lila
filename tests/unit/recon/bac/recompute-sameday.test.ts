import { describe, expect, it } from 'vitest';
import { isSameDayBatchCompensated } from '@/lib/recon/bac/recompute';

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
});

