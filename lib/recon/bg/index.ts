// Public API for Banco General (Crediclaro CCBG v2) Reconciliation Module.

// Core CCBG v2 engine & types
export * from "./types";
export * from "./formatters";
export * from "./consolidation";
export * from "./reconcile";
export * from "./snapshot-sync";
export { parseBgStatement } from "./parsers/statement";
export { parseBgAchDetail } from "./parsers/ach-detail";
export { parseBgYappyReport } from "./parsers/yappy";
export { parseBgAchDetailPdfText } from "./parsers/pdf-detail";
export { detectAndParseBgFile } from "./parsers/sniffer";
export {
  parseAmountFloat,
  parseAmountMinor,
  parseIsoDate,
  extractDownloadTimestamp,
  removeAccents,
} from "./parsers/utils";

// Legacy parser & ingest exports
export * from "./parser";
export * from "./ingest";
