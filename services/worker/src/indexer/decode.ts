// Transaction decoding: from one getTransaction response to the local Thetis invocations, each
// with its decoded events. Every condition the indexer does not recognise is a HaltError; a
// response of the wrong shape is an RpcShapeError (retried, never a halt).

import {
  AccountRole,
  type Decoder,
  getBase58Encoder,
  isOption,
  isSolanaError,
  SOLANA_ERROR__CODECS__ENUM_DISCRIMINATOR_OUT_OF_RANGE,
  unwrapOption,
} from "@solana/kit";
import {
  DocumentKind,
  getAdvanceRecordedEventDecoder,
  getAuthorityDelegatedEventDecoder,
  getAuthorityRevokedEventDecoder,
  getBatchRegisteredEventDecoder,
  getBorrowedEventDecoder,
  getClassRegisteredEventDecoder,
  getCustodianClassAccreditedEventDecoder,
  getCustodyHandedOverEventDecoder,
  getDepositedEventDecoder,
  getDocumentAttestedEventDecoder,
  getDocumentRevokedEventDecoder,
  getFacilityOpenedEventDecoder,
  getLiquidatedEventDecoder,
  getLoadingAcceptedEventDecoder,
  getLoadingIntentCreatedEventDecoder,
  getLoadingRecordedEventDecoder,
  getLoanClosedEventDecoder,
  getLoanHandedOffEventDecoder,
  getLotIssuedEventDecoder,
  getLotSplitEventDecoder,
  getObservationRecordedEventDecoder,
  getOrganisationAccreditedEventDecoder,
  getPauseChangedEventDecoder,
  getPaymentConfirmedEventDecoder,
  getPaymentCorrectedEventDecoder,
  getPledgedEventDecoder,
  getPledgedSoldEventDecoder,
  getPoolOpenedEventDecoder,
  getProtocolInitializedEventDecoder,
  getRelationshipDeclaredEventDecoder,
  getReleaseIntentCreatedEventDecoder,
  getRepaidEventDecoder,
  getRestrictionSetEventDecoder,
  getShipmentCancelledEventDecoder,
  getShipmentPreparedEventDecoder,
  getShortfallAttestedEventDecoder,
  getUnitsRedeemedEventDecoder,
  getUnitsTransferredEventDecoder,
  getValuationSetEventDecoder,
  getWithdrawnEventDecoder,
  HandoverStage,
  identifyThetisEvent,
  identifyThetisInstruction,
  LotState,
  ObservationKind,
  PaymentPurpose,
  parseThetisInstruction,
  Restriction,
  Role,
  ShipmentStatus,
  THETIS_PROGRAM_ADDRESS,
  ThetisEvent,
  ThetisInstruction,
  toI64String,
  toU64String,
} from "@thetis/contracts";
import { HaltError, type HaltReason } from "./errors.ts";
import { checkRawTransaction, type RawInstruction, type RawTransaction } from "./rpc.ts";
import type { JsonValue } from "./store.ts";

const PROGRAM = THETIS_PROGRAM_ADDRESS as string;

export const HANDLED_INSTRUCTIONS = [
  "InitializeProtocol",
  "RegisterClass",
  "AccreditOrganisation",
  "DeclareRelationship",
  "DelegateAuthority",
  "RevokeAuthority",
  "AccreditCustodianClass",
  "Pause",
  "Unpause",
  "AttestDocument",
  "RevokeDocument",
  "IssueLot",
  "Transfer",
  "Split",
  "Redeem",
  "OpenFacility",
  "SetValuation",
  "Pledge",
  "RecordAdvance",
  "ConfirmPayment",
  "Repay",
  "CreateReleaseIntent",
  "SellPledged",
  "Liquidate",
  "CloseLoan",
  "OpenPool",
  "Deposit",
  "Withdraw",
  "Borrow",
  "PrepareShipment",
  "RegisterBatch",
  "CancelShipment",
  "Handover",
  "RecordObservation",
  "CreateLoadingIntent",
  "AcceptLoading",
  "RecordLoading",
  "AttestShortfall",
  "SetRestriction",
] as const;

export type HandledInstruction = (typeof HANDLED_INSTRUCTIONS)[number];

export const HANDLED_EVENTS = [
  "ProtocolInitialized",
  "ClassRegistered",
  "OrganisationAccredited",
  "RelationshipDeclared",
  "AuthorityDelegated",
  "AuthorityRevoked",
  "CustodianClassAccredited",
  "PauseChanged",
  "DocumentAttested",
  "DocumentRevoked",
  "LotIssued",
  "UnitsTransferred",
  "LotSplit",
  "UnitsRedeemed",
  "FacilityOpened",
  "ValuationSet",
  "Pledged",
  "AdvanceRecorded",
  "PaymentConfirmed",
  "PaymentCorrected",
  "Repaid",
  "ReleaseIntentCreated",
  "PledgedSold",
  "Liquidated",
  "LoanClosed",
  "PoolOpened",
  "Deposited",
  "Withdrawn",
  "Borrowed",
  "ShipmentPrepared",
  "BatchRegistered",
  "ShipmentCancelled",
  "CustodyHandedOver",
  "ObservationRecorded",
  "LoadingIntentCreated",
  "LoadingAccepted",
  "LoadingRecorded",
  "LoanHandedOff",
  "ShortfallAttested",
  "RestrictionSet",
] as const;

