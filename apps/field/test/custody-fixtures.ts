// Test-only custody fixtures: batches, loading intents, the three texts the relay prepares for
// handover, border observation and loading, and the command views around them. Every value is
// throwaway. Addresses are base58 of 32 repeated bytes, organisation ids are random uuids, and the
// texts are built here line by line, independently of src/.
import { createHash } from "node:crypto";
import { vi } from "vitest";
import type { CommandStatus, CommandView, SignerRole } from "../src/api/commands";
import type { FieldBatch, LoadingAcceptance, LoadingIntent } from "../src/api/field";
import type { ChainOrganisation, Membership } from "../src/data/reads";
import type { ObservationDraft } from "../src/drafts/store";
import type { EvidenceItem } from "../src/evidence/upload";
import { formatSast, formatTimeOfDay, unixOf } from "../src/format";
import { encodeBase58 } from "../src/lib/encoding";
import { KHUNOU_ORG, KOPANO_ORG, LOT_ADDRESS, PROGRAM, PROTOCOL, TX_SIGNATURE } from "./fixtures";

/** The base58 address of 32 bytes that all equal `fill`. */
export const addr = (fill: number): string => encodeBase58(new Uint8Array(32).fill(fill));

export const PROTOCOL_HEX = "666961742d64656d6f2d72756e2d3031";

export const MOSELA_ORG = "5d0e8a47-2b91-4c63-9f1a-7e3b6c8d0a52";
export const PORT_ORG = "a8c3f152-6e74-4b09-8d2a-1f5e9c7b3d60";
export { KHUNOU_ORG, KOPANO_ORG };

export const HANDOVER_ID = "7b2e9d14-3a5c-4f68-8e01-9c4d2b6a7f35";
export const HANDOVER_CODE = "7b2e9d14";
export const OBSERVATION_ID = "e91c4a07-5d3b-4862-b7f0-2a8c6d1e3f94";
export const LOADING_ID = "c5a41e68-92d7-4b30-a6f8-1d3e5b7c9a02";

export const KOPANO_CHAIN = addr(21);
export const MOSELA_CHAIN = addr(22);
export const PORT_CHAIN = addr(23);
export const KHUNOU_CHAIN = addr(24);
export const LENDER_ONE = addr(25);
export const LENDER_TWO = addr(26);
export const LOAN_ONE = addr(27);
export const LOAN_TWO = addr(28);
export const INTENT_ADDRESS = addr(29);
export const SHIPMENT_ADDRESS = addr(30);
export const BATCH_ADDRESS = addr(31);
export const LOT = LOT_ADDRESS;

export const kopanoChain: ChainOrganisation = {
  address: KOPANO_CHAIN,
  role: "Custodian",
  displayName: "Kopano Stockyard Custody",
};
export const moselaChain: ChainOrganisation = {
  address: MOSELA_CHAIN,
  role: "Transporter",
  displayName: "Mosela Haulage",
};
export const portChain: ChainOrganisation = {
  address: PORT_CHAIN,
  role: "Terminal",
  displayName: "Port Terminal T1",
};

export const kopanoMembership: Membership = {
  organisationId: KOPANO_ORG,
  memberRole: "member",
  name: "Kopano Stockyard Custody",
  slug: "kopano-stockyard-custody",
  kind: "custodian",
  synthetic: true,
};
export const moselaMembership: Membership = {
  organisationId: MOSELA_ORG,
  memberRole: "member",
  name: "Mosela Haulage",
  slug: "mosela-haulage",
  kind: "transporter",
  synthetic: true,
};
export const portMembership: Membership = {
  organisationId: PORT_ORG,
  memberRole: "member",
  name: "Port Terminal T1",
  slug: "port-terminal-t1",
  kind: "terminal",
  synthetic: true,
};

/** 2026-11-28 12:00:00 SAST. Screens that read the clock run with Date faked to this. */
export const NOW_UNIX = 1_795_860_000n;
/** A text prepared at NOW is valid for 570 seconds; the person signs 30 seconds before that. */
export const VALID_UNTIL = NOW_UNIX + 570n;
export const SIGN_BEFORE = formatTimeOfDay(VALID_UNTIL - 30n);
export const SLOT = "526890114";

/** The same module's mock of the Supabase reads: real helpers kept, the custody reads spied. */
export function custodyReads<T extends object>(original: T) {
  return {
    ...original,
    readChainOrganisation: vi.fn(async () => kopanoChain),
    readSignerLinks: vi.fn(async () => []),
    readAuthority: vi.fn(async () => null),
    readOrganisationAt: vi.fn(async () => null),
    readOpenLoadingCommand: vi.fn(async () => null),
    readWaiting: vi.fn(async () => []),
  };
}

