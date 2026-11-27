// The custody fixtures (live-custody.md §9.1 and its T063d.1 pre-check folds).
//
// SYNTHETIC: every key, signature, slot, block time and digest below is a byte fill or an offset.
// The parties are supabase/seed.sql's seven organisations (seedHistory()); the quantities, the
// sites and the amounts are demo.md §2–§4's and program-custody.md §4.3's. Each account's data is
// the program's state after the action, worked out here from programs/thetis (shipment.rs,
// release.rs, pledge.rs, documents.rs); the manifest root is program-custody.md §6.3's tree.

import { createHash } from "node:crypto";
import {
  AccountRole,
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  none,
  some,
} from "@solana/kit";
import {
  BatchStage,
  DocumentKind,
  findAcceptancePda,
  findAuthorityPda,
  findBatchPda,
  findFacilityPda,
  findHandoverPda,
  findIntakePda,
  findIntentPda,
  findLoadingIntentPda,
  findLoanPda,
  findLockPda,
  findMintAuthorityPda,
  findMintPda,
  findOrganisationPda,
  findPositionPda,
  findProtocolPda,
  findShipmentPda,
  findVaultAuthorityPda,
  getAcceptLoadingInstruction,
  getAccreditCustodianClassInstruction,
  getAccreditOrganisationInstruction,
  getAdvanceRecordedEventEncoder,
  getAttestDocumentInstruction,
  getBatchRegisteredEventEncoder,
  getCancelShipmentInstruction,
  getCreateLoadingIntentInstruction,
  getCreateReleaseIntentInstruction,
  getCustodianClassAccreditedEventEncoder,
  getCustodianClassEncoder,
  getCustodyHandedOverEventEncoder,
  getDocumentAttestationEncoder,
  getDocumentAttestedEventEncoder,
  getFacilityEncoder,
  getFacilityOpenedEventEncoder,
  getHandoffAcceptanceEncoder,
  getHandoverInstruction,
  getHandoverRecordEncoder,
  getIntakeIdentityEncoder,
  getIssueLotInstruction,
  getLoadingAcceptedEventEncoder,
  getLoadingIntentCreatedEventEncoder,
  getLoadingIntentEncoder,
  getLoadingRecordedEventEncoder,
  getLoanEncoder,
  getLoanHandedOffEventEncoder,
  getLockAllocationEncoder,
  getLotEncoder,
  getLotIssuedEventEncoder,
  getManifestBatchEncoder,
  getObservationRecordedEventEncoder,
  getOpenFacilityInstruction,
  getOrganisationAccreditedEventEncoder,
  getOrganisationEncoder,
  getOrganisationNameEncoder,
  getPledgedEventEncoder,
  getPledgeInstruction,
  getPositionEncoder,
  getPrepareShipmentInstruction,
  getRecordAdvanceInstruction,
  getRecordLoadingInstruction,
  getRecordObservationInstruction,
  getRegisterBatchInstruction,
  getReleaseIntentCreatedEventEncoder,
  getReleaseIntentEncoder,
  getSetValuationInstruction,
  getShipmentCancelledEventEncoder,
  getShipmentEncoder,
  getShipmentPreparedEventEncoder,
  getValuationEncoder,
  getValuationSetEventEncoder,
  HandoverStage,
  IntentStatus,
  LoadingStatus,
  LoanStatus,
  LockControl,
  LotState,
  ObservationKind,
  Restriction,
  Role,
  ShipmentStatus,
} from "@thetis/contracts";
import { accrueSimple } from "../../../../packages/domain/src/accrual.ts";
import {
  findClassPolicyPda,
  findOrganisationNamePda,
  instanceIdBytes,
  SEED,
} from "../../../../scripts/seed-demo.ts";
import {
  type AccountState,
  bytesOf,
  cloneHistory,
  type FakeTransaction,
  fill,
  fixture,
  type History,
  lotPda,
  PROGRAM,
  seedHistory,
  syntheticSignature,
  syntheticSigner,
  thetis,
  thetisTransaction,
  unix,
} from "./synthetic.ts";

const addressBytes = getAddressEncoder();
const text = new TextEncoder();
const ASSOCIATED_TOKEN = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";

// ------------------------------------------------------------------------------------------------
// The manifest tree (program-custody.md §6.3, programs/thetis/src/manifest.rs)
// ------------------------------------------------------------------------------------------------

export const MANIFEST_DEPTH = 4;
const sha256 = (...parts: Uint8Array[]) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};

/** SHA-256 of 0x00 ‖ index ‖ quantity_kg (u64 LE) ‖ carrier ‖ load_digest ‖ manifest_digest. */
export function batchLeaf(input: {
  index: number;
  quantityKg: bigint;
  carrier: string;
  loadDigest: Uint8Array;
  manifestDigest: Uint8Array;
}): Uint8Array {
  const quantity = new Uint8Array(8);
  new DataView(quantity.buffer).setBigUint64(0, input.quantityKg, true);
  return sha256(
    new Uint8Array([0x00, input.index]),
    quantity,
    Uint8Array.from(addressBytes.encode(input.carrier as Address)),
    input.loadDigest,
    input.manifestDigest,
  );
}

const node = (left: Uint8Array, right: Uint8Array) => sha256(new Uint8Array([0x01]), left, right);

/** The 16-leaf tree's levels, leaves first; padding leaves are 32 zero bytes, not hashed. */
function levels(leaves: Uint8Array[]): Uint8Array[][] {
  if (leaves.length < 1 || leaves.length > 2 ** MANIFEST_DEPTH) {
    throw new Error(`a manifest has 1 to 16 batches, not ${leaves.length}`);
  }
  const out: Uint8Array[][] = [
    Array.from({ length: 2 ** MANIFEST_DEPTH }, (_, i) => leaves[i] ?? new Uint8Array(32)),
  ];
  for (let level = 0; level < MANIFEST_DEPTH; level += 1) {
    const below = out[level] as Uint8Array[];
    const above: Uint8Array[] = [];
    for (let i = 0; i < below.length; i += 2) {
      above.push(node(below[i] as Uint8Array, below[i + 1] as Uint8Array));
    }
    out.push(above);
  }
  return out;
}

export function manifestRoot(leaves: Uint8Array[]): Uint8Array {
  return (levels(leaves)[MANIFEST_DEPTH] as Uint8Array[])[0] as Uint8Array;
}

export function manifestProof(leaves: Uint8Array[], index: number): Uint8Array[] {
  const tree = levels(leaves);
  const proof: Uint8Array[] = [];
  let at = index;
  for (let level = 0; level < MANIFEST_DEPTH; level += 1) {
    proof.push((tree[level] as Uint8Array[])[at ^ 1] as Uint8Array);
    at >>= 1;
  }
  return proof;
}

// ------------------------------------------------------------------------------------------------
// custodyHistory()
// ------------------------------------------------------------------------------------------------

export type CustodyStep =
  | "accreditKopano"
  | "accreditPort"
  | "issueLot"
  | "openFacility"
  | "setValuation"
  | "pledge"
  | "recordAdvance"
  | "createReleaseIntent"
  | "createReleaseIntent2"
  | "attestDeparture"
  | "prepareS1"
  | "registerB1"
  | "cancelS1"
  | "prepareS2"
  | "registerB2"
  | "registerB3"
  | "departB2"
  | "observeB2"
  | "departB3"
  | "accreditHaulier"
  | "transferB2"
  | "arriveB2"
  | "arriveB3"
  | "createLoadingIntent"
  | "acceptLoading"
  | "reacceptLoading"
  | "recordLoading"
  | "attestDeparture2"
  | "prepareS3";

/**
 * SYNTHETIC: one signature index per step (live-custody.md §9.1: k from 240; the route steps below
 * 240 because a synthetic signature index stops at 255, T063d.2 pre-check fold 6; 237 is
 * T063d.3's border observation, its pre-check fold 2; 224–229 the loading, T063d.4 pre-check folds 2
 * and 3).
 */