export type HandledEvent = (typeof HANDLED_EVENTS)[number];

/** An instruction's name, as the generated `ThetisInstruction` object maps it. */
export type InstructionName = Exclude<keyof typeof ThetisInstruction, number>;

/**
 * The position of the `protocol` account in each instruction's account list, from the IDL. Every
 * optional account comes after it, so the position is fixed. It names the protocol instance an
 * instruction belongs to without parsing its arguments.
 */
export const PROTOCOL_ACCOUNT_POSITION: Readonly<Record<InstructionName, number>> = {
  AccreditCustodianClass: 0,
  AccreditOrganisation: 0,
  AttestDocument: 0,
  DeclareRelationship: 0,
  DelegateAuthority: 0,
  InitializeProtocol: 0,
  Pause: 0,
  RegisterClass: 0,
  RevokeAuthority: 0,
  RevokeDocument: 0,
  Unpause: 0,
  AttestShortfall: 1,
  Borrow: 1,
  CancelShipment: 1,
  CloseLoan: 1,
  CreateLoadingIntent: 1,
  CreateReleaseIntent: 1,
  Handover: 1,
  IssueLot: 1,
  Liquidate: 1,
  Pledge: 1,
  PrepareShipment: 1,
  RecordAdvance: 1,
  RecordLoading: 1,
  RecordObservation: 1,
  Redeem: 1,
  RegisterBatch: 1,
  Repay: 1,
  SellPledged: 1,
  SetRestriction: 1,
  Split: 1,
  Transfer: 1,
  Withdraw: 1,
  AcceptLoading: 2,
  ConfirmPayment: 2,
  Deposit: 2,
  OpenFacility: 2,
  OpenPool: 2,
  SetValuation: 2,
};

/** The one event each instruction may emit, and whether it must (live-lending.md §4.1.2). */
const EMITS: Record<
  Exclude<HandledInstruction, "ConfirmPayment" | "RecordLoading">,
  { event: HandledEvent; required: boolean }
> = {
  InitializeProtocol: { event: "ProtocolInitialized", required: true },
  RegisterClass: { event: "ClassRegistered", required: true },
  AccreditOrganisation: { event: "OrganisationAccredited", required: true },
  DeclareRelationship: { event: "RelationshipDeclared", required: true },
  DelegateAuthority: { event: "AuthorityDelegated", required: true },
  RevokeAuthority: { event: "AuthorityRevoked", required: true },
  AccreditCustodianClass: { event: "CustodianClassAccredited", required: true },
  Pause: { event: "PauseChanged", required: false },
  Unpause: { event: "PauseChanged", required: false },
  AttestDocument: { event: "DocumentAttested", required: true },
  RevokeDocument: { event: "DocumentRevoked", required: true },
  IssueLot: { event: "LotIssued", required: true },
  Transfer: { event: "UnitsTransferred", required: true },
  Split: { event: "LotSplit", required: true },
  Redeem: { event: "UnitsRedeemed", required: true },
  OpenFacility: { event: "FacilityOpened", required: true },
  SetValuation: { event: "ValuationSet", required: true },
  Pledge: { event: "Pledged", required: true },
  RecordAdvance: { event: "AdvanceRecorded", required: true },
  Repay: { event: "Repaid", required: true },
  CreateReleaseIntent: { event: "ReleaseIntentCreated", required: true },
  SellPledged: { event: "PledgedSold", required: true },
  Liquidate: { event: "Liquidated", required: true },
  CloseLoan: { event: "LoanClosed", required: true },
  OpenPool: { event: "PoolOpened", required: true },
  Deposit: { event: "Deposited", required: true },
  Withdraw: { event: "Withdrawn", required: true },
  Borrow: { event: "Borrowed", required: true },
  PrepareShipment: { event: "ShipmentPrepared", required: true },
  RegisterBatch: { event: "BatchRegistered", required: true },
  CancelShipment: { event: "ShipmentCancelled", required: true },
  Handover: { event: "CustodyHandedOver", required: true },
  RecordObservation: { event: "ObservationRecorded", required: true },
  CreateLoadingIntent: { event: "LoadingIntentCreated", required: true },
  AcceptLoading: { event: "LoadingAccepted", required: true },
  AttestShortfall: { event: "ShortfallAttested", required: true },
  SetRestriction: { event: "RestrictionSet", required: true },
};

/** The program's MAX_LOADING_LOANS (state.rs): at most four accepted loans per loading. */
export const MAX_LOADING_LOANS = 4;

