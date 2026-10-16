// Core domain types for Portfolio Analytics, Board Report, and Collections Plan

export type PortfolioSegment =
  | "Adelantos"
  | "Personal con Garantía"
  | "Personal sin Garantía";

export type PortfolioBucket =
  | "Al día"
  | "1-30"
  | "31-60"
  | "61-90"
  | "91-180"
  | "181-365"
  | "365+";

export interface PortfolioEntity {
  id: string;
  code: string;
  displayName: string;
  legalName: string;
  isActive: boolean;
}

export interface PortfolioPolicy {
  id?: string | null;
  version: string;
  effectiveFrom: string;
  handoverDate: string; // YYYY-MM-DD (Default 2025-06-01)
  coUnsecured: number; // Default 180
  coSecured: number; // Default 360
  coUnsecuredDpd: number; // Alias of coUnsecured (Default 180)
  coSecuredDpd: number; // Alias of coSecured (Default 360)
  bucketBins: number[]; // [-1, 0, 30, 60, 90, 180, 365, 1e9]
  bucketNames: PortfolioBucket[];
  provRates: number[]; // [0.01, 0.05, 0.15, 0.25, 0.50, 0.90, 1.00]
  realMethods: string[];
  adminMethods: string[];
  notes?: string | null;
}

export interface PortfolioIngestBatch {
  id?: string;
  snapshotId?: string;
  sha256Loans: string;
  sha256Repayments: string | null;
  rowsLoans: number;
  rowsRepayments: number;
  sumBalanceSource: number;
  sumBalanceIngested: number;
  futurePaymentsExcluded: number;
  cashAheadCount: number;
  adminExcludedCount: number;
  adminExcludedAmount: number;
  unknownMethods: string[];
  missingCustomFields: string[];
  missingReleasedDateCount: number;
  uploadedBy?: string | null;
  createdAt?: string;
}

export interface EnrichedLoan {
  loanId: string;
  loanNumber: string;
  fullName: string;
  borrowerMobile: string;
  product: string;
  segment: PortfolioSegment;
  segmentIdx: number; // 0: Adelantos, 1: Personal con Garantía, 2: Personal sin Garantía
  secured: boolean;
  balance: number;
  dpd: number; // Adjusted (0 if cashAhead)
  dpdLoandisk: number; // Preserved original
  bucket: PortfolioBucket;
  bucketIdx: number; // 0..6
  cashAhead: boolean;
  isOpen: boolean;
  releasedDate: string | null; // YYYY-MM-DD
  statusRaw: string;
  pastDue: number;
  pendingDue: number;
  totalDueAmount: number;
  loanDuration: string;
  installmentsCount: number | null;
  repaymentCycle: string;
  cycleType: number; // 0: monthly, 1: daily
  lastPaymentDate: string | null; // YYYY-MM-DD
  lastPaymentAmount: number;
  pg: string | null; // Préstamo Garantizado ('Si' | 'No')
  tg: string | null; // Tipo de Garantía ('Automóvil' | 'Moto' | 'NA')
  tc: string | null; // Tipo de Cartera ('Heredada' | 'Vigente')
  gc: string | null; // Gestor de Cobro
  mr: string | null; // Motor de Riesgo (Adelantos)
  comboKey: string;
  raw: Record<string, string>;
}

export interface EnrichedRepayment {
  repaymentId: string;
  loanId: string;
  collectionDate: string; // YYYY-MM-DD
  principalAmount: number;
  interestAmount: number;
  penaltyAmount: number;
  feesAmount: number;
  totalAmount: number;
  ingresosAmount: number; // Interest + Penalty + Fees
  methodRaw: string;
  isReal: boolean;
  isAdmin: boolean;
  isUnknownMethod: boolean;
  raw: Record<string, string>;
}

export interface PortfolioSnapshot {
  id: string;
  entityId: string;
  snapshotDate: string; // YYYY-MM-DD
  asOfDate: string; // YYYY-MM-DD
  policyId?: string | null;
  totalOpenBalance: number;
  totalOpenLoans: number;
  cer30Balance: number;
  cer30Percentage: number;
  cer90Balance: number;
  cer90Percentage: number;
  totalCollectedHandover: number;
  cashAheadCount: number;
  futurePaymentsExcludedCount: number;
  hasRepayments: boolean;
  sourceFiles: Record<string, unknown>;
  status: "completed" | "in_progress" | "loading" | "failed";
  createdAt?: string;
  updatedAt?: string;
}

export interface ActionPlanItem {
  prio: 1 | 2 | 3;
  score: number;
  loanno: string;
  cliente: string;
  cel: string;
  seg: PortfolioSegment;
  producto: string;
  dpd: number;
  tramo: PortfolioBucket;
  saldo: number;
  cura: number;
  ultpago: string;
  motivo: string;
}

export interface ActionPlanSummary {
  abiertos: number;
  saldo: number;
  accionables: number;
  castigo_excl: number;
  castigo_saldo: number;
  prev_date: string | null;
  top40_cura: number;
  top40_saldo: number;
}