// ---- field batches and loading intents -----------------------------------------------------

/** CR-0001, batch 1 of 1, 5,000.000 t, held at source by Kopano with Mosela as the carrier. */
export function fieldBatch(over: Partial<FieldBatch> = {}): FieldBatch {
  return {
    batch: BATCH_ADDRESS,
    shipment: SHIPMENT_ADDRESS,
    lot: LOT,
    lotId: "CR-0001",
    index: 1,
    batchCount: 1,
    quantityKg: "5000000",
    stage: "AtSource",
    holder: KOPANO_CHAIN,
    holderName: "Kopano Stockyard Custody",
    carrier: MOSELA_CHAIN,
    carrierName: "Mosela Haulage",
    destinationCustodian: PORT_CHAIN,
    destinationName: "Port Terminal T1",
    observationCount: 0,
    sequence: "0",
    ...over,
  };
}

export const lenderOneAccepted: LoadingAcceptance = {
  lender: LENDER_ONE,
  lenderName: "Lender One Bank",
  loan: LOAN_ONE,
  lockKg: "3000000",
  state: "accepted",
};
export const lenderTwoMissing: LoadingAcceptance = {
  lender: LENDER_TWO,
  lenderName: "Lender Two Bank",
  loan: LOAN_TWO,
  lockKg: "1000000",
  state: "missing",
};
export const lenderTwoStale: LoadingAcceptance = { ...lenderTwoMissing, state: "stale" };

/** The demo intent: nonce 1, 3,000.000 t for Khunou Ore Exports, one lender accepted, open for 5 h. */
export function loadingIntent(over: Partial<LoadingIntent> = {}): LoadingIntent {
  return {
    intent: INTENT_ADDRESS,
    lot: LOT,
    lotId: "CR-0001",
    quantityKg: "3000000",
    lockedKg: "3000000",
    owner: KHUNOU_CHAIN,
    ownerName: "Khunou Ore Exports",
    terminalName: "Port Terminal T1",
    documentSha256: "aa".repeat(32),
    nonce: "1",
    expiresAt: String(NOW_UNIX + 18_000n),
    acceptances: [lenderOneAccepted],
    ...over,
  };
}

/** The wire form of the two entries, for the parser tests: plain JSON, no class instances. */
export const wireBatch = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...fieldBatch(),
  ...over,
});
export const wireIntent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...loadingIntent(),
  ...over,
});

// ---- signed texts --------------------------------------------------------------------------

type Fields = ReadonlyArray<readonly [label: string, value: string]>;

/** The envelope of program-lots.md §6.2, written out here and not taken from src/. */
export function envelope(
  action: string,
  fields: Fields,
  validUntil: bigint = VALID_UNTIL,
  protocolHex: string = PROTOCOL_HEX,
): string {
  return [
    "Thetis authorisation v1",
    "Network: devnet",
    `Program: ${PROGRAM}`,
    `Protocol: ${protocolHex}`,
    `Action: ${action}`,
    ...fields.map(([label, value]) => `${label}: ${value}`),
    `Valid until: ${formatSast(validUntil)}`,
    "Test network only. Synthetic data.",
  ].join("\n");
}

function withValues(defaults: Fields, over: Record<string, string>): Fields {
  return defaults.map(([label, value]) => [label, over[label] ?? value] as const);
}

export const SHIPMENT_HEX = "22".repeat(16);
export const MANIFEST_HEX = "44".repeat(32);

const HANDOVER_FIELDS: Fields = [
  ["Lot", "CR-0001"],
  ["Shipment", SHIPMENT_HEX],
  ["Batch", "1 of 1"],
  ["Quantity", "5,000.000 t"],
  ["From", "Kopano Stockyard Custody"],
  ["To", "Mosela Haulage"],
  ["Stage", "Departure"],
  ["Manifest", MANIFEST_HEX],
  ["Sequence", "0"],
];

/** Kopano hands batch 1 of 1 of CR-0001 to Mosela, at Departure; `over` replaces a field's value. */
export const handoverText = (over: Record<string, string> = {}, validUntil = VALID_UNTIL) =>
  envelope("Hand over custody", withValues(HANDOVER_FIELDS, over), validUntil);

export const PHOTO_SHA = "b3a5c1d7".padEnd(64, "0");
export const PHOTO_VERSION_ID = "0b0b0b0b-0000-4000-8000-0000000000a1";
export const PHOTO_OBJECT_ID = "0a0a0a0a-0000-4000-8000-0000000000a1";
export const CAPTURED_AT = "2026-11-28T09:11:05.000Z";
export const OBSERVED_AT = unixOf(CAPTURED_AT);