const STEP_SIGNATURE: Record<CustodyStep, number> = {
  accreditKopano: 240,
  accreditPort: 241,
  issueLot: 242,
  openFacility: 243,
  setValuation: 244,
  pledge: 245,
  recordAdvance: 246,
  createReleaseIntent: 247,
  createReleaseIntent2: 230,
  attestDeparture: 248,
  prepareS1: 249,
  registerB1: 250,
  cancelS1: 251,
  prepareS2: 252,
  registerB2: 253,
  accreditHaulier: 232,
  transferB2: 233,
  registerB3: 234,
  departB3: 235,
  departB2: 236,
  observeB2: 237,
  arriveB2: 238,
  arriveB3: 239,
  // The loading (T063d.4 pre-check fold 2): §9.1's 258–260 exceed 255.
  createLoadingIntent: 224,
  acceptLoading: 225,
  recordLoading: 226,
  reacceptLoading: 227,
  attestDeparture2: 228,
  prepareS3: 229,
};

export type CustodyScenario = {
  history: History;
  steps: Partial<Record<CustodyStep, { signature: string; slot: number; blockTime: string }>>;
  protocol: string;
  org: (slug: string) => string;
  classes: { kopano: string; port: string };
  lot: string;
  position: string;
  facility: string;
  loan: string;
  intents: string[];
  document: string;
  /** S3 (PORT-T1 → KOPANO-YARD-1) in the `loading: "ship"` variant only. */
  shipments: { s1: string; s2: string; s3?: string };
  /** B3 is S2's second batch, in the partial-arrival variant only. */
  batches: { b1: string; b2: string; b3?: string };
  /** The HandoverRecord each handover step creates. */
  handovers: Partial<Record<CustodyStep, string>>;
  /** Haulier Two Test Org's Organisation, in the transfer variant only. */
  haulier?: string;
  /** The prepared_at of S1 and S2 (unix seconds). */
  preparedAt: { s1: bigint; s2: bigint };
  intake: string;
  lock: string;
  /** The loading intent (nonce 1) and the Lender One acceptance, in the loading variants only. */
  loadingIntent?: string;
  acceptance?: string;
  firstSignature: string;
};

const LOT_ID = "CR-0001";
const KOPANO_SITE = "KOPANO-YARD-1";
const PORT_SITE = "PORT-T1";
const KOPANO_CAPACITY_KG = 10_000_000n;
const PORT_CAPACITY_KG = 5_000_000n;
const LOT_KG = 5_000_000n;
/**
 * SYNTHETIC, test only (T063d.2 pre-check fold 3): a second Transporter, so a Transfer handover can
 * happen. Not in seed.sql, so its slug is null; never in the demo cast.
 */
const HAULIER_NAME = "Haulier Two Test Org";
const HAULIER_ORG_ID = "11000000-0000-4000-8000-000000000009";

export type CustodyOptions = {
  secondIntent?: boolean;
  /** routeHistory(): S2's batches depart, and arrive at PORT-T1 (live-custody.md §9.1). */
  route?: boolean;
  /** With `route`: B2 is transferred to Haulier Two Test Org in transit, which hands it on. */
  transfer?: boolean;
  /** S2 carries two batches (3,000,000 and 2,000,000 kg); with `route`, both depart and arrive. */
  partial?: boolean;
  /**
   * With `route`, after the arrival (live-custody.md §9.1 loadingHistory, T063d.4 pre-check folds):
   * "record" creates the loading intent, Lender One accepts it, and the loading is recorded; "ship"
   * creates the intent, then Port Terminal T1 attests a second Departure document and S3 leaves
   * PORT-T1 for KOPANO-YARD-1.
   */
  loading?: "record" | "ship";
  /** With `loading: "record"`: Lender One accepts again (version 2) before the loading. */
  reaccept?: boolean;
};

/**
 * seedHistory() then the custody actions of live-custody.md §9.1, one transaction per slot from
 * 51,000, block times from 2026-11-28T00:00:00Z one second apart. `secondIntent` adds nonce 2
 * right after nonce 1, expiring at the block time of S1's preparation.
 */
