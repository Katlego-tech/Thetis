export type RegistryStatus =
  | "not_submitted"
  | "draft"
  | "awaiting_signatures"
  | "submitted"
  | "confirmed"
  | "finalized"
  | "failed"
  | "outcome_unknown";
export type CustodyState =
  | "Stored"
  | "Awaiting departure"
  | "In transit"
  | "Partly arrived"
  | "Arrived"
  | "Loaded"
  | "Collected";
export type FinanceState = "Available" | "Pledged" | "Recovery" | "External hand-off" | "Repaid";
export type RestrictionState = "Normal" | "Review required" | "Disputed" | "Frozen";
export type EvidenceStatus =
  | "Uploaded"
  | "Extracted draft"
  | "Human-attested"
  | "Superseded"
  | "Revoked"
  | "Expired";
export type PaymentStatus = "reported_by_buyer" | "attested_by_lender" | "rejected";
export type ReleaseCase =
  | "sale-2000t-400k"
  | "sale-2000t-210k-refused"
  | "sale-2000t-210k-topup-30k";

export interface Registry {
  status: RegistryStatus;
}
export interface Organisation {
  id: string;
  name: string;
  role: string;
}
export interface Context {
  organisationId: string;
  role: string;
  organisation: Organisation;
}
export interface Site {
  id: string;
  name: string;
  kind: string;
}
export interface LotView {
  id: string;
  mineral: string;
  gradeClass: string;
  quantityKg: bigint;
  site: Site;
  owner: Organisation;
  custodian: Organisation;
  custody: CustodyState;
  finance: FinanceState;
  restriction: RestrictionState;
  position: {
    positionQuantityKg: bigint;
    activeLockedQuantityKg: bigint;
    separatelyReservedQuantityKg: bigint;
    availableKg: bigint;
  };
  locks: { lender: Organisation; lockedQuantityKg: bigint }[];
  discrepancyKg: bigint;
  registry: Registry;
  loan: {
    principalMinor: bigint;
    bookedInterestMinor: bigint;
    bookedFeesMinor: bigint;
    debtMinor: bigint;
    status: "Active" | "Recovery" | "ExternalHandoff" | "Closed";
    lender: Organisation;
    registry: Registry;
  };
  valuation: {
    valuePerKgMinor: bigint;
    haircutBps: bigint;
    maxLtvBps: bigint;
    validUntil: string;
    eligibleValueMinor: bigint;
    ltvBps: bigint;
    registry: Registry;
  };
  custodyTimeline: {
    id: string;
    kind: "intake" | "handover" | "observation";
    site: Site;
    quantityKg: bigint;
    by: Organisation[];
    at: string;
    registry: Registry;
  }[];
  evidence: {
    id: string;
    kind: string;
    issuer: Organisation;
    status: EvidenceStatus;
    file: null;
  }[];
  releases: {
    id: string;
    buyer: Organisation;
    soldLockedQuantityKg: bigint;
    payment: PaymentStatus;
    registry: Registry;
  }[];
}
export interface WorkItemView {
  id: string;
  lot: { id: string; gradeClass: string; site: Site; quantityKg: bigint };
  action: string;
  nextActor: Organisation;
  blocker: string;
  deadline: string | null;
  href: string; // the screen the primary action opens
  amountMinor: bigint | null; // the money this item is about, when it is about money
  quantityKg: bigint | null; // the quantity this item is about
  registry: Registry;
}
export interface ReleaseView {
  id: string;
  lot: LotView;
  seller: Organisation;
  buyer: Organisation;
  lender: Organisation;
  case: ReleaseCase;
  currency: string;
  inputs: import("@thetis/domain").ReleaseInput;
  preview: import("@thetis/domain").ReleasePreview | { error: { code: string; message: string } };
  payment: PaymentStatus;
  registry: Registry;
  expiresAt: string;
}
export interface ExceptionView {
  id: string;
  kind: string;
  owner: Organisation;
  lot: { id: string };
  reason: string;
  nextAction: string;
  registry: Registry;
}