const OBSERVATION_FIELDS: Fields = [
  ["Lot", "CR-0001"],
  ["Shipment", SHIPMENT_HEX],
  ["Batch", "1 of 1"],
  ["Holder", "Mosela Haulage"],
  ["Observer", "Mosela Haulage"],
  ["Kind", "Border"],
  ["Location", "BORDER-1"],
  ["Evidence", PHOTO_SHA],
  ["Observed at", formatSast(OBSERVED_AT)],
  ["Observation", "0"],
];

/** Mosela records a border crossing at BORDER-1 for the photo taken at CAPTURED_AT. */
export const observationText = (over: Record<string, string> = {}, validUntil = VALID_UNTIL) =>
  envelope("Record observation", withValues(OBSERVATION_FIELDS, over), validUntil);

const LOADING_FIELDS: Fields = [
  ["Lot", "CR-0001"],
  ["Quantity", "3,000.000 t"],
  ["Owner", "Khunou Ore Exports"],
  ["Terminal", "Port Terminal T1"],
  ["Loading document", "aa".repeat(32)],
  ["Intent", "1"],
  ["Locked", "3,000.000 t"],
  ["Loan acceptances", "1"],
  ["Revision", "3"],
];

/** Port Terminal T1 records loading of 3,000.000 t for Khunou, one lender accepted, revision 3. */
export const loadingText = (over: Record<string, string> = {}, validUntil = VALID_UNTIL) =>
  envelope("Record loading", withValues(LOADING_FIELDS, over), validUntil);

// ---- command views -------------------------------------------------------------------------

type CustodyKind = "handover" | "record_observation" | "record_loading";

const EVENT = {
  handover: "CustodyHandedOver",
  record_observation: "ObservationRecorded",
  record_loading: "LoadingRecorded",
} as const;

interface Init {
  id: string;
  kind: CustodyKind;
  status: CommandStatus;
  text: string;
  signers: { role: SignerRole; organisationId: string; signed: boolean }[];
  initiator: string;
  args: Record<string, string>;
  intent: string | null;
  data: Record<string, unknown>;
  error?: { code: string; detail: string | null };
  commitment?: "confirmed" | "finalized";
}

const SIGNED_AT = "2026-11-28T10:01:00.000Z";

/** The command's labelled lines, as the relay lists them in `fields`. */
function labelled(text: string): { label: string; value: string }[] {
  return text
    .split("\n")
    .slice(5, -2)
    .map((line) => {
      const colon = line.indexOf(": ");
      return { label: line.slice(0, colon), value: line.slice(colon + 2) };
    });
}

function custodyView(init: Init, overrides: Partial<CommandView> = {}): CommandView {
  const sent = init.status !== "awaiting_signatures" && init.status !== "expired";
  const confirmed = init.status === "confirmed";
  const commitment = init.commitment ?? "confirmed";
  return {
    id: init.id,
    kind: init.kind,
    status: init.status,
    network: "devnet",
    programId: PROGRAM,
    protocol: PROTOCOL,
    initiatorOrganisationId: init.initiator,
    parties: [...new Set(init.signers.map((s) => s.organisationId))],
    lot: LOT,
    facility: null,
    loan: null,
    intent: init.intent,
    payment: null,
    args: init.args,
    fields: labelled(init.text),
    text: {
      version: 1,
      messageBase64: Buffer.from(init.text).toString("base64"),
      messageSha256: createHash("sha256").update(init.text).digest("hex"),
      validUntil: String(VALID_UNTIL),
      validUntilText: formatSast(VALID_UNTIL),
    },
    signers: init.signers.map((signer, index) => ({
      role: signer.role,
      organisationId: signer.organisationId,
      method: "text" as const,
      signed: sent || signer.signed ? { wallet: addr(40 + index), signedAt: SIGNED_AT } : null,
    })),
    transaction: sent
      ? {
          signature: TX_SIGNATURE,
          sends: 1,
          explorerUrl: `https://explorer.solana.com/tx/${TX_SIGNATURE}?cluster=devnet`,
        }
      : null,
    confirmedSlot: confirmed ? SLOT : null,
    confirmedCommitment: confirmed ? commitment : null,
    outcome: confirmed
      ? { event: EVENT[init.kind], slot: SLOT, commitment, data: init.data }
      : null,
    error: init.error ?? (init.status === "failed" ? { code: "Anchor3012", detail: null } : null),
    createdAt: "2026-11-28T10:00:05.000Z",
    updatedAt: "2026-11-28T10:01:02.000Z",
    ...overrides,
  };
}