export async function custodyHistory(options: CustodyOptions = {}): Promise<CustodyScenario> {
  const f = await fixture();
  const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes() });
  const classPolicy = await findClassPolicyPda(protocol, SEED.classCode, SEED.classVersion);
  const orgs = new Map<string, string>();
  for (const party of f.organisations) {
    const [address] = await findOrganisationPda({ protocol, orgId: party.orgId });
    orgs.set(party.slug, address);
  }
  const org = (slug: string) => {
    const found = orgs.get(slug);
    if (!found) throw new Error(`no organisation ${slug}`);
    return found;
  };
  const kopano = org("kopano");
  const khunou = org("khunou");
  const buyer = org("buyer-smelter");
  const lenderOrg = org("lender-one");
  const port = org("port-t1");
  const mosela = org("mosela");
  const { deployer, accreditor, sponsor } = f.signers;
  const lenderWallet = await syntheticSigner(40);
  const custodianWallet = await syntheticSigner(43);
  const authorityOf = async (n: number) =>
    (await findAuthorityPda({ protocol, wallet: (await syntheticSigner(n)).address }))[0];
  const lenderAuthority = await authorityOf(40);
  const ownerAuthority = await authorityOf(41);
  const custodianAuthority = await authorityOf(43);

  const classOf = async (custodian: string, site: string) =>
    getProgramDerivedAddress({
      programAddress: PROGRAM as Address,
      seeds: [
        text.encode("custodian_class"),
        addressBytes.encode(protocol),
        addressBytes.encode(custodian as Address),
        addressBytes.encode(classPolicy),
        text.encode(site),
      ],
    });
  const [kopanoClass, kopanoClassBump] = await classOf(kopano, KOPANO_SITE);
  const [portClass, portClassBump] = await classOf(port, PORT_SITE);
  const intakeDigest = fill(32, 0x01);
  const [intake, intakeBump] = await findIntakePda({
    protocol,
    custodian: kopano as Address,
    intakeDigest,
  });
  const [lot, lotBump] = await lotPda(protocol, LOT_ID);
  const [mint] = await findMintPda({ lot: lot as Address });
  const [mintAuthority] = await findMintAuthorityPda({ mint });
  const [position, positionBump] = await findPositionPda({
    lot: lot as Address,
    owner: khunou as Address,
  });
  const [vaultAuthority] = await findVaultAuthorityPda({ position });
  const [vault] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN as Address,
    seeds: [
      addressBytes.encode(vaultAuthority),
      addressBytes.encode(TOKEN_2022 as Address),
      addressBytes.encode(mint),
    ],
  });
  const facilityId = fill(16, 0x11);
  const [facility, facilityBump] = await findFacilityPda({
    protocol,
    lenderOrg: lenderOrg as Address,
    facilityId,
  });
  const [valuation, valuationBump] = await getProgramDerivedAddress({
    programAddress: PROGRAM as Address,
    seeds: [
      text.encode("valuation"),
      addressBytes.encode(facility),
      addressBytes.encode(classPolicy),
      text.encode("G1"),
      addressBytes.encode(kopanoClass),
    ],
  });
  const [loan, loanBump] = await findLoanPda({ facility, loanIndex: 0 });
  const [lock, lockBump] = await findLockPda({ loan });
  const usd = text.encode("USD");
  const documentVersion = 1;
  const [document, documentBump] = await getProgramDerivedAddress({
    programAddress: PROGRAM as Address,
    seeds: [
      text.encode("document"),
      addressBytes.encode(protocol),
      new Uint8Array([DocumentKind.Departure]),
      addressBytes.encode(lot as Address),
      new Uint8Array([documentVersion, 0, 0, 0]),
    ],
  });

  // Port Terminal T1's Departure document for S3 (T063d.4 pre-check fold 3): version 2 of the lot's.
  const document2Version = 2;
  const [document2, document2Bump] = await getProgramDerivedAddress({
    programAddress: PROGRAM as Address,
    seeds: [
      text.encode("document"),
      addressBytes.encode(protocol),
      new Uint8Array([DocumentKind.Departure]),
      addressBytes.encode(lot as Address),
      new Uint8Array([document2Version, 0, 0, 0]),
    ],
  });
  const [loadingIntent, loadingIntentBump] = await findLoadingIntentPda({ position, nonce: 1n });
  const [acceptance, acceptanceBump] = await findAcceptancePda({ intent: loadingIntent, loan });

  // The two shipments, carried by Mosela Haulage (live-custody.md §9.1): one batch each, or, in
  // the partial variant, two for S2 (T063d.2 pre-check fold 4: program-custody.md §6.3's M2 split).
  type Route = {
    source: string;
    sourceCustodian: string;
    destination: string;
    destinationCustodian: string;
    document: string;
  };
  const shipmentInput = async (
    id: number,
    parts: { load: number; manifest: number; quantityKg: bigint }[],
    route: Route = {
      source: kopanoClass,
      sourceCustodian: kopano,
      destination: portClass,
      destinationCustodian: port,
      document,
    },
  ) => {
    const shipmentId = fill(16, id);
    const [address, bump] = await findShipmentPda({ protocol, shipmentId });
    const leafInputs = parts.map((part, index) => ({
      index,
      quantityKg: part.quantityKg,
      carrier: mosela,
      loadDigest: fill(32, part.load),
      manifestDigest: fill(32, part.manifest),
    }));
    const leaves = leafInputs.map((leafInput) => batchLeaf(leafInput));
    const batches = await Promise.all(
      leafInputs.map(async (leafInput, index) => {
        const [batch, batchBump] = await findBatchPda({
          protocol,
          loadDigest: leafInput.loadDigest,
        });
        return {
          address: batch as string,
          bump: batchBump,
          leafInput,
          proof: manifestProof(leaves, index),
        };
      }),
    );
    return { address, bump, shipmentId, root: manifestRoot(leaves), batches, route };
  };
  const s1 = await shipmentInput(0x22, [{ load: 0x33, manifest: 0x44, quantityKg: LOT_KG }]);
  const s2 = await shipmentInput(
    0x23,
    options.partial
      ? [
          { load: 0x55, manifest: 0x66, quantityKg: 3_000_000n },
          { load: 0x57, manifest: 0x67, quantityKg: 2_000_000n },
        ]
      : [{ load: 0x55, manifest: 0x66, quantityKg: LOT_KG }],
  );
  // S3 takes the loaded-for-nothing lot back from PORT-T1 (T063d.4 pre-check fold 3).
  const s3 = await shipmentInput(0x24, [{ load: 0x58, manifest: 0x68, quantityKg: LOT_KG }], {
    source: portClass,
    sourceCustodian: port,
    destination: kopanoClass,
    destinationCustodian: kopano,
    document: document2,
  });
  const haulierOrgId = Uint8Array.from(Buffer.from(HAULIER_ORG_ID.replaceAll("-", ""), "hex"));
  const [haulier, haulierBump] = await findOrganisationPda({ protocol, orgId: haulierOrgId });
  const haulierName = await findOrganisationNamePda(protocol, HAULIER_NAME);
  const haulierAdmin = await syntheticSigner(47);
  // Who signs a handover for each party (live-custody.md §9.1 keys; 47 is fold 3's).
  const carrierKey: Record<string, number> = {
    [kopano]: 43,
    [port]: 45,
    [mosela]: 46,
    [haulier]: 47,
  };

  // ---- the chain state the steps change ----
  const state = {
    kopanoOccupied: 0n,
    kopanoReserved: 0n,
    portReserved: 0n,
    portOccupied: 0n,
    lotRevision: 0n,
    lotState: LotState.Stored as LotState,
    lotClass: kopanoClass as string,
    positionRevision: 0n,
    lotSupply: LOT_KG,
    positionKg: LOT_KG,
    lockedKg: 0n,
    lockKg: LOT_KG,
    intakeRetired: false,
    loanCount: 0,
    issuedAt: 0n,
    valuationSetAt: 0n,
    loan: {
      principal: 0n,
      bookedInterest: 0n,
      accrualRemainder: 0n,
      accruedAt: 0n,
      revision: 0n,
      status: LoanStatus.Active as LoanStatus,
    },
    loading: {
      expiresAt: 0n,
      positionRevision: 0n,
      lockedKg: 0n,
      status: LoadingStatus.Open as LoadingStatus,
      executedAt: null as bigint | null,
    },
    acceptance: {
      version: 0,
      loanRevision: 0n,
      principal: 0n,
      bookedInterest: 0n,
      acceptedAt: 0n,
    },
    document2ValidUntil: 0n,
    intents: [] as {
      address: string;
      bump: number;
      nonce: bigint;
      quantityKg: bigint;
      price: bigint;
      expiresAt: bigint;
      positionRevision: bigint;
    }[],
    documentValidUntil: 0n,
    shipments: new Map<
      string,
      {
        status: ShipmentStatus;
        preparedAt: bigint;
        revision: bigint;
        registered: number;
        registeredKg: bigint;
        departed: number;
        departedKg: bigint;
        arrived: number;
        arrivedKg: bigint;
      }
    >(),
    batches: new Map<
      string,
      {
        holder: string;
        stage: BatchStage;
        sequence: bigint;
        observationCount: number;
        departedAt: bigint | null;
        arrivedAt: bigint | null;
      }
    >(),
  };

  const enc = {
    kopanoClass: () =>
      thetis(
        bytesOf(getCustodianClassEncoder(), {
          protocol,
          custodian: kopano,
          classPolicy,
          siteCode: KOPANO_SITE,
          approvedCapacityKg: KOPANO_CAPACITY_KG,
          occupiedKg: state.kopanoOccupied,
          reservedInboundKg: state.kopanoReserved,
          bump: kopanoClassBump,
        }),
      ),
    portClass: () =>
      thetis(
        bytesOf(getCustodianClassEncoder(), {
          protocol,
          custodian: port,
          classPolicy,
          siteCode: PORT_SITE,
          approvedCapacityKg: PORT_CAPACITY_KG,
          occupiedKg: state.portOccupied,
          reservedInboundKg: state.portReserved,
          bump: portClassBump,
        }),
      ),
    lot: () =>
      thetis(
        bytesOf(getLotEncoder(), {
          protocol,
          lotId: LOT_ID,
          classPolicy,
          classVersion: SEED.classVersion,
          grade: "G1",
          custodianClass: state.lotClass as Address,
          intake,
          parent: none(),
          root: lot,
          mint,
          supplyKg: state.lotSupply,
          state: state.lotState,
          restriction: Restriction.Normal,
          expiresAt: state.issuedAt + SEED.lotValiditySecs,
          revision: state.lotRevision,
          liveChildren: 0,
          bump: lotBump,
        }),
      ),
    position: () =>
      thetis(
        bytesOf(getPositionEncoder(), {
          protocol,
          lot,
          owner: khunou,
          quantityKg: state.positionKg,
          lockedKg: state.lockedKg,
          reservedKg: 0n,
          revision: state.positionRevision,
          bump: positionBump,
        }),
      ),
    facility: () =>
      thetis(
        bytesOf(getFacilityEncoder(), {
          protocol,
          lender: lenderOrg,
          borrower: khunou,
          facilityId,
          currency: usd,
          currencyDecimals: 2,
          termsVersion: 1,
          rateBps: 1200,
          maxLtvBps: 6000,
          termsDigest: fill(32, 0x21),
          loanCount: state.loanCount,
          bump: facilityBump,
        }),
      ),
    valuation: () =>
      thetis(
        bytesOf(getValuationEncoder(), {
          protocol,
          facility,
          classPolicy,
          grade: "G1",
          custodianClass: kopanoClass,
          valuePerKg: 20n,
          haircutBps: 0,
          validUntil: state.valuationSetAt + 30n * 86_400n,
          sourceDigest: fill(32, 0x22),
          version: 1,
          setAt: state.valuationSetAt,
          bump: valuationBump,
        }),
      ),
    loan: () =>
      thetis(
        bytesOf(getLoanEncoder(), {
          protocol,
          facility,
          borrower: khunou,
          lot,
          position,
          index: 0,
          status: state.loan.status,
          rateBps: 1200,
          termsVersion: 1,
          principal: state.loan.principal,
          bookedInterest: state.loan.bookedInterest,
          accrualRemainder: state.loan.accrualRemainder,
          accruedAt: state.loan.accruedAt,
          openExceptions: 0,
          revision: state.loan.revision,
          bump: loanBump,
        }),
      ),
    lock: () =>
      thetis(
        bytesOf(getLockAllocationEncoder(), {
          protocol,
          loan,
          position,
          quantityKg: state.lockKg,
          control: LockControl.Pledged,
          bump: lockBump,
        }),
      ),
    intent: (intent: (typeof state.intents)[number]) =>
      thetis(
        bytesOf(getReleaseIntentEncoder(), {
          protocol,
          loan,
          lot,
          position,
          seller: khunou,
          buyer,
          nonce: intent.nonce,
          quantityKg: intent.quantityKg,
          price: intent.price,
          topUp: 0n,
          currency: usd,
          expiresAt: intent.expiresAt,
          positionRevision: intent.positionRevision,
          status: IntentStatus.Open,
          bump: intent.bump,
        }),
      ),
    document: () =>
      thetis(
        bytesOf(getDocumentAttestationEncoder(), {
          protocol,
          kind: DocumentKind.Departure,
          subject: Uint8Array.from(addressBytes.encode(lot as Address)),
          version: documentVersion,
          issuer: kopano,
          sha256: fill(32, 0xdd),
          validUntil: state.documentValidUntil,
          revokedAt: none(),
          bump: documentBump,
        }),
      ),
    shipment: (input: typeof s1) => {
      const current = state.shipments.get(input.address);
      if (!current) throw new Error("the shipment is not prepared");
      return thetis(
        bytesOf(getShipmentEncoder(), {
          protocol,
          shipmentId: input.shipmentId,
          lot,
          position,
          owner: khunou,
          source: input.route.source as Address,
          sourceCustodian: input.route.sourceCustodian as Address,
          destination: input.route.destination as Address,
          destinationCustodian: input.route.destinationCustodian as Address,
          committedKg: LOT_KG,
          lockedKg: LOT_KG,
          batchCount: input.batches.length,
          manifestRoot: input.root,
          departureDocument: input.route.document as Address,
          registeredCount: current.registered,
          registeredKg: current.registeredKg,
          departedCount: current.departed,
          departedKg: current.departedKg,
          arrivedCount: current.arrived,
          arrivedKg: current.arrivedKg,
          status: current.status,
          preparedAt: current.preparedAt,
          revision: current.revision,
          bump: input.bump,
        }),
      );
    },
    batch: (input: typeof s1, index: number) => {
      const entry = input.batches[index] as (typeof input.batches)[number];
      const current = state.batches.get(entry.address);
      if (!current) throw new Error("the batch is not registered");
      return thetis(
        bytesOf(getManifestBatchEncoder(), {
          protocol,
          shipment: input.address,
          lot,
          index,
          batchCount: input.batches.length,
          quantityKg: entry.leafInput.quantityKg,
          carrier: mosela,
          loadDigest: entry.leafInput.loadDigest,
          manifestDigest: entry.leafInput.manifestDigest,
          holder: current.holder as Address,
          stage: current.stage,
          sequence: current.sequence,
          observationCount: current.observationCount,
          departedAt: current.departedAt === null ? none() : some(current.departedAt),
          arrivedAt: current.arrivedAt === null ? none() : some(current.arrivedAt),
          bump: entry.bump,
        }),
      );
    },
    haulier: () =>
      thetis(
        bytesOf(getOrganisationEncoder(), {
          protocol,
          orgId: haulierOrgId,
          role: Role.Transporter,
          displayName: HAULIER_NAME,
          admin: haulierAdmin.address,
          related: [],
          bump: haulierBump,
        }),
      ),
    intake: () =>
      thetis(
        bytesOf(getIntakeIdentityEncoder(), {
          protocol,
          custodian: kopano,
          intakeDigest,
          lot,
          retired: state.intakeRetired,
          bump: intakeBump,
        }),
      ),
    document2: () =>
      thetis(
        bytesOf(getDocumentAttestationEncoder(), {
          protocol,
          kind: DocumentKind.Departure,
          subject: Uint8Array.from(addressBytes.encode(lot as Address)),
          version: document2Version,
          issuer: port,
          sha256: fill(32, 0xde),
          validUntil: state.document2ValidUntil,
          revokedAt: none(),
          bump: document2Bump,
        }),
      ),
    loadingIntent: () =>
      thetis(
        bytesOf(getLoadingIntentEncoder(), {
          protocol,
          lot,
          position,
          owner: khunou,
          terminal: port,
          custodianClass: portClass,
          nonce: 1n,
          quantityKg: LOT_KG,
          lockedKg: state.loading.lockedKg,
          documentSha256: fill(32, 0xaa),
          positionRevision: state.loading.positionRevision,
          expiresAt: state.loading.expiresAt,
          status: state.loading.status,
          executedAt: state.loading.executedAt === null ? none() : some(state.loading.executedAt),
          bump: loadingIntentBump,
        }),
      ),
    acceptance: () =>
      thetis(
        bytesOf(getHandoffAcceptanceEncoder(), {
          protocol,
          intent: loadingIntent,
          loan,
          lock,
          lender: lenderOrg,
          lockQuantityKg: LOT_KG,
          loanRevision: state.acceptance.loanRevision,
          principal: state.acceptance.principal,
          bookedInterest: state.acceptance.bookedInterest,
          acceptedAt: state.acceptance.acceptedAt,
          version: state.acceptance.version,
          bump: acceptanceBump,
        }),
      ),
  };

  const tx = (
    signature: string,
    name: string,
    instruction: Parameters<typeof thetisTransaction>[0]["instruction"],
    event: Uint8Array,
    systemCpi = false,
  ): FakeTransaction =>
    thetisTransaction({
      signature,
      feePayer: sponsor.address,
      name,
      instruction,
      events: [event],
      systemCpi,
    });

  const prepare = (input: typeof s1, now: bigint, signature: string) => {
    const expectedRevision = state.lotRevision;
    state.lotRevision += 1n;
    state.positionRevision += 1n;
    state.lotState = LotState.Prepared;
    const toPort = input.route.destination === portClass;
    if (toPort) state.portReserved += LOT_KG;
    else state.kopanoReserved += LOT_KG;
    state.shipments.set(input.address, {
      status: ShipmentStatus.Prepared,
      preparedAt: now,
      revision: 0n,
      registered: 0,
      registeredKg: 0n,
      departed: 0,
      departedKg: 0n,
      arrived: 0,
      arrivedKg: 0n,
    });
    return {
      tx: tx(
        signature,
        "PrepareShipment",
        getPrepareShipmentInstruction({
          sponsor,
          protocol,
          ownerOrg: khunou as Address,
          ownerAuthority,
          lot: lot as Address,
          position,
          sourceClass: input.route.source as Address,
          destinationClass: input.route.destination as Address,
          destinationOrg: input.route.destinationCustodian as Address,
          departureDocument: input.route.document as Address,
          departureIssuer: input.route.sourceCustodian as Address,
          shipment: input.address,
          shipmentId: input.shipmentId,
          batchCount: input.batches.length,
          manifestRoot: input.root,
          expectedRevision,
          validUntil: now + 570n,
        }),
        bytesOf(getShipmentPreparedEventEncoder(), {
          shipment: input.address,
          lot,
          owner: khunou,
          source: input.route.source,
          destination: input.route.destination,
          committedKg: LOT_KG,
          lockedKg: LOT_KG,
          batchCount: input.batches.length,
          manifestRoot: input.root,
          departureDocument: input.route.document,
          lotRevision: state.lotRevision,
          positionRevision: state.positionRevision,
        }),
        true,
      ),
      accounts: {
        [input.address]: enc.shipment(input),
        [lot]: enc.lot(),
        [position]: enc.position(),
        ...(toPort ? { [portClass]: enc.portClass() } : { [kopanoClass]: enc.kopanoClass() }),
      },
    };
  };
  const register = (input: typeof s1, index: number, signature: string) => {
    const current = state.shipments.get(input.address);
    if (!current) throw new Error("the shipment is not prepared");
    const entry = input.batches[index] as (typeof input.batches)[number];
    current.registered += 1;
    current.registeredKg += entry.leafInput.quantityKg;
    state.batches.set(entry.address, {
      holder: kopano,
      stage: BatchStage.AtSource,
      sequence: 0n,
      observationCount: 0,
      departedAt: null,
      arrivedAt: null,
    });
    return {
      tx: thetisTransaction({
        signature,
        feePayer: sponsor.address,
        name: "RegisterBatch",
        systemCpi: true,
        instruction: getRegisterBatchInstruction({
          payer: sponsor,
          protocol,
          shipment: input.address,
          batch: entry.address as Address,
          index,
          quantityKg: entry.leafInput.quantityKg,
          carrier: mosela as Address,
          loadDigest: entry.leafInput.loadDigest,
          manifestDigest: entry.leafInput.manifestDigest,
          proof: entry.proof,
        }),
        events: [
          bytesOf(getBatchRegisteredEventEncoder(), {
            batch: entry.address,
            shipment: input.address,
            index,
            quantityKg: entry.leafInput.quantityKg,
            carrier: mosela,
            loadDigest: entry.leafInput.loadDigest,
            manifestDigest: entry.leafInput.manifestDigest,
            registeredCount: current.registered,
          }),
        ],
      }),
      accounts: {
        [entry.address]: enc.batch(input, index),
        [input.address]: enc.shipment(input),
      },
    };
  };

  // handover.rs, step 5 and step 7: the stage from the batch's stage and the recipient, then the
  // writes. The first departure moves the lot to InTransit, the last arrival to Stored at PORT-T1.
  const handover = async (
    input: typeof s1,
    index: number,
    from: string,
    to: string,
    now: bigint,
    signature: string,
    step: CustodyStep,
  ) => {
    const shipment = state.shipments.get(input.address);
    const entry = input.batches[index] as (typeof input.batches)[number];
    const batch = state.batches.get(entry.address);
    if (!shipment || !batch) throw new Error("the batch is not registered");
    if (batch.holder !== from) throw new Error(`${step}: the batch is not held by ${from}`);
    const stage =
      batch.stage === BatchStage.AtSource
        ? HandoverStage.Departure
        : to === port
          ? HandoverStage.Arrival
          : HandoverStage.Transfer;
    const q = entry.leafInput.quantityKg;
    const expectedSequence = batch.sequence;
    const [record, recordBump] = await findHandoverPda({
      batch: entry.address as Address,
      expectedSequence,
    });
    handovers[step] = record;
    if (stage === HandoverStage.Departure) {
      state.kopanoOccupied -= q;
      shipment.departed += 1;
      shipment.departedKg += q;
      if (shipment.status === ShipmentStatus.Prepared) {
        state.lotRevision += 1n;
        shipment.status = ShipmentStatus.InTransit;
        state.lotState = LotState.InTransit;
      }
      batch.stage = BatchStage.InTransit;
      batch.departedAt = now;
    }
    if (stage === HandoverStage.Arrival) {
      state.portReserved -= q;
      state.portOccupied += q;
      shipment.arrived += 1;
      shipment.arrivedKg += q;
      if (shipment.arrived === input.batches.length) {
        state.lotRevision += 1n;
        shipment.status = ShipmentStatus.Arrived;
        state.lotState = LotState.Stored;
        state.lotClass = portClass;
      }
      batch.stage = BatchStage.Arrived;
      batch.arrivedAt = now;
    }
    batch.holder = to;
    batch.sequence += 1n;
    shipment.revision += 1n;
    const fromSigner = await syntheticSigner(carrierKey[from] as number);
    const toSigner = await syntheticSigner(carrierKey[to] as number);
    return {
      tx: tx(
        signature,
        "Handover",
        getHandoverInstruction({
          sponsor,
          protocol,
          shipment: input.address,
          batch: entry.address as Address,
          lot: lot as Address,
          fromOrg: from as Address,
          fromAuthority: await authorityOf(carrierKey[from] as number),
          toOrg: to as Address,
          toAuthority: await authorityOf(carrierKey[to] as number),
          sourceClass: kopanoClass,
          destinationClass: portClass,
          ...(stage === HandoverStage.Departure ? { departureDocument: document } : {}),
          handover: record,
          manifestDigest: entry.leafInput.manifestDigest,
          expectedSequence,
          validUntil: now + 570n,
        }),
        bytesOf(getCustodyHandedOverEventEncoder(), {
          handover: record,
          batch: entry.address,
          shipment: input.address,
          lot,
          sequence: expectedSequence,
          from,
          to,
          stage,
          quantityKg: q,
          shipmentStatus: shipment.status,
          lotState: state.lotState,
          shipmentRevision: shipment.revision,
          lotRevision: state.lotRevision,
        }),
        true,
      ),
      accounts: {
        [record]: thetis(
          bytesOf(getHandoverRecordEncoder(), {
            protocol,
            batch: entry.address,
            shipment: input.address,
            sequence: expectedSequence,
            from,
            to,
            fromWallet: fromSigner.address,
            toWallet: toSigner.address,
            stage,
            quantityKg: q,
            manifestDigest: entry.leafInput.manifestDigest,
            at: now,
            bump: recordBump,
          }),
        ),
        [entry.address]: enc.batch(input, index),
        [input.address]: enc.shipment(input),
        [lot]: enc.lot(),
        [kopanoClass]: enc.kopanoClass(),
        [portClass]: enc.portClass(),
      },
    };
  };

  // observation.rs, steps 4 and 7: a Border observation by the batch's holder (a Transporter), at
  // the block time; only the batch's observation_count moves (live-custody.md §9.1, 256 → 237).
  const observe = async (
    input: typeof s1,
    index: number,
    observer: string,
    now: bigint,
    signature: string,
  ) => {
    const entry = input.batches[index] as (typeof input.batches)[number];
    const batch = state.batches.get(entry.address);
    if (!batch) throw new Error("the batch is not registered");
    const expectedObservation = batch.observationCount;
    batch.observationCount += 1;
    const evidenceDigest = fill(32, 0x77);
    return {
      tx: tx(
        signature,
        "RecordObservation",
        getRecordObservationInstruction({
          sponsor,
          protocol,
          observerOrg: observer as Address,
          observerAuthority: await authorityOf(carrierKey[observer] as number),
          holderOrg: batch.holder as Address,
          shipment: input.address,
          batch: entry.address as Address,
          lot: lot as Address,
          kind: ObservationKind.Border,
          locationCode: "BORDER-1",
          evidenceDigest,
          observedAt: now,
          expectedObservation,
          validUntil: now + 570n,
        }),
        bytesOf(getObservationRecordedEventEncoder(), {
          batch: entry.address,
          shipment: input.address,
          lot,
          observer,
          holder: batch.holder,
          kind: ObservationKind.Border,
          locationCode: "BORDER-1",
          evidenceDigest,
          observedAt: now,
          index: expectedObservation,
        }),
      ),
      accounts: { [entry.address]: enc.batch(input, index) },
    };
  };

  const order: CustodyStep[] = [
    "accreditKopano",
    "accreditPort",
    "issueLot",
    "openFacility",
    "setValuation",
    "pledge",
    "recordAdvance",
    "createReleaseIntent",
    ...(options.secondIntent ? (["createReleaseIntent2"] as const) : []),
    "attestDeparture",
    "prepareS1",
    "registerB1",
    "cancelS1",
    "prepareS2",
    "registerB2",
    ...(options.partial ? (["registerB3"] as const) : []),
    ...(options.route
      ? options.partial
        ? (["departB2", "departB3", "arriveB2", "arriveB3"] as const)
        : options.transfer
          ? (["departB2", "accreditHaulier", "transferB2", "arriveB2"] as const)
          : (["departB2", "observeB2", "arriveB2"] as const)
      : []),
    ...(options.route && options.loading === "record"
      ? ([
          "createLoadingIntent",
          "acceptLoading",
          ...(options.reaccept ? (["reacceptLoading"] as const) : []),
          "recordLoading",
        ] as const)
      : []),
    ...(options.route && options.loading === "ship"
      ? (["createLoadingIntent", "attestDeparture2", "prepareS3"] as const)
      : []),
  ];
  const handovers: CustodyScenario["handovers"] = {};
  const firstTime = Date.parse("2026-11-28T00:00:00Z");
  const timeAt = (index: number) => new Date(firstTime + index * 1000).toISOString();
  const prepareS1At = unix(timeAt(order.indexOf("prepareS1")));
  const steps: CustodyScenario["steps"] = {};
  const history: History = [];
  for (const [index, step] of order.entries()) {
    const slot = 51_000 + index * 1000;
    const blockTime = timeAt(index);
    const now = unix(blockTime);
    const signature = syntheticSignature(STEP_SIGNATURE[step]);
    steps[step] = { signature, slot, blockTime };
    let made: { tx: FakeTransaction; accounts: Record<string, AccountState> };
    switch (step) {
      case "accreditKopano":
      case "accreditPort": {
        const kopanoStep = step === "accreditKopano";
        const custodianClass = kopanoStep ? kopanoClass : portClass;
        const capacity = kopanoStep ? KOPANO_CAPACITY_KG : PORT_CAPACITY_KG;
        made = {
          tx: thetisTransaction({
            signature,
            feePayer: deployer.address,
            name: "AccreditCustodianClass",
            systemCpi: true,
            instruction: getAccreditCustodianClassInstruction({
              protocol,
              custodian: (kopanoStep ? kopano : port) as Address,
              classPolicy,
              custodianClass,
              accreditor,
              payer: deployer,
              siteCode: kopanoStep ? KOPANO_SITE : PORT_SITE,
              approvedCapacityKg: capacity,
            }),
            events: [
              bytesOf(getCustodianClassAccreditedEventEncoder(), {
                custodianClass,
                approvedCapacityKg: capacity,
              }),
            ],
          }),
          accounts: { [custodianClass]: kopanoStep ? enc.kopanoClass() : enc.portClass() },
        };
        break;
      }
      case "issueLot":
        state.issuedAt = now;
        state.kopanoOccupied = LOT_KG;
        made = {
          tx: tx(
            signature,
            "IssueLot",
            getIssueLotInstruction({
              sponsor,
              protocol,
              authority: custodianAuthority,
              owner: khunou as Address,
              custodian: kopano as Address,
              classPolicy,
              custodianClass: kopanoClass,
              intake,
              lot: lot as Address,
              mint,
              mintAuthority,
              position,
              vaultAuthority,
              vault,
              lotId: LOT_ID,
              grade: "G1",
              quantityKg: LOT_KG,
              intakeDigest,
              validUntil: now + 270n,
            }),
            bytesOf(getLotIssuedEventEncoder(), {
              lot,
              owner: khunou,
              quantityKg: LOT_KG,
              intake,
              revision: 0n,
            }),
            true,
          ),
          accounts: {
            [lot]: enc.lot(),
            [intake]: thetis(
              bytesOf(getIntakeIdentityEncoder(), {
                protocol,
                custodian: kopano,
                intakeDigest,
                lot,
                retired: false,
                bump: intakeBump,
              }),
            ),
            [position]: enc.position(),
            [kopanoClass]: enc.kopanoClass(),
          },
        };
        break;
      case "openFacility":
        made = {
          tx: tx(
            signature,
            "OpenFacility",
            getOpenFacilityInstruction({
              lender: lenderWallet,
              payer: sponsor,
              protocol,
              authority: lenderAuthority,
              lenderOrg: lenderOrg as Address,
              borrowerOrg: khunou as Address,
              facility,
              facilityId,
              currency: usd,
              currencyDecimals: 2,
              termsVersion: 1,
              rateBps: 1200,
              maxLtvBps: 6000,
              termsDigest: fill(32, 0x21),
            }),
            bytesOf(getFacilityOpenedEventEncoder(), {
              facility,
              lender: lenderOrg,
              borrower: khunou,
              currency: usd,
              currencyDecimals: 2,
              termsVersion: 1,
              rateBps: 1200,
              maxLtvBps: 6000,
            }),
            true,
          ),
          accounts: { [facility]: enc.facility() },
        };
        break;
      case "setValuation":
        state.valuationSetAt = now;
        made = {
          tx: tx(
            signature,
            "SetValuation",
            getSetValuationInstruction({
              lender: lenderWallet,
              payer: sponsor,
              protocol,
              authority: lenderAuthority,
              lenderOrg: lenderOrg as Address,
              facility,
              classPolicy,
              custodianClass: kopanoClass,
              valuation,
              grade: "G1",
              valuePerKg: 20n,
              haircutBps: 0,
              validUntil: now + 30n * 86_400n,
              sourceDigest: fill(32, 0x22),
            }),
            bytesOf(getValuationSetEventEncoder(), {
              valuation,
              facility,
              version: 1,
              valuePerKg: 20n,
              haircutBps: 0,
              validUntil: now + 30n * 86_400n,
              sourceDigest: fill(32, 0x22),
              setAt: now,
            }),
            true,
          ),
          accounts: { [valuation]: enc.valuation() },
        };
        break;
      case "pledge": {
        const expectedRevision = state.positionRevision;
        state.loanCount = 1;
        state.lockedKg = LOT_KG;
        state.positionRevision += 1n;
        state.loan.accruedAt = now;
        made = {
          tx: tx(
            signature,
            "Pledge",
            getPledgeInstruction({
              sponsor,
              protocol,
              lot: lot as Address,
              position,
              borrowerOrg: khunou as Address,
              borrowerAuthority: ownerAuthority,
              lenderOrg: lenderOrg as Address,
              lenderAuthority,
              facility,
              loan,
              lock,
              loanIndex: 0,
              quantityKg: LOT_KG,
              expectedRevision,
              validUntil: now + 270n,
            }),
            bytesOf(getPledgedEventEncoder(), {
              loan,
              lock,
              position,
              lot,
              quantityKg: LOT_KG,
              positionRevision: state.positionRevision,
              revision: 0n,
            }),
            true,
          ),
          accounts: {
            [loan]: enc.loan(),
            [lock]: enc.lock(),
            [position]: enc.position(),
            [facility]: enc.facility(),
          },
        };
        break;
      }
      case "recordAdvance": {
        const expectedRevision = state.loan.revision;
        const { interest, remainder } = accrueSimple({
          principal: state.loan.principal,
          rateBps: 1200n,
          elapsedSeconds: now - state.loan.accruedAt,
          carriedRemainder: state.loan.accrualRemainder,
        });
        state.loan.bookedInterest += interest;
        state.loan.accrualRemainder = remainder;
        state.loan.accruedAt = now;
        state.loan.principal += 60_000_000n;
        state.loan.revision += 1n;
        made = {
          tx: tx(
            signature,
            "RecordAdvance",
            getRecordAdvanceInstruction({
              lender: lenderWallet,
              protocol,
              lenderAuthority,
              lenderOrg: lenderOrg as Address,
              facility,
              loan,
              lock,
              lot: lot as Address,
              valuation,
              borrowerOrg: khunou as Address,
              borrowerAuthority: ownerAuthority,
              amount: 60_000_000n,
              currency: usd,
              expectedRevision,
              validUntil: now + 270n,
            }),
            bytesOf(getAdvanceRecordedEventEncoder(), {
              loan,
              amount: 60_000_000n,
              principal: state.loan.principal,
              bookedInterest: state.loan.bookedInterest,
              revision: state.loan.revision,
            }),
          ),
          accounts: { [loan]: enc.loan() },
        };
        break;
      }
      case "createReleaseIntent":
      case "createReleaseIntent2": {
        const first = step === "createReleaseIntent";
        const nonce = first ? 1n : 2n;
        const [address, bump] = await findIntentPda({ loan, nonce });
        const intent = {
          address,
          bump,
          nonce,
          quantityKg: first ? 2_000_000n : 1_000_000n,
          price: first ? 40_000_000n : 10_000_000n,
          expiresAt: first ? now + 86_400n : prepareS1At,
          positionRevision: state.positionRevision,
        };
        state.intents.push(intent);
        made = {
          tx: tx(
            signature,
            "CreateReleaseIntent",
            getCreateReleaseIntentInstruction({
              sponsor,
              protocol,
              sellerOrg: khunou as Address,
              sellerAuthority: ownerAuthority,
              buyerOrg: buyer as Address,
              lenderOrg: lenderOrg as Address,
              facility,
              loan,
              lock,
              lot: lot as Address,
              position,
              intent: address,
              nonce,
              quantityKg: intent.quantityKg,
              price: intent.price,
              topUp: 0n,
              expiresAt: intent.expiresAt,
              expectedRevision: state.positionRevision,
              validUntil: now + 270n,
            }),
            bytesOf(getReleaseIntentCreatedEventEncoder(), {
              intent: address,
              loan,
              seller: khunou,
              buyer,
              quantityKg: intent.quantityKg,
              price: intent.price,
              topUp: 0n,
              expiresAt: intent.expiresAt,
            }),
            true,
          ),
          accounts: { [address]: enc.intent(intent) },
        };
        break;
      }
      case "attestDeparture":
        state.documentValidUntil = now + 30n * 86_400n;
        made = {
          tx: tx(
            signature,
            "AttestDocument",
            getAttestDocumentInstruction({
              protocol,
              organisation: kopano as Address,
              authority: custodianAuthority,
              document,
              wallet: custodianWallet,
              payer: sponsor,
              kind: DocumentKind.Departure,
              subject: Uint8Array.from(addressBytes.encode(lot as Address)),
              version: documentVersion,
              sha256: fill(32, 0xdd),
              validUntil: state.documentValidUntil,
            }),
            bytesOf(getDocumentAttestedEventEncoder(), {
              document,
              kind: DocumentKind.Departure,
              subject: Uint8Array.from(addressBytes.encode(lot as Address)),
              version: documentVersion,
            }),
            true,
          ),
          accounts: { [document]: enc.document() },
        };
        break;
      case "prepareS1":
        made = prepare(s1, now, signature);
        break;
      case "prepareS2":
        made = prepare(s2, now, signature);
        break;
      case "registerB1":
        made = register(s1, 0, signature);
        break;
      case "registerB2":
        made = register(s2, 0, signature);
        break;
      case "registerB3":
        made = register(s2, 1, signature);
        break;
      case "departB2":
        made = await handover(s2, 0, kopano, mosela, now, signature, step);
        break;
      case "departB3":
        made = await handover(s2, 1, kopano, mosela, now, signature, step);
        break;
      case "observeB2":
        made = await observe(s2, 0, mosela, now, signature);
        break;
      case "transferB2":
        made = await handover(s2, 0, mosela, haulier, now, signature, step);
        break;
      case "arriveB2":
        made = await handover(
          s2,
          0,
          options.transfer ? haulier : mosela,
          port,
          now,
          signature,
          step,
        );
        break;
      case "arriveB3":
        made = await handover(s2, 1, mosela, port, now, signature, step);
        break;
      case "accreditHaulier":
        made = {
          tx: thetisTransaction({
            signature,
            feePayer: deployer.address,
            name: "AccreditOrganisation",
            systemCpi: true,
            instruction: getAccreditOrganisationInstruction({
              protocol,
              organisation: haulier,
              organisationName: haulierName,
              accreditor,
              payer: deployer,
              orgId: haulierOrgId,
              role: Role.Transporter,
              displayName: HAULIER_NAME,
              admin: haulierAdmin.address,
            }),
            events: [
              bytesOf(getOrganisationAccreditedEventEncoder(), {
                organisation: haulier,
                role: Role.Transporter,
              }),
            ],
          }),
          accounts: {
            [haulier]: enc.haulier(),
            [haulierName]: thetis(bytesOf(getOrganisationNameEncoder(), {})),
          },
        };
        break;
      case "createLoadingIntent": {
        // loading.rs create_loading_intent, step 7: the intent snapshots the whole position and
        // bumps its revision (live-custody.md §9.1 loadingHistory, 258 → 224).
        const expectedRevision = state.positionRevision;
        state.positionRevision += 1n;
        state.loading.positionRevision = state.positionRevision;
        state.loading.lockedKg = state.lockedKg;
        state.loading.expiresAt = now + 86_400n;
        const documentSha256 = fill(32, 0xaa);
        made = {
          tx: tx(
            signature,
            "CreateLoadingIntent",
            getCreateLoadingIntentInstruction({
              sponsor,
              protocol,
              ownerOrg: khunou as Address,
              ownerAuthority,
              lot: lot as Address,
              position,
              custodianClass: portClass,
              terminalOrg: port as Address,
              intent: loadingIntent,
              nonce: 1n,
              documentSha256,
              expiresAt: state.loading.expiresAt,
              expectedRevision,
              validUntil: now + 570n,
            }),
            bytesOf(getLoadingIntentCreatedEventEncoder(), {
              intent: loadingIntent,
              lot,
              position,
              owner: khunou,
              terminal: port,
              quantityKg: LOT_KG,
              lockedKg: state.loading.lockedKg,
              documentSha256,
              expiresAt: state.loading.expiresAt,
              positionRevision: state.loading.positionRevision,
            }),
            true,
          ),
          accounts: { [loadingIntent]: enc.loadingIntent(), [position]: enc.position() },
        };
        break;
      }
      case "acceptLoading":
      case "reacceptLoading": {
        // loading.rs accept_loading, step 6: Lender One's consent snapshots the loan and the lock.
        const first = state.acceptance.version === 0;
        state.acceptance.version += 1;
        state.acceptance.loanRevision = state.loan.revision;
        state.acceptance.principal = state.loan.principal;
        state.acceptance.bookedInterest = state.loan.bookedInterest;
        state.acceptance.acceptedAt = now;
        made = {
          tx: tx(
            signature,
            "AcceptLoading",
            getAcceptLoadingInstruction({
              lender: lenderWallet,
              payer: sponsor,
              protocol,
              authority: lenderAuthority,
              lenderOrg: lenderOrg as Address,
              facility,
              loan,
              lock,
              lot: lot as Address,
              position,
              intent: loadingIntent,
              acceptance,
              expectedRevision: state.loan.revision,
            }),
            bytesOf(getLoadingAcceptedEventEncoder(), {
              acceptance,
              intent: loadingIntent,
              loan,
              lender: lenderOrg,
              lockQuantityKg: state.lockKg,
              loanRevision: state.acceptance.loanRevision,
              principal: state.acceptance.principal,
              bookedInterest: state.acceptance.bookedInterest,
              version: state.acceptance.version,
            }),
            first,
          ),
          accounts: { [acceptance]: enc.acceptance() },
        };
        break;
      }
      case "recordLoading": {
        // loading.rs record_loading, steps 6, 7 and 9: the receipts burned, PORT-T1 freed, the
        // intake retired (no children), the loan accrued and handed off with its debt.
        const expectedRevision = state.positionRevision;
        const { interest, remainder } = accrueSimple({
          principal: state.loan.principal,
          rateBps: 1200n,
          elapsedSeconds: now - state.loan.accruedAt,
          carriedRemainder: state.loan.accrualRemainder,
        });
        state.loan.bookedInterest += interest;
        state.loan.accrualRemainder = remainder;
        state.loan.accruedAt = now;
        const externalHandoff = state.loan.principal > 0n || state.loan.bookedInterest > 0n;
        if (externalHandoff) state.loan.status = LoanStatus.ExternalHandoff;
        state.loan.revision += 1n;
        const releasedKg = state.lockKg;
        state.lockKg = 0n;
        state.positionKg = 0n;
        state.lockedKg = 0n;
        state.positionRevision += 1n;
        state.lotSupply = 0n;
        state.lotRevision += 1n;
        state.lotState = LotState.Loaded;
        state.portOccupied -= LOT_KG;
        state.intakeRetired = true;
        state.loading.status = LoadingStatus.Executed;
        state.loading.executedAt = now;
        const instruction = getRecordLoadingInstruction({
          sponsor,
          protocol,
          ownerOrg: khunou as Address,
          ownerAuthority,
          terminalOrg: port as Address,
          terminalAuthority: await authorityOf(45),
          custodianClass: portClass,
          lot: lot as Address,
          intake,
          mint,
          position,
          vaultAuthority,
          vault: vault as Address,
          intent: loadingIntent,
          instructions: SYSVAR_INSTRUCTIONS as Address,
          tokenProgram: TOKEN_2022 as Address,
          expectedRevision,
          validUntil: now + 570n,
        });
        made = {
          tx: thetisTransaction({
            signature,
            feePayer: sponsor.address,
            name: "RecordLoading",
            // The triple (acceptance, loan, lock) after the IDL accounts (program-custody.md §6.1).
            instruction: {
              ...instruction,
              accounts: [
                ...instruction.accounts,
                { address: acceptance, role: AccountRole.READONLY },
                { address: loan, role: AccountRole.WRITABLE },
                { address: lock, role: AccountRole.WRITABLE },
              ],
            },
            events: [
              bytesOf(getLoadingRecordedEventEncoder(), {
                intent: loadingIntent,
                lot,
                position,
                owner: khunou,
                terminal: port,
                quantityKg: LOT_KG,
                documentSha256: fill(32, 0xaa),
                loansAccepted: 1,
                lotLoaded: true,
                lotRevision: state.lotRevision,
                positionRevision: state.positionRevision,
              }),
              bytesOf(getLoanHandedOffEventEncoder(), {
                loan,
                intent: loadingIntent,
                releasedKg,
                principal: state.loan.principal,
                bookedInterest: state.loan.bookedInterest,
                externalHandoff,
                revision: state.loan.revision,
              }),
            ],
          }),
          accounts: {
            [lot]: enc.lot(),
            [position]: enc.position(),
            [loadingIntent]: enc.loadingIntent(),
            [portClass]: enc.portClass(),
            [intake]: enc.intake(),
            [loan]: enc.loan(),
            [lock]: enc.lock(),
          },
        };
        break;
      }
      case "attestDeparture2":
        state.document2ValidUntil = now + 30n * 86_400n;
        made = {
          tx: tx(
            signature,
            "AttestDocument",
            getAttestDocumentInstruction({
              protocol,
              organisation: port as Address,
              authority: await authorityOf(45),
              document: document2,
              wallet: await syntheticSigner(45),
              payer: sponsor,
              kind: DocumentKind.Departure,
              subject: Uint8Array.from(addressBytes.encode(lot as Address)),
              version: document2Version,
              sha256: fill(32, 0xde),
              validUntil: state.document2ValidUntil,
            }),
            bytesOf(getDocumentAttestedEventEncoder(), {
              document: document2,
              kind: DocumentKind.Departure,
              subject: Uint8Array.from(addressBytes.encode(lot as Address)),
              version: document2Version,
            }),
            true,
          ),
          accounts: { [document2]: enc.document2() },
        };
        break;
      case "prepareS3":
        made = prepare(s3, now, signature);
        break;
      case "cancelS1": {
        const current = state.shipments.get(s1.address);
        if (!current) throw new Error("S1 is not prepared");
        const expectedRevision = current.revision;
        current.status = ShipmentStatus.Cancelled;
        current.revision += 1n;
        state.lotRevision += 1n;
        state.lotState = LotState.Stored;
        state.portReserved -= LOT_KG;
        made = {
          tx: tx(
            signature,
            "CancelShipment",
            getCancelShipmentInstruction({
              sponsor,
              protocol,
              ownerOrg: khunou as Address,
              ownerAuthority,
              lot: lot as Address,
              shipment: s1.address,
              destinationClass: portClass,
              destinationOrg: port as Address,
              expectedRevision,
              validUntil: now + 570n,
            }),
            bytesOf(getShipmentCancelledEventEncoder(), {
              shipment: s1.address,
              lot,
              releasedKg: LOT_KG,
              lotRevision: state.lotRevision,
              revision: current.revision,
            }),
          ),
          accounts: {
            [s1.address]: enc.shipment(s1),
            [lot]: enc.lot(),
            [portClass]: enc.portClass(),
          },
        };
        break;
      }
    }
    history.push({ slot, blockTime, transactions: [made.tx], accounts: made.accounts });
  }

  return {
    history: cloneHistory([...(await seedHistory()), ...history]),
    steps,
    protocol,
    org,
    classes: { kopano: kopanoClass, port: portClass },
    lot,
    position,
    facility,
    loan,
    intents: state.intents.map((intent) => intent.address),
    document,
    shipments: {
      s1: s1.address,
      s2: s2.address,
      ...(options.loading === "ship" ? { s3: s3.address } : {}),
    },
    batches: {
      b1: s1.batches[0]?.address as string,
      b2: s2.batches[0]?.address as string,
      ...(s2.batches[1] ? { b3: s2.batches[1].address } : {}),
    },
    handovers,
    ...(options.transfer ? { haulier } : {}),
    preparedAt: {
      s1: state.shipments.get(s1.address)?.preparedAt ?? 0n,
      s2: state.shipments.get(s2.address)?.preparedAt ?? 0n,
    },
    intake,
    lock,
    ...(options.loading ? { loadingIntent, acceptance } : {}),
    firstSignature: f.seedSignatures.deploy,
  };
}

