// Test helper to load structured sample fixtures for Banco General reconciliation tests.
// Self-contained in the repository without external filesystem dependencies.

import sampleSheetsJson from "./samples-raw-sheets.json";

import {
  detectAndParseBgFile,
  type BgParsedAchDetail,
  type BgParsedStatement,
  type BgParsedYappyReport,
} from "@/lib/recon/bg";

export interface LoadedBgSamples {
  statements: BgParsedStatement[];
  achDetails: BgParsedAchDetail[];
  yappyReports: BgParsedYappyReport[];
  allFilenames: string[];
}

export function loadBgSamples(options: {
  includePatterns?: string[];
  excludePatterns?: string[];
} = {}): LoadedBgSamples {
  const statements: BgParsedStatement[] = [];
  const achDetails: BgParsedAchDetail[] = [];
  const yappyReports: BgParsedYappyReport[] = [];
  const allFilenames: string[] = [];

  const rawSheets = sampleSheetsJson as Record<
    string,
    { type: string; sheetName?: string; rows?: unknown[][]; text?: string }
  >;

  const filenames = Object.keys(rawSheets).sort();

  for (const filename of filenames) {
    if (filename.startsWith(".") || filename.startsWith("~")) continue;

    if (options.excludePatterns && options.excludePatterns.some((p) => filename.includes(p))) {
      continue;
    }
    if (options.includePatterns && !options.includePatterns.some((p) => filename.includes(p))) {
      continue;
    }

    const item = rawSheets[filename];
    allFilenames.push(filename);

    if (item.type === "pdf") {
      const parsed = detectAndParseBgFile(new Uint8Array(0), filename, item.text);
      if (parsed && parsed.fileType === "ach_detail") {
        achDetails.push(parsed);
      }
      continue;
    }

    if (item.rows) {
      const parsed = detectAndParseBgFile(item.rows, filename);
      if (!parsed) continue;

      if (parsed.fileType === "statement") {
        statements.push(parsed);
      } else if (parsed.fileType === "ach_detail") {
        achDetails.push(parsed);
      } else if (parsed.fileType === "yappy") {
        yappyReports.push(parsed);
      }
    }
  }

  return {
    statements,
    achDetails,
    yappyReports,
    allFilenames,
  };
}
