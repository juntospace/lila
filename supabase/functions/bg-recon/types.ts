// Core TypeScript domain models and schemas for Banco General reconciliation.
// All domain entities, states, database columns, and logic use strict English naming.

export type BgBatchStatus =
  | "settled"
  | "settled_no_reversals"
  | "pending"
  | "anomaly";

export type BgItemStatus = "rejected" | "confirmed" | "pending";

export type BgYappyStatus =
  | "received"
  | "in_transit"
  | "pending"
  | "anomaly"
  | "other";

export type BgIncomingStatus = "received" | "unassigned" | "non_loan";

export type BgAssignmentCategory = "loan" | "non_loan" | "other";

export type BgSuggestion = "loan" | "loan_probable";

export type BgPendingTaskType =
  | "missing_statement"
  | "missing_ach_detail"
  | "missing_yappy_report";

// -------------------------------------------------------------
// Parsed File Representations
// -------------------------------------------------------------

export interface BgStatementRow {
  postedDate: string; // ISO YYYY-MM-DD
  code: string; // "2627", "93", "48", "40", etc.
  description: string;
  debitMinor: bigint | null;
  creditMinor: bigint | null;
  balanceMinor: bigint | null;
  ref1: string;
  ref2: string;
  ref3?: string;
  ref4?: string;
}

export interface BgParsedStatement {
  fileType: "statement";
  filename: string;
  layoutTitle: string; // "BGPExcelReport" | "BGPCheckingMovementsExcel" | "ReferencedReport"
  accountNumber: string | null;
  companyName: string | null;
  startDate: string | null; // ISO YYYY-MM-DD
  endDate: string | null; // ISO YYYY-MM-DD
  downloadedAt: Date | null;
  rows: BgStatementRow[];
  errors: string[];
  isIgnored?: boolean;
}

export interface BgAchDetailRow {
  routingCode: string;
  accountNumber: string;
  amountMinor: bigint;
  amount: number;
  clientId: string;
  clientName: string;
  addenda: string;
  errorCode: string; // "R01", "R10", etc. (empty string if succeeded)
  errorDescription: string;
}

export interface BgParsedAchDetail {
  fileType: "ach_detail";
  filename: string;
  variant: "A" | "B" | "PDF";
  batchName: string | null;
  batchDateStr: string | null; // YYYYMMDD
  batchDate: string | null; // ISO YYYY-MM-DD
  channel: string | null; // "BG" | "TER"
  isDelinquent: boolean; // "MOROSOS"
  fortnight: number | null; // 15 | 30
  retryCount: number; // 1, 2, 3...
  effectiveDate: string | null; // ISO YYYY-MM-DD
  totalTransactions: number | null;
  succeededTransactions: number | null;
  rejectedTransactions: number | null;
  declaredRejectionsAmountMinor: bigint | null;
  declaredTotalAmountMinor?: bigint | null;
  downloadedAt: Date | null;
  accountNumber?: string | null;
  holderName?: string | null;
  rows: BgAchDetailRow[];
  rejectedSumMinor: bigint;
  rejectedSum: number;
  rejectedRowsCount: number;
  succeededRowsCount: number;
  succeededSumMinor: bigint;
  succeededSum: number;
  errors: string[];
  isUnreadable?: boolean;
  hasConflict?: boolean;
}

export interface BgYappyReportRow {
  date: string; // ISO YYYY-MM-DD
  time: string; // HH:MM:SS
  reference: string;
  clientName: string;
  phoneNumber: string;
  comment: string;
  bankStatus: string; // "Procesado" | "En tránsito" | etc.
  amountMinor: bigint;
  amount: number;
}

export interface BgParsedYappyReport {
  fileType: "yappy";
  filename: string;
  collectionPoint: string | null; // "@financieracrediclaro"
  downloadedAt: Date | null;
  rows: BgYappyReportRow[];
  errors: string[];
}

// -------------------------------------------------------------
// Intermediate & Consolidated Movements
// -------------------------------------------------------------

export interface BgCanonicalMovement {
  uid: string; // "mov#<YYYY-MM-DD>#<index>"
  date: string; // ISO YYYY-MM-DD
  indexInDay: number;
  code: string;
  description: string;
  debitMinor: bigint | null;
  creditMinor: bigint | null;
  balanceMinor: bigint | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
  ref1: string;
  ref2: string;
  batchDateHint?: string | null;
  declaredCount?: number;
  isConsumed?: boolean;
}

export interface BgConsolidatedExtracts {
  accountNumber: string | null;
  companyName: string | null;
  movements: BgCanonicalMovement[];
  coverageDays: Set<string>;
  provisionalDays: Set<string>;
  quarantinedDays: Set<string>;
}

// -------------------------------------------------------------
// Output Reconciled Entities (Snapshot)
// -------------------------------------------------------------