/**
 * custodyHistory() then S2's route (live-custody.md §9.1, routeHistory with the observation): B2
 * departs Kopano Stockyard Custody to Mosela Haulage, Mosela records a Border observation at
 * BORDER-1 (signature 237, T063d.3 pre-check fold 2), then B2 arrives at Port Terminal T1. `transfer` hands B2
 * to Haulier Two Test Org in transit first; `partial` ships S2 as two batches that both depart and
 * arrive (T063d.2 pre-check folds 3 and 4).
 */
export async function routeHistory(
  options: { transfer?: boolean; partial?: boolean } = {},
): Promise<CustodyScenario> {
  return custodyHistory({ ...options, route: true });
}

/**
 * routeHistory() then the loading (live-custody.md §9.1 loadingHistory, T063d.4 pre-check folds 2
 * and 3): Khunou's loading intent at PORT-T1 (224), Lender One's acceptance (225; `reaccept` adds
 * version 2 at 227), and the loading by Khunou and Port Terminal T1 (226). `ship` replaces the
 * acceptance and the loading with Port Terminal T1's Departure document v2 (228) and S3 to
 * KOPANO-YARD-1 (229), which leaves the intent stale.
 */
export async function loadingHistory(
  options: { reaccept?: boolean; ship?: boolean } = {},
): Promise<CustodyScenario> {
  return custodyHistory({
    route: true,
    loading: options.ship ? "ship" : "record",
    ...(options.reaccept ? { reaccept: true } : {}),
  });
}