/**
 * The events an invocation emits, in order, and whether it must emit them (live-custody.md
 * §4.1.2). ConfirmPayment emits PaymentCorrected when it names a `target`, else PaymentConfirmed;
 * RecordLoading emits LoadingRecorded then one LoanHandedOff per (acceptance, loan, lock) triple
 * after its IDL accounts; Pause and Unpause emit PauseChanged or nothing; every other instruction
 * exactly its one event.
 */
export function expectedEvents(invocation: {
  instruction: HandledInstruction;
  accounts: Record<string, string | undefined>;
  remaining: string[];
}): { events: HandledEvent[]; required: boolean } {
  if (invocation.instruction === "ConfirmPayment") {
    return {
      events: [invocation.accounts.target === undefined ? "PaymentConfirmed" : "PaymentCorrected"],
      required: true,
    };
  }
  if (invocation.instruction === "RecordLoading") {
    const k = Math.floor(invocation.remaining.length / 3);
    return {
      events: ["LoadingRecorded", ...Array.from({ length: k }, () => "LoanHandedOff" as const)],
      required: true,
    };
  }
  const emits = EMITS[invocation.instruction];
  return { events: [emits.event], required: emits.required };
}

/** Event field = instruction account. */
const PAIRING: Record<HandledEvent, [field: string, account: string][]> = {
  ProtocolInitialized: [["protocol", "protocol"]],
  ClassRegistered: [["classPolicy", "classPolicy"]],
  OrganisationAccredited: [["organisation", "organisation"]],
  RelationshipDeclared: [
    ["a", "a"],
    ["b", "b"],
  ],
  AuthorityDelegated: [
    ["authority", "authority"],
    ["organisation", "organisation"],
  ],
  AuthorityRevoked: [["authority", "authority"]],
  CustodianClassAccredited: [["custodianClass", "custodianClass"]],
  PauseChanged: [],
  DocumentAttested: [["document", "document"]],
  DocumentRevoked: [["document", "document"]],
  LotIssued: [
    ["lot", "lot"],
    ["owner", "owner"],
    ["intake", "intake"],
  ],
  UnitsTransferred: [
    ["lot", "lot"],
    ["from", "owner"],
    ["to", "recipient"],
  ],
  LotSplit: [
    ["parent", "lot"],
    ["child", "childLot"],
    ["owner", "owner"],
  ],
  UnitsRedeemed: [
    ["lot", "lot"],
    ["owner", "owner"],
  ],
  FacilityOpened: [
    ["facility", "facility"],
    ["lender", "lenderOrg"],
    ["borrower", "borrowerOrg"],
  ],
  ValuationSet: [
    ["valuation", "valuation"],
    ["facility", "facility"],
  ],
  Pledged: [
    ["loan", "loan"],
    ["lock", "lock"],
    ["position", "position"],
    ["lot", "lot"],
  ],
  AdvanceRecorded: [["loan", "loan"]],
  PaymentConfirmed: [
    ["payment", "payment"],
    ["loan", "loan"],
    ["subject", "subject"],
  ],
  PaymentCorrected: [
    ["payment", "payment"],
    ["target", "target"],
    ["loan", "loan"],
  ],
  Repaid: [
    ["loan", "loan"],
    ["payment", "payment"],
    ["pool", "pool"],
  ],
  ReleaseIntentCreated: [
    ["intent", "intent"],
    ["loan", "loan"],
    ["seller", "sellerOrg"],
    ["buyer", "buyerOrg"],
  ],
  PledgedSold: [
    ["intent", "intent"],
    ["loan", "loan"],
    ["payment", "payment"],
    ["lot", "lot"],
    ["sellerPosition", "sellerPosition"],
    ["buyerPosition", "buyerPosition"],
  ],
  Liquidated: [
    ["loan", "loan"],
    ["lock", "lock"],
  ],
  LoanClosed: [
    ["loan", "loan"],
    ["position", "position"],
  ],
  PoolOpened: [
    ["pool", "pool"],
    ["mint", "mint"],
  ],
  Deposited: [
    ["pool", "pool"],
    ["organisation", "depositorOrg"],
    ["wallet", "depositor"],
  ],
  Withdrawn: [
    ["pool", "pool"],
    ["organisation", "depositorOrg"],
    ["wallet", "depositor"],
  ],
  Borrowed: [
    ["loan", "loan"],
    ["pool", "pool"],
  ],
  ShipmentPrepared: [
    ["shipment", "shipment"],
    ["lot", "lot"],
    ["owner", "ownerOrg"],
    ["source", "sourceClass"],
    ["destination", "destinationClass"],
    ["departureDocument", "departureDocument"],
  ],
  BatchRegistered: [
    ["batch", "batch"],
    ["shipment", "shipment"],
  ],
  ShipmentCancelled: [
    ["shipment", "shipment"],
    ["lot", "lot"],
  ],
  CustodyHandedOver: [
    ["handover", "handover"],
    ["batch", "batch"],
    ["shipment", "shipment"],
    ["lot", "lot"],
    ["from", "fromOrg"],
    ["to", "toOrg"],
  ],
  ObservationRecorded: [
    ["batch", "batch"],
    ["shipment", "shipment"],
    ["lot", "lot"],
    ["observer", "observerOrg"],
    ["holder", "holderOrg"],
  ],
  LoadingIntentCreated: [
    ["intent", "intent"],
    ["lot", "lot"],
    ["position", "position"],
    ["owner", "ownerOrg"],
    ["terminal", "terminalOrg"],
  ],
  LoadingAccepted: [
    ["acceptance", "acceptance"],
    ["intent", "intent"],
    ["loan", "loan"],
    ["lender", "lenderOrg"],
  ],
  LoadingRecorded: [
    ["intent", "intent"],
    ["lot", "lot"],
    ["position", "position"],
    ["owner", "ownerOrg"],
    ["terminal", "terminalOrg"],
  ],
  // The loan is the triple's (decodeTransaction below): remaining[3i + 1] for the i-th hand-off.
  LoanHandedOff: [["intent", "intent"]],
  // `batch` is an option on both sides: undefined when the attestation names the whole lot.
  ShortfallAttested: [
    ["incident", "incident"],
    ["lot", "lot"],
    ["inspector", "inspectorOrg"],
    ["batch", "batch"],
  ],
  RestrictionSet: [["lot", "lot"]],
};