export interface HandoverOptions {
  text?: string;
  holderOrg?: string;
  nextOrg?: string;
  holderSigned?: boolean;
  nextSigned?: boolean;
  error?: { code: string; detail: string | null };
  commitment?: "confirmed" | "finalized";
}

/** The holder's handover command: Kopano hands to Mosela unless the options name other parties. */
export function handoverView(
  status: CommandStatus,
  options: HandoverOptions = {},
  overrides: Partial<CommandView> = {},
): CommandView {
  const holderOrg = options.holderOrg ?? KOPANO_ORG;
  const nextOrg = options.nextOrg ?? MOSELA_ORG;
  return custodyView(
    {
      id: HANDOVER_ID,
      kind: "handover",
      status,
      text: options.text ?? handoverText(),
      signers: [
        { role: "holder", organisationId: holderOrg, signed: options.holderSigned === true },
        { role: "next_holder", organisationId: nextOrg, signed: options.nextSigned === true },
      ],
      initiator: holderOrg,
      args: { batch: BATCH_ADDRESS, to: nextOrg },
      intent: null,
      data: { batch: BATCH_ADDRESS },
      error: options.error,
      commitment: options.commitment,
    },
    overrides,
  );
}

export interface ObservationOptions {
  text?: string;
  observerSigned?: boolean;
  error?: { code: string; detail: string | null };
}

export function observationView(
  status: CommandStatus,
  options: ObservationOptions = {},
  overrides: Partial<CommandView> = {},
): CommandView {
  return custodyView(
    {
      id: OBSERVATION_ID,
      kind: "record_observation",
      status,
      text: options.text ?? observationText(),
      signers: [
        { role: "observer", organisationId: MOSELA_ORG, signed: options.observerSigned === true },
      ],
      initiator: MOSELA_ORG,
      args: {
        batch: BATCH_ADDRESS,
        kind: "Border",
        locationCode: "BORDER-1",
        evidenceVersionId: PHOTO_VERSION_ID,
        observedAt: String(OBSERVED_AT),
      },
      intent: null,
      data: { batch: BATCH_ADDRESS },
      error: options.error,
    },
    overrides,
  );
}

export interface LoadingOptions {
  text?: string;
  ownerSigned?: boolean;
  terminalSigned?: boolean;
  /** `outcome.data` of a confirmed loading: LoadingRecorded's fields plus `loanHandOffs`. */
  data?: Record<string, unknown>;
  error?: { code: string; detail: string | null };
  commitment?: "confirmed" | "finalized";
}

/** Port Terminal T1's record_loading for the demo intent; the owner signs on the web. */
export function loadingView(
  status: CommandStatus,
  options: LoadingOptions = {},
  overrides: Partial<CommandView> = {},
): CommandView {
  return custodyView(
    {
      id: LOADING_ID,
      kind: "record_loading",
      status,
      text: options.text ?? loadingText(),
      signers: [
        { role: "owner", organisationId: KHUNOU_ORG, signed: options.ownerSigned === true },
        { role: "terminal", organisationId: PORT_ORG, signed: options.terminalSigned === true },
      ],
      initiator: PORT_ORG,
      args: { intent: INTENT_ADDRESS },
      intent: INTENT_ADDRESS,
      data: options.data ?? { lotLoaded: false, loanHandOffs: [] },
      error: options.error,
      commitment: options.commitment,
    },
    overrides,
  );
}

// ---- the observation draft -----------------------------------------------------------------

/** A border photo that was taken at CAPTURED_AT and is stored and finalized. */
export function photo(over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    localId: "local-transport",
    purpose: "transport",
    localUri: "file:///data/drafts/o-1/local-transport.jpg",
    mime: "image/jpeg",
    sizeBytes: 1_234,
    capturedAt: CAPTURED_AT,
    objectId: PHOTO_OBJECT_ID,
    versionId: PHOTO_VERSION_ID,
    version: 1,
    supersedesId: null,
    storagePath: `${MOSELA_ORG}/${PHOTO_OBJECT_ID}/1`,
    upload: "finalized",
    sha256: PHOTO_SHA,
    error: null,
    ...over,
  };
}

/** Mosela's stored observation draft: batch chosen, BORDER-1 typed, the photo finalized. */
export function observationDraft(
  userId: string,
  protocol: string,
  over: Partial<ObservationDraft> = {},
): ObservationDraft {
  return {
    id: "o-1",
    userId,
    organisationId: MOSELA_ORG,
    protocol,
    batch: BATCH_ADDRESS,
    locationCode: "BORDER-1",
    evidence: photo(),
    command: null,
    updatedAt: "2026-11-28T10:00:00.000Z",
    ...over,
  };
}