export interface BgReconciledBatch {
  uid: string; // "lote#<yyyymmdd>#<TOKEN>#r<n>" or "lote#<yyyymmdd>#s<k>"
  batchDateStr: string;
  batchName: string | null;
  channel: string | null;
  fortnight: number | null;
  isDelinquent: boolean;
  retryCount: number;
  variant: "A" | "B" | "PDF" | null;
  detailFilename: string | null;
  effectiveDate: string | null;
  creditDate: string | null;
  totalTransactions: number | null;
  succeededTransactions: number | null;
  declaredRejectedTransactions: number | null;
  rejectedRowsCount: number;
  succeededRowsCount: number;
  totalAmount: number | null;
  rejectedAmount: number | null;
  succeededAmount: number | null;
  itemizedSucceededAmount?: number | null;
  status: BgBatchStatus;
  pendingReason: string | null;
  creditMovUid: string | null;
  reversalsMovUids: string[];
}

export interface BgReconciledItem {
  uid: string; // "rz#<yyyymmdd>#<TOKEN>#r<n>#<account>#<amount>#<k>"
  itemType: "COBRO_ACH";
  batchUid: string;
  batchName: string | null;
  effectiveDate: string | null;
  batchChannel: string | null;
  retryCount: number;
  routingCode: string;
  clientAccountNumber: string;
  clientId: string;
  clientName: string;
  amount: number;
  amountMinor: bigint;
  status: BgItemStatus;
  reasonCode: string | null;
  reasonDescription: string | null;
  addenda: string;
  sourceFilename: string;
}

export interface BgReconciledYappyBatch {
  uid: string; // "ypl#<credit_date>#<k>"
  creditDate: string;
  transactionDate: string | null;
  declaredCount: number;
  reportCount: number | null;
  creditAmount: number;
  reportAmount: number | null;
  feeAmount: number | null;
  feeRate: number | null;
  status: "settled" | "pending" | "anomaly";
  pendingReason: string | null;
  creditMovUid: string;
}

export interface BgYappyTransaction extends BgYappyReportRow {
  uid: string; // "yp#<date>#<reference>"
  batchUid: string | null;
  status: BgYappyStatus;
  settlementDate: string | null;
  isConsumed?: boolean;
  reconStatus?: "pending" | "anomaly";
}

export interface BgReconciledIncoming {
  uid: string; // "<date>#m<idx>"
  movUid: string;
  paymentType: "PAGO_CLIENTE";
  date: string;
  channel: string;
  counterpart: string;
  transferReference: string;
  paymentReference: string;
  detectedLoanRef: string;
  description: string;
  amount: number;
  amountMinor: bigint;
  status: BgIncomingStatus;
  category: BgAssignmentCategory | null;
  suggestion: BgSuggestion | null;
  assignmentNotes: string | null;
}

export interface BgOtherDebit {
  uid: string;
  date: string;
  description: string;
  amount: number;
  category: string;
  paymentReference: string;
}

export interface BgPendingTask {
  taskType: BgPendingTaskType;
  missingItem: string;
  details: string;
  affectsUid: string;
  amount: number | null;
}

export interface BgReconControls {
  filesReadCount: number;
  coveredDaysCount: number;
  quarantinedDays: string[];
  provisionalCoverageDays: string[];
  totalBatchesCount: number;
  settledBatchesCount: number;
  totalYappyBatchesCount: number;
  settledYappyBatchesCount: number;
  batchesConservation: "OK" | "FAIL";
  incomingCount: number;
  incomingTotalAmount: number;
  unassignedCount: number;
  unassignedTotalAmount: number;
  pendingAssignmentCount: number;
  pendingAssignmentTotalAmount: number;
}

export interface BgOtherAccountResponse {
  filename: string;
  accountNumber: string | null;
  holderName: string | null;
  effectiveDate: string | null;
  totalTransactions: number | null;
  succeededTransactions: number | null;
  rejectedTransactions: number | null;
  totalAmount: number | null;
  rows: Array<{
    clientId: string;
    clientName: string;
    clientAccountNumber: string;
    amount: number;
    status: string;
    reasonCode: string | null;
    reasonDescription: string | null;
  }>;
}

export interface BgReconciliationSnapshot {
  version: "ccbg-2.0";
  generatedFrom: string[];
  accountNumber: string | null;
  companyName: string | null;
  period: [string, string] | null;
  coverageDays: string[];
  yappyReportRange: [string, string] | null;
  batches: BgReconciledBatch[];
  items: BgReconciledItem[];
  yappyBatches: BgReconciledYappyBatch[];
  yappyPayments: BgYappyTransaction[];
  incoming: BgReconciledIncoming[];
  otherDebits: BgOtherDebit[];
  pendingTasks: BgPendingTask[];
  alerts: string[];
  controls: BgReconControls;
  otherAccountResponses: BgOtherAccountResponse[];
}