const EVENT_DECODERS: Record<HandledEvent, () => Decoder<unknown>> = {
  ProtocolInitialized: getProtocolInitializedEventDecoder,
  ClassRegistered: getClassRegisteredEventDecoder,
  OrganisationAccredited: getOrganisationAccreditedEventDecoder,
  RelationshipDeclared: getRelationshipDeclaredEventDecoder,
  AuthorityDelegated: getAuthorityDelegatedEventDecoder,
  AuthorityRevoked: getAuthorityRevokedEventDecoder,
  CustodianClassAccredited: getCustodianClassAccreditedEventDecoder,
  PauseChanged: getPauseChangedEventDecoder,
  DocumentAttested: getDocumentAttestedEventDecoder,
  DocumentRevoked: getDocumentRevokedEventDecoder,
  LotIssued: getLotIssuedEventDecoder,
  UnitsTransferred: getUnitsTransferredEventDecoder,
  LotSplit: getLotSplitEventDecoder,
  UnitsRedeemed: getUnitsRedeemedEventDecoder,
  FacilityOpened: getFacilityOpenedEventDecoder,
  ValuationSet: getValuationSetEventDecoder,
  Pledged: getPledgedEventDecoder,
  AdvanceRecorded: getAdvanceRecordedEventDecoder,
  PaymentConfirmed: getPaymentConfirmedEventDecoder,
  PaymentCorrected: getPaymentCorrectedEventDecoder,
  Repaid: getRepaidEventDecoder,
  ReleaseIntentCreated: getReleaseIntentCreatedEventDecoder,
  PledgedSold: getPledgedSoldEventDecoder,
  Liquidated: getLiquidatedEventDecoder,
  LoanClosed: getLoanClosedEventDecoder,
  PoolOpened: getPoolOpenedEventDecoder,
  Deposited: getDepositedEventDecoder,
  Withdrawn: getWithdrawnEventDecoder,
  Borrowed: getBorrowedEventDecoder,
  ShipmentPrepared: getShipmentPreparedEventDecoder,
  BatchRegistered: getBatchRegisteredEventDecoder,
  ShipmentCancelled: getShipmentCancelledEventDecoder,
  CustodyHandedOver: getCustodyHandedOverEventDecoder,
  ObservationRecorded: getObservationRecordedEventDecoder,
  LoadingIntentCreated: getLoadingIntentCreatedEventDecoder,
  LoadingAccepted: getLoadingAcceptedEventDecoder,
  LoadingRecorded: getLoadingRecordedEventDecoder,
  LoanHandedOff: getLoanHandedOffEventDecoder,
  ShortfallAttested: getShortfallAttestedEventDecoder,
  RestrictionSet: getRestrictionSetEventDecoder,
};

/** Event fields that hold an enum, by event, with the generated name table of each. */
const ENUM_FIELDS: Partial<Record<HandledEvent, Record<string, Record<number, string>>>> = {
  OrganisationAccredited: { role: Role as unknown as Record<number, string> },
  DocumentAttested: { kind: DocumentKind as unknown as Record<number, string> },
  PaymentConfirmed: { purpose: PaymentPurpose as unknown as Record<number, string> },
  CustodyHandedOver: {
    stage: HandoverStage as unknown as Record<number, string>,
    shipmentStatus: ShipmentStatus as unknown as Record<number, string>,
    lotState: LotState as unknown as Record<number, string>,
  },
  ObservationRecorded: { kind: ObservationKind as unknown as Record<number, string> },
  ShortfallAttested: { restriction: Restriction as unknown as Record<number, string> },
  RestrictionSet: {
    from: Restriction as unknown as Record<number, string>,
    to: Restriction as unknown as Record<number, string>,
  },
};

