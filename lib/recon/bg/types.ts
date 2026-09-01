// Type definitions for Banco General (Crediclaro CCBG v2) Reconciliation Module.
// All types, properties, and core enum values are defined in English.

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

export type BgSuggestion = "loan" | "loan_probable";

export type BgAssignmentCategory = "loan" | "non_loan" | "other";

export type BgPendingTaskType =
  | "missing_statement"
  | "missing_ach_detail"
  | "missing_yappy_report";

export type BgMovementClass =
  | "BATCH_CREDIT"
  | "BATCH_REVERSAL"
  | "YAPPY_DEP"
  | "YAPPY_FEE"
  | "INCOMING"
  | "OTHER_DEBIT";

// -------------------------------------------------------------
// Statement Types (Movement Series)
// -------------------------------------------------------------

export interface BgStatementRow {
  postedDate: string; // YYYY-MM-DD
  code: string; // "Transacción" or "Referencia"
  description: string;
  debitMinor: bigint | null;
  creditMinor: bigint | null;
  balanceMinor: bigint | null;
  ref1: string; // Reference 1 (Transfer ID)
  ref2: string; // Reference 2 (Payer entered note/loan ref)
  ref3?: string;
  ref4?: string;
}

export interface BgParsedStatement {
  fileType: "statement";
  filename: string;
  layoutTitle: string;
  accountNumber: string | null;
  companyName: string | null;
  startDate: string | null; // YYYY-MM-DD
  endDate: string | null; // YYYY-MM-DD
  downloadedAt: Date | null;
  rows: BgStatementRow[];
  errors: string[];
  isIgnored?: boolean;
}

export interface BgCanonicalMovement {
  uid: string; // mov#YYYY-MM-DD#NNN
  date: string; // YYYY-MM-DD
  indexInDay: number;
  code: string;
  description: string;
  debitMinor: bigint | null;
  creditMinor: bigint | null;
  balanceMinor: bigint | null;
  debit: number | null; // Float dollars for math/views
  credit: number | null;
  balance: number | null;
  ref1: string;
  ref2: string;
  movementClass?: BgMovementClass;
  batchDateHint?: string | null; // yyyymmdd raw
  declaredCount?: number;
  isConsumed?: boolean;
}

export interface BgConsolidatedExtracts {
  accountNumber: string | null;
  companyName: string | null;
  movements: BgCanonicalMovement[];
  coverageDays: Set<string>; // YYYY-MM-DD
  provisionalDays: Set<string>;
  quarantinedDays: Set<string>;
}

// -------------------------------------------------------------
// ACH Batch Detail Types
// -------------------------------------------------------------

export interface BgAchDetailRow {
  routingCode: string;
  accountNumber: string;
  amountMinor: bigint;
  amount: number;
  clientId: string;
  clientName: string;
  addenda: string;
  errorCode: string; // "R01", "R10", etc.
  errorDescription: string;
}

export interface BgParsedAchDetail {
  fileType: "ach_detail";
  filename: string;
  variant: "A" | "B" | "PDF";
  batchName: string | null;
  batchDateStr: string | null; // raw yyyymmdd
  batchDate: string | null; // validated ISO YYYY-MM-DD
  channel: string | null; // "TER", "BG", etc.
  isDelinquent: boolean;
  fortnight: number | null; // 15, 30
  retryCount: number; // 1, 2, 3...
  effectiveDate: string | null; // YYYY-MM-DD
  totalTransactions: number | null;
  succeededTransactions: number | null;
  rejectedTransactions: number | null;
  declaredRejectionsAmountMinor: bigint | null;
  declaredTotalAmountMinor?: bigint | null;
  downloadedAt: Date | null;
  rows: BgAchDetailRow[];
  rejectedSumMinor: bigint;
  rejectedSum: number;
  rejectedRowsCount: number;
  succeededRowsCount: number;
  succeededSumMinor: bigint;
  succeededSum: number;
  accountNumber?: string | null;
  holderName?: string | null;
  errors: string[];
  isUnreadable?: boolean;
  hasConflict?: boolean;
}

// -------------------------------------------------------------
// Yappy Report Types
// -------------------------------------------------------------

export interface BgYappyReportRow {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM AM/PM
  reference: string;
  clientName: string;
  phoneNumber: string;
  comment: string;
  bankStatus: string; // "Procesado", "En tránsito", etc.
  amountMinor: bigint;
  amount: number;
}

export interface BgParsedYappyReport {
  fileType: "yappy";
  filename: string;
  collectionPoint: string | null; // e.g. "@financieracrediclaro"
  downloadedAt: Date | null;
  rows: BgYappyReportRow[];
  errors: string[];
}

export interface BgYappyTransaction extends BgYappyReportRow {
  uid: string; // yp#YYYY-MM-DD#<reference>
  batchUid: string | null;
  status: BgYappyStatus;
  settlementDate: string | null; // YYYY-MM-DD
  isConsumed: boolean;
  reconStatus?: BgYappyStatus;
}

// -------------------------------------------------------------
// Reconciled Entities (Snapshot output)
// -------------------------------------------------------------

export interface BgReconciledBatch {
  uid: string; // lote#<yyyymmdd>#<TOKEN>#r<reintento> or lote#<yyyymmdd>#s<k>
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
  succeededRowsCount?: number;
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
  uid: string; // rz#<yyyymmdd>#<TOKEN>#r<n>#<cuenta>#<monto>#<k>
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
  reasonCode: string | null; // "R01", "R10", etc.
  reasonDescription: string | null;
  addenda: string;
  sourceFilename: string;
}

export interface BgReconciledYappyBatch {
  uid: string; // ypl#<credit_date>#<k>
  creditDate: string;
  transactionDate: string | null;
  declaredCount: number;
  reportCount: number | null;
  creditAmount: number;
  reportAmount: number | null;
  feeAmount: number | null;
  feeRate: number | null;
  status: BgBatchStatus;
  pendingReason: string | null;
  creditMovUid: string | null;
}

export interface BgReconciledIncoming {
  uid: string; // YYYY-MM-DD#mNNN
  movUid: string; // mov#YYYY-MM-DD#NNN
  paymentType: "PAGO_CLIENTE";
  date: string; // YYYY-MM-DD
  channel: string; // "Transfer BG (web)", "Transfer BG (mobile)", "ACH", "ACH Xpress", "Deposit", "Other"
  counterpart: string;
  transferReference: string;
  paymentReference: string;
  detectedLoanRef: string; // "CAPASU00004006"
  description: string;
  amount: number;
  amountMinor: bigint;
  status: BgIncomingStatus;
  category: BgAssignmentCategory | null;
  suggestion: BgSuggestion | null;
  assignmentNotes: string | null;
  assignedBy?: string | null;
  assignedAt?: string | null;
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
    status: "REJECTED" | "CONFIRMED";
    reasonCode: string | null;
    reasonDescription: string | null;
  }>;
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

