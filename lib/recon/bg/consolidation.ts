// Statement consolidation engine for Banco General (Layouts A, B, C).
// Merges multiple exports into ONE canonical series of movements with balance chain verification.

import type {
  BgCanonicalMovement,
  BgConsolidatedExtracts,
  BgParsedStatement,
} from "./types";
import { round2 } from "./parsers/utils";

export const BG_DEFAULT_ACCOUNT_NUMBER = "03-43-01-106691-6";

function dateRange(startStr: string, endStr: string): string[] {
  const dates: string[] = [];
  const cur = new Date(`${startStr}T00:00:00Z`);
  const end = new Date(`${endStr}T00:00:00Z`);

  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

export function consolidateStatements(
  statements: BgParsedStatement[],
  expectedAccount: string | null = BG_DEFAULT_ACCOUNT_NUMBER,
  alerts: string[] = [],
): BgConsolidatedExtracts {
  let accountNumber = expectedAccount;
  let companyName: string | null = null;

  for (const st of statements) {
    if (st.accountNumber) {
      if (accountNumber && st.accountNumber !== accountNumber) {
        alerts.push(
          `[ACCOUNT] ${st.filename} belongs to account ${st.accountNumber} ≠ ${accountNumber}: file ignored`,
        );
        st.isIgnored = true;
      }
      accountNumber = accountNumber || st.accountNumber;
    }
    companyName = companyName || st.companyName;
  }

  interface DayBucket {
    rows: Array<{
      date: string;
      code: string;
      description: string;
      debitMinor: bigint | null;
      creditMinor: bigint | null;
      balanceMinor: bigint | null;
      ref1: string;
      ref2: string;
      ref3?: string;
      ref4?: string;
    }>;
    signature: Array<[number, number]>; // [signedDelta, balanceFloat]
    sources: string[];
  }

  const daysMap: Map<string, DayBucket> = new Map();
  const quarantinedDays: Set<string> = new Set();

  for (const st of statements) {
    if (st.isIgnored) continue;

    const groupedByDay: Map<string, typeof st.rows> = new Map();
    for (const r of st.rows) {
      const list = groupedByDay.get(r.postedDate) || [];
      list.push(r);
      groupedByDay.set(r.postedDate, list);
    }

    for (const [day, dayRows] of groupedByDay.entries()) {
      const signature: Array<[number, number]> = dayRows.map((r) => {
        const cred = r.creditMinor ? Number(r.creditMinor) / 100 : 0;
        const deb = r.debitMinor ? Number(r.debitMinor) / 100 : 0;
        const bal = r.balanceMinor ? Number(r.balanceMinor) / 100 : 0;
        return [round2(cred - deb), bal];
      });

      if (!daysMap.has(day)) {
        daysMap.set(day, {
          rows: dayRows.map((r) => ({ ...r, date: r.postedDate })),
          signature,
          sources: [st.filename],
        });
        continue;
      }

      const existing = daysMap.get(day)!;
      const isNewShorterOrEqual = signature.length <= existing.signature.length;
      const [shorterSig, longerSig] = isNewShorterOrEqual
        ? [signature, existing.signature]
        : [existing.signature, signature];

      // Prefix check: shorter signature must match the prefix of the longer signature exactly
      let isPrefix = true;
      for (let i = 0; i < shorterSig.length; i++) {
        if (
          Math.abs(shorterSig[i][0] - longerSig[i][0]) > 0.005 ||
          Math.abs(shorterSig[i][1] - longerSig[i][1]) > 0.005
        ) {
          isPrefix = false;
          break;
        }
      }

      if (!isPrefix) {
        quarantinedDays.add(day);
        alerts.push(
          `[SNAPSHOT CONFLICT] ${day}: ${st.filename} does not match ${existing.sources.join(", ")} — day is quarantined`,
        );
        continue;
      }

      if (signature.length > existing.signature.length) {
        // New version is longer: it takes precedence, preserving existing enrichments
        const newRows = dayRows.map((r) => ({ ...r, date: r.postedDate }));
        for (let i = 0; i < existing.rows.length; i++) {
          const oldRow = existing.rows[i];
          if (!newRows[i].ref1 && oldRow.ref1) newRows[i].ref1 = oldRow.ref1;
          if (!newRows[i].ref2 && oldRow.ref2) newRows[i].ref2 = oldRow.ref2;
          if (!newRows[i].code && oldRow.code) newRows[i].code = oldRow.code;
        }
        existing.rows = newRows;
        existing.signature = signature;
      } else {
        // Existing is same length or longer: enrich with any new ref1, ref2, code
        for (let i = 0; i < dayRows.length; i++) {
          const newRow = dayRows[i];
          if (!existing.rows[i].ref1 && newRow.ref1) existing.rows[i].ref1 = newRow.ref1;
          if (!existing.rows[i].ref2 && newRow.ref2) existing.rows[i].ref2 = newRow.ref2;
          if (!existing.rows[i].code && newRow.code) existing.rows[i].code = newRow.code;
        }
      }

      existing.sources.push(st.filename);
    }
  }

  // Declared coverage
  const coverageDays: Set<string> = new Set();
  const provisionalDays: Set<string> = new Set();

  for (const st of statements) {
    if (st.isIgnored || !st.startDate || !st.endDate) continue;
    for (const d of dateRange(st.startDate, st.endDate)) {
      coverageDays.add(d);
    }
    if (st.downloadedAt) {
      const downDate = st.downloadedAt.toISOString().slice(0, 10);
      if (downDate <= st.endDate) {
        provisionalDays.add(st.endDate);
      }
    }
  }

  // Remove provisional flag if another file covers past that day
  for (const d of Array.from(provisionalDays)) {
    const isCoveredPast = statements.some(
      (st) =>
        !st.isIgnored &&
        st.startDate &&
        st.endDate &&
        st.endDate > d &&
        st.startDate <= d,
    );
    if (isCoveredPast) {
      provisionalDays.delete(d);
    }
  }

  // Remove quarantined days from coverage
  for (const d of quarantinedDays) {
    coverageDays.delete(d);
  }

  // Build canonical movement series
  const sortedDays = Array.from(daysMap.keys()).sort();
  const movements: BgCanonicalMovement[] = [];

  for (const day of sortedDays) {
    if (quarantinedDays.has(day)) continue;
    const bucket = daysMap.get(day)!;
    bucket.rows.forEach((r, idx) => {
      const debit = r.debitMinor ? Number(r.debitMinor) / 100 : null;
      const credit = r.creditMinor ? Number(r.creditMinor) / 100 : null;
      const balance = r.balanceMinor ? Number(r.balanceMinor) / 100 : null;
      movements.push({
        uid: `mov#${day}#${String(idx).padStart(3, "0")}`,
        date: day,
        indexInDay: idx,
        code: r.code,
        description: r.description,
        debitMinor: r.debitMinor,
        creditMinor: r.creditMinor,
        balanceMinor: r.balanceMinor,
        debit,
        credit,
        balance,
        ref1: r.ref1,
        ref2: r.ref2,
      });
    });
  }

  // Balance chain & continuity verification
  let prevBalance: number | null = null;
  let prevDay: string | null = null;

  for (const m of movements) {
    const delta = round2((m.credit || 0) - (m.debit || 0));
    if (prevBalance != null && m.balance != null) {
      const expected = round2(prevBalance + delta);
      if (Math.abs(expected - m.balance) > 0.005) {
        if (prevDay === m.date) {
          alerts.push(
            `[BALANCE CHAIN] ${m.uid}: expected ${expected.toLocaleString("en-US", { minimumFractionDigits: 2 })}, file ${m.balance.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
          );
        } else {
          // Check if intermediate days are all covered
          const nextDate = new Date(`${prevDay}T00:00:00Z`);
          nextDate.setUTCDate(nextDate.getUTCDate() + 1);
          const nextDayStr: string = nextDate.toISOString().slice(0, 10);
          const range = dateRange(nextDayStr, m.date);
          const isFullyCovered = range.every((d) => coverageDays.has(d));
          if (nextDayStr === m.date || isFullyCovered) {
            alerts.push(
              `[BALANCE GAP] between ${prevDay} and ${m.date}: close ${prevBalance.toLocaleString("en-US", { minimumFractionDigits: 2 })} + ${delta.toLocaleString("en-US", { minimumFractionDigits: 2 })} ≠ ${m.balance.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
            );
          }
        }
      }
    }
    prevBalance = m.balance;
    prevDay = m.date;
  }

  return {
    accountNumber,
    companyName,
    movements,
    coverageDays,
    provisionalDays,
    quarantinedDays,
  };
}