/**
 * The handover consistency rules (live-custody.md §4.1.2): the indexer decides from these fields
 * whether a handover advances the lot revision, so a contradiction halts here. A shipment's first
 * handover is its first departure; an arrived shipment is an arrival that stored the lot; any other
 * handover leaves the shipment and the lot in transit.
 */
function handoverInconsistency(value: Record<string, unknown>): string | null {
  const name = (names: Record<number, string>, field: string) =>
    names[value[field] as number] ?? String(value[field]);
  const stage = name(HandoverStage as unknown as Record<number, string>, "stage");
  const shipment = name(ShipmentStatus as unknown as Record<number, string>, "shipmentStatus");
  const lot = name(LotState as unknown as Record<number, string>, "lotState");
  if (value.shipmentRevision === 1n) {
    if (stage === "Departure" && shipment === "InTransit" && lot === "InTransit") return null;
    return `CustodyHandedOver is the shipment's first handover (shipment revision 1) but is stage ${stage}, shipment ${shipment}, lot ${lot}; expected Departure, InTransit, InTransit`;
  }
  if (shipment === "Arrived") {
    if (stage === "Arrival" && lot === "Stored") return null;
    return `CustodyHandedOver leaves the shipment Arrived with stage ${stage} and lot ${lot}; expected Arrival and Stored`;
  }
  if (shipment === "InTransit" && lot === "InTransit") return null;
  return `CustodyHandedOver leaves the shipment ${shipment} and the lot ${lot}; expected InTransit and InTransit`;
}

/**
 * The shortfall consistency rule (live-custody.md §4.1.2): outside tolerance a Normal lot always
 * becomes ReviewRequired, so an outside-tolerance shortfall that leaves the lot Normal contradicts
 * the program, and the indexer could not tell whether it moved the lot revision.
 */
function shortfallInconsistency(value: Record<string, unknown>): string | null {
  if (value.withinTolerance === true || value.restriction !== Restriction.Normal) return null;
  return "ShortfallAttested is outside tolerance but leaves the lot Normal; expected ReviewRequired or a stricter restriction";
}

export type DecodedEvent = {
  /** Position of the event line among all Thetis event lines of the transaction, from 0. */
  index: number;
  name: HandledEvent;
  /** The decoder's output (bigints, bytes, enum numbers). */
  value: Record<string, unknown>;
  /** The same fields under the JSON boundary rule, in Codama camelCase. */
  data: Record<string, JsonValue>;
};

export type Invocation = {
  instruction: HandledInstruction;
  /** Instruction account name to address; an absent optional account is undefined. */
  accounts: Record<string, string | undefined>;
  /** The addresses after the IDL-named accounts, in order (live-lending.md §4.1.2). */
  remaining: string[];
  /** The parsed instruction arguments (the generated parser's data). */
  args: Record<string, unknown>;
  events: DecodedEvent[];
};

export type DecodedTransaction = {
  /** Invocations of this stream's instance only. */
  invocations: Invocation[];
  /** THETIS_PROTOCOL when the transaction has a Thetis instruction of this instance, else null. */
  protocol: string | null;
  /** Every Thetis instruction belongs to another protocol instance: recorded, never projected. */
  otherInstance: boolean;
};

export type DecodeContext = { protocol: string };

function halt(
  reason: HaltReason,
  signature: string,
  message: string,
  extra: string[] = [],
): HaltError {
  const named = extra.length > 0 ? ` (${extra.join(", ")})` : "";
  return new HaltError(reason, `decode: ${message}${named}; transaction ${signature}`, signature);
}

const INVOKE = /^Program (\S+) invoke \[(\d+)\]$/;
const FINISHED = /^Program (\S+) (?:success|failed(?:: .*)?)$/;
const DATA = /^Program data: (.*)$/;
const base58 = getBase58Encoder();

function roleOf(index: number, raw: RawTransaction, staticCount: number): AccountRole {
  const header = raw.transaction.message.header;
  if (index >= staticCount) {
    const writableLoaded = raw.meta?.loadedAddresses?.writable.length ?? 0;
    return index < staticCount + writableLoaded ? AccountRole.WRITABLE : AccountRole.READONLY;
  }
  const required = header.numRequiredSignatures;
  const signer = index < required;
  const writable = signer
    ? index < required - header.numReadonlySignedAccounts
    : index < staticCount - header.numReadonlyUnsignedAccounts;
  if (signer) return writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER;
  return writable ? AccountRole.WRITABLE : AccountRole.READONLY;
}

function jsonValue(
  event: HandledEvent,
  field: string,
  value: unknown,
  signature: string,
): JsonValue {
  if (typeof value === "bigint") return value < 0n ? toI64String(value) : toU64String(value);
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (typeof value === "number") {
    const names = ENUM_FIELDS[event]?.[field];
    if (!names) return value;
    const name = names[value];
    if (name === undefined) {
      throw halt(
        "UNKNOWN_ENUM",
        signature,
        `${event}.${field} carries the number ${value}, which names no variant`,
      );
    }
    return name;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (value === undefined) return null;
  throw halt(
    "EVENT_DECODE_FAILED",
    signature,
    `${event}.${field} has a value of an unexpected type`,
  );
}

function decodeEvent(base64: string, index: number, signature: string): DecodedEvent {
  if (Buffer.from(base64, "base64").toString("base64") !== base64) {
    throw halt("EVENT_DECODE_FAILED", signature, `event line ${index} is not canonical base64`);
  }
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  let name: string;
  try {
    name = ThetisEvent[identifyThetisEvent(bytes)];
  } catch {
    throw halt(
      "UNKNOWN_EVENT",
      signature,
      `event line ${index} has a discriminator no event carries`,
    );
  }
  if (!(HANDLED_EVENTS as readonly string[]).includes(name)) {
    throw halt("UNKNOWN_EVENT", signature, `event line ${index} is ${name}, which is not handled`);
  }
  const handled = name as HandledEvent;
  let value: unknown;
  let offset: number;
  try {
    [value, offset] = EVENT_DECODERS[handled]().read(bytes, 0);
  } catch (error) {
    if (isSolanaError(error, SOLANA_ERROR__CODECS__ENUM_DISCRIMINATOR_OUT_OF_RANGE)) {
      throw halt(
        "UNKNOWN_ENUM",
        signature,
        `event ${handled} (line ${index}) carries an enum number outside its variants`,
      );
    }
    throw halt(
      "EVENT_DECODE_FAILED",
      signature,
      `event ${handled} (line ${index}) does not decode`,
    );
  }
  if (offset !== bytes.length) {
    throw halt(
      "EVENT_DECODE_FAILED",
      signature,
      `event ${handled} (line ${index}) leaves ${bytes.length - offset} bytes unread`,
    );
  }
  const fields: Record<string, unknown> = {};
  for (const [field, entry] of Object.entries(value as Record<string, unknown>)) {
    fields[field] = isOption(entry) ? unwrapOption(entry, () => undefined) : entry;
  }
  const data: Record<string, JsonValue> = {};
  for (const [field, entry] of Object.entries(fields)) {
    data[field] = jsonValue(handled, field, entry, signature);
  }
  return { index, name: handled, value: fields, data };
}

function isThetis(keys: string[], instruction: RawInstruction): boolean {
  return keys[instruction.programIdIndex] === PROGRAM;
}

/**
 * Decodes one successful transaction. Throws HaltError (step decode), or RpcShapeError for a
 * response of the wrong type or length.
 */
export function decodeTransaction(
  raw: RawTransaction,
  signature: string,
  context: DecodeContext,
): DecodedTransaction {
  checkRawTransaction(raw);
  const message = raw.transaction.message;
  const staticKeys = message.accountKeys;
  const loaded = raw.meta?.loadedAddresses;
  const lookups = message.addressTableLookups ?? [];
  if (raw.version === 0 && lookups.length > 0 && !loaded) {
    throw halt(
      "TRANSACTION_UNREADABLE",
      signature,
      "a version 0 message uses address lookups but the response has no loaded addresses",
    );
  }
  const keys = [...staticKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];

  const outside = (instruction: RawInstruction, where: string) => {
    if (instruction.programIdIndex >= keys.length) {
      throw halt(
        "TRANSACTION_UNREADABLE",
        signature,
        `${where} names program index ${instruction.programIdIndex}, outside the ${keys.length} keys`,
      );
    }
  };
  for (const [i, instruction] of message.instructions.entries())
    outside(instruction, `instruction ${i}`);
  const inner = raw.meta?.innerInstructions ?? [];
  for (const group of inner) {
    for (const [i, instruction] of group.instructions.entries()) {
      outside(instruction, `inner instruction ${group.index}.${i}`);
    }
  }

  const meta = raw.meta;
  const logs = meta?.logMessages ?? null;
  const topLevel = message.instructions.filter((instruction) => isThetis(keys, instruction));
  const innerThetis = inner.some((group) =>
    group.instructions.some((instruction) => isThetis(keys, instruction)),
  );
  const thetisInvokeLine = logs?.some((line) => {
    const found = INVOKE.exec(line);
    return found?.[1] === PROGRAM;
  });
  const complete = meta !== null && meta.innerInstructions !== null && logs !== null;
  if (complete && topLevel.length === 0 && !innerThetis && !thetisInvokeLine) {
    return { invocations: [], protocol: null, otherInstance: false };
  }

  // Keys and logs.
  if (meta === null) throw halt("TRANSACTION_UNREADABLE", signature, "the response has no meta");
  if (logs === null)
    throw halt("TRANSACTION_UNREADABLE", signature, "the response has no log messages");
  if (innerThetis) {
    throw halt(
      "TRANSACTION_UNREADABLE",
      signature,
      "an inner instruction calls the Thetis program (a CPI)",
    );
  }
  const stack: string[] = [];
  const eventLines: string[][] = [];
  for (const line of logs) {
    if (line === "Log truncated") {
      throw halt("TRANSACTION_UNREADABLE", signature, "the logs were truncated");
    }
    const invoke = INVOKE.exec(line);
    if (invoke) {
      const program = invoke[1] as string;
      const depth = Number(invoke[2]);
      stack.push(program);
      if (depth !== stack.length) {
        throw halt(
          "TRANSACTION_UNREADABLE",
          signature,
          `an invoke at depth ${depth} while the stack holds ${stack.length}`,
        );
      }
      if (program === PROGRAM) {
        if (depth > 1) {
          throw halt(
            "TRANSACTION_UNREADABLE",
            signature,
            "the Thetis program is invoked below the top level (a CPI)",
          );
        }
        eventLines.push([]);
      }
      continue;
    }
    const finished = FINISHED.exec(line);
    if (finished) {
      if (stack.at(-1) !== finished[1]) {
        throw halt(
          "TRANSACTION_UNREADABLE",
          signature,
          `program ${finished[1]} ends while ${stack.at(-1) ?? "nothing"} is on top`,
        );
      }
      stack.pop();
      continue;
    }
    const data = DATA.exec(line);
    if (data && stack.at(-1) === PROGRAM) {
      eventLines.at(-1)?.push(data[1] as string);
    }
  }
  if (stack.length !== 0) {
    throw halt("TRANSACTION_UNREADABLE", signature, `${stack.length} invocations never ended`);
  }
  if (eventLines.length !== topLevel.length) {
    throw halt(
      "TRANSACTION_UNREADABLE",
      signature,
      `${eventLines.length} top-level Thetis invocations in the logs, ${topLevel.length} instructions`,
    );
  }

  // Identification and instance: the discriminator and the protocol account only.
  const identified = topLevel.map((instruction, position) => {
    let data: Uint8Array;
    try {
      data = new Uint8Array(base58.encode(instruction.data));
    } catch {
      throw halt(
        "UNKNOWN_INSTRUCTION",
        signature,
        `Thetis instruction ${position} data is not base58`,
      );
    }
    let name: InstructionName;
    try {
      name = ThetisInstruction[identifyThetisInstruction(data)];
    } catch {
      throw halt(
        "UNKNOWN_INSTRUCTION",
        signature,
        `Thetis instruction ${position} has a discriminator no instruction carries`,
      );
    }
    const at = PROTOCOL_ACCOUNT_POSITION[name];
    const index = instruction.accounts[at];
    if (index === undefined) {
      throw halt(
        "UNKNOWN_INSTRUCTION",
        signature,
        `Thetis instruction ${position} (${name}) names ${instruction.accounts.length} accounts, so it has no protocol account at position ${at}`,
      );
    }
    const protocol = keys[index];
    if (protocol === undefined) {
      throw halt(
        "TRANSACTION_UNREADABLE",
        signature,
        `Thetis instruction ${position} names account index ${index}, outside the ${keys.length} keys`,
      );
    }
    return { instruction, position, data, name, protocol };
  });
  const own = identified.filter((entry) => entry.protocol === context.protocol);
  if (own.length > 0 && own.length < identified.length) {
    const protocols = [...new Set(identified.map((entry) => entry.protocol))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    throw halt(
      "MIXED_INSTANCE",
      signature,
      `the Thetis instructions belong to the protocols ${protocols.join(", ")}; this stream follows ${context.protocol} only`,
    );
  }
  const otherInstance = identified.length > 0 && own.length === 0;
  const handled = (name: string): name is HandledInstruction =>
    (HANDLED_INSTRUCTIONS as readonly string[]).includes(name);

  // Instructions: every one of this instance must be handled. Another instance's are checked up
  // to pairing when handled, and only identified otherwise.
  const parsed = identified.flatMap(({ instruction, position, data, name }) => {
    if (!handled(name)) {
      if (otherInstance) return [];
      throw halt(
        "UNKNOWN_INSTRUCTION",
        signature,
        `Thetis instruction ${position} is ${name}, which is not handled`,
      );
    }
    const accounts = instruction.accounts.map((index) => {
      const address = keys[index];
      if (address === undefined) {
        throw halt(
          "TRANSACTION_UNREADABLE",
          signature,
          `Thetis instruction ${position} names account index ${index}, outside the ${keys.length} keys`,
        );
      }
      return { address, role: roleOf(index, raw, staticKeys.length) };
    });
    let result: ReturnType<typeof parseThetisInstruction>;
    try {
      result = parseThetisInstruction({
        programAddress: THETIS_PROGRAM_ADDRESS,
        accounts,
        data,
      } as unknown as Parameters<typeof parseThetisInstruction>[0]);
    } catch (error) {
      if (isSolanaError(error, SOLANA_ERROR__CODECS__ENUM_DISCRIMINATOR_OUT_OF_RANGE)) {
        throw halt(
          "UNKNOWN_ENUM",
          signature,
          `Thetis instruction ${position} (${name}) carries an enum number outside its variants`,
        );
      }
      throw halt(
        "UNKNOWN_INSTRUCTION",
        signature,
        `Thetis instruction ${position} (${name}) does not parse`,
      );
    }
    const named: Record<string, string | undefined> = {};
    const entries = Object.entries(
      result.accounts as Record<string, { address: string } | undefined>,
    );
    for (const [account, meta] of entries) {
      named[account] = meta?.address;
    }
    const remaining = accounts.slice(entries.length).map((meta) => meta.address);
    const args = result.data as unknown as Record<string, unknown>;
    return [{ position, instruction: name, accounts: named, remaining, args }];
  });

  // Events first, for every invocation, then pairing.
  const first = eventLines.map((_, position) =>
    eventLines.slice(0, position).reduce((sum, lines) => sum + lines.length, 0),
  );
  const decoded = parsed.map(({ position, ...entry }) => ({
    ...entry,
    events: (eventLines[position] as string[]).map((line, n) =>
      decodeEvent(line, (first[position] as number) + n, signature),
    ),
  }));
  const invocations: Invocation[] = [];
  for (const entry of decoded) {
    if (entry.instruction === "RecordLoading") {
      // One (acceptance, loan, lock) triple per accepted loan (live-custody.md §4.1.2).
      const n = entry.remaining.length;
      if (n % 3 !== 0 || n > 3 * MAX_LOADING_LOANS) {
        throw halt(
          "EVENT_MISMATCH",
          signature,
          `RecordLoading: record_loading names ${n} remaining accounts; expected 3 per accepted loan, at most ${3 * MAX_LOADING_LOANS}`,
        );
      }
    }
    const emits = expectedEvents(entry);
    const names = entry.events.map((event) => event.name);
    const exact =
      names.length === emits.events.length &&
      names.every((name, index) => name === emits.events[index]);
    if (!exact && (emits.required || names.length > 0)) {
      throw halt(
        "EVENT_MISMATCH",
        signature,
        `${entry.instruction} emitted [${names.join(", ")}], expected ${emits.required ? "exactly" : "at most"} [${emits.events.join(", ")}]`,
      );
    }
    for (const [position, event] of entry.events.entries()) {
      for (const [field, account] of PAIRING[event.name]) {
        if (event.value[field] !== entry.accounts[account]) {
          throw halt(
            "EVENT_MISMATCH",
            signature,
            `${event.name}.${field} is not the ${entry.instruction} account ${account}`,
            [String(event.value[field]), String(entry.accounts[account])],
          );
        }
      }
      if (event.name === "CustodyHandedOver") {
        const inconsistency = handoverInconsistency(event.value);
        if (inconsistency !== null) throw halt("EVENT_MISMATCH", signature, inconsistency);
      }
      if (event.name === "ShortfallAttested") {
        const inconsistency = shortfallInconsistency(event.value);
        if (inconsistency !== null) throw halt("EVENT_MISMATCH", signature, inconsistency);
      }
      if (event.name === "RestrictionSet" && event.value.to !== entry.args.restriction) {
        // The restriction the instruction sets is the one the event reports (live-custody.md §4.1.2).
        const named = (value: unknown) =>
          (Restriction as unknown as Record<number, string>)[value as number] ?? String(value);
        throw halt(
          "EVENT_MISMATCH",
          signature,
          "RestrictionSet.to is not the SetRestriction argument restriction",
          [named(event.value.to), named(entry.args.restriction)],
        );
      }
      if (event.name === "LoadingRecorded") {
        const k = entry.remaining.length / 3;
        if (event.value.loansAccepted !== k) {
          throw halt(
            "EVENT_MISMATCH",
            signature,
            `LoadingRecorded.loansAccepted is ${String(event.value.loansAccepted)}, but RecordLoading names ${k} accepted loans`,
          );
        }
      }
      if (event.name === "LoanHandedOff") {
        // The i-th hand-off follows LoadingRecorded (event 0) and names the i-th triple's loan.
        const loan = entry.remaining[3 * (position - 1) + 1];
        if (event.value.loan !== loan) {
          throw halt(
            "EVENT_MISMATCH",
            signature,
            `LoanHandedOff.loan is not the RecordLoading remaining account ${3 * (position - 1) + 1}, the loan of triple ${position - 1}`,
            [String(event.value.loan), String(loan)],
          );
        }
      }
      if (event.name === "Repaid") {
        const pooled = event.value.pool !== undefined;
        if (pooled !== (event.value.poolRevision !== undefined)) {
          throw halt(
            "EVENT_MISMATCH",
            signature,
            pooled ? "Repaid.pool without poolRevision" : "Repaid.poolRevision without pool",
          );
        }
        if (pooled && entry.remaining.length < 1) {
          throw halt("EVENT_MISMATCH", signature, "simulated Repay names no pool share");
        }
      }
    }
    if (!otherInstance) invocations.push(entry);
  }
  return {
    invocations,
    protocol: own.length > 0 ? context.protocol : null,
    otherInstance,
  };
}
