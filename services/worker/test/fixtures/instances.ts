// Fixtures for a second protocol instance on the same program, as devnet has it: the
// "token-simulation" instance, seeded by scripts/seed-demo.ts next to "fiat-attestation".
//
// SYNTHETIC: keys, the test mint, signatures, slots and block times are made up (synthetic.ts).
// The two protocol addresses follow from the public instance ids and are derived here; the tests
// compare them with the addresses README.md records for devnet.

import { type Address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import {
  findOrganisationPda,
  findProtocolPda,
  getClassPolicyEncoder,
  getClassRegisteredEventEncoder,
  getOrganisationAccreditedEventEncoder,
  getOrganisationEncoder,
  getOrganisationNameEncoder,
  getPauseInstruction,
  getPoolOpenedEventEncoder,
  getProtocolEncoder,
  getProtocolInitializedEventEncoder,
  getSimulationPoolEncoder,
  QuantityUnit,
  Role,
  SettlementMode,
} from "@thetis/contracts";
import {
  buildAccreditOrganisation,
  buildInitializeProtocol,
  buildOpenPool,
  buildRegisterClass,
  DEFAULT_INSTANCE,
  derivePoolAddresses,
  findClassPolicyPda,
  findOrganisationNamePda,
  type InstanceSpec,
  instanceIdBytes,
  SEED,
  SIMULATION,
  SIMULATION_INSTANCE,
} from "../../../../scripts/seed-demo.ts";
import {
  bytesOf,
  type FakeTransaction,
  fixture,
  type History,
  PROGRAM,
  syntheticSignature,
  syntheticSigner,
  thetis,
  thetisLogs,
  thetisTransaction,
  toFakeInstruction,
} from "./synthetic.ts";

/** The devnet addresses README.md records for the two instances ("Seed transactions", "Simulation instance"). */
export const README_FIAT_PROTOCOL = "G9GNDdbYKQY14xv1xgNw1D6EY8SFnZxgHrDBdEbHsoo3";
export const README_SIMULATION_PROTOCOL = "7fQ15qzKyWGX1dfXG78tS3pEWjPDsDbaYVHNUgi3HoGa";

const text = new TextEncoder();
const addressBytes = getAddressEncoder();

async function signers() {
  return {
    deployer: await syntheticSigner(1),
    admin: await syntheticSigner(2),
    accreditor: await syntheticSigner(3),
  };
}

/** SYNTHETIC: the simulation's test mint (key n = 34). */
export async function simulationMint(): Promise<string> {
  return (await syntheticSigner(34)).address;
}

export async function protocolOf(instance: InstanceSpec): Promise<string> {
  const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes(instance) });
  return protocol;
}

/** `open_pool USD` for an instance, with its PoolOpened event line, as scripts/seed-demo.ts sends it. */
export async function openPool(
  signature: string,
  instance: InstanceSpec,
): Promise<FakeTransaction> {
  const all = await signers();
  const mint = await simulationMint();
  const protocol = await protocolOf(instance);
  const { pool } = await derivePoolAddresses(protocol as Address, mint as Address);
  return thetisTransaction({
    signature,
    feePayer: all.deployer.address,
    name: "OpenPool",
    systemCpi: true,
    instruction: await buildOpenPool(all, mint as Address, instance),
    events: [
      bytesOf(getPoolOpenedEventEncoder(), {
        pool,
        mint,
        currency: text.encode(SIMULATION.currency),
        currencyDecimals: SIMULATION.mintDecimals,
      }),
    ],
  });
}

export async function initializeProtocol(
  signature: string,
  instance: InstanceSpec,
): Promise<FakeTransaction> {
  const all = await signers();
  return thetisTransaction({
    signature,
    feePayer: all.deployer.address,
    name: "InitializeProtocol",
    systemCpi: true,
    instruction: await buildInitializeProtocol(all, instance),
    events: [
      bytesOf(getProtocolInitializedEventEncoder(), { protocol: await protocolOf(instance) }),
    ],
  });
}

/** Several Thetis instructions in one transaction, each with its own invocation logs. */
export function combine(signature: string, parts: FakeTransaction[]): FakeTransaction {
  const [first] = parts;
  if (!first) throw new Error("combine needs at least one transaction");
  let offset = 0;
  const inner: FakeTransaction["inner"] = [];
  for (const part of parts) {
    for (const group of part.inner) inner.push({ ...group, index: group.index + offset });
    offset += part.instructions.length;
  }
  return {
    signature,
    failed: false,
    feePayer: first.feePayer,
    instructions: parts.flatMap((part) => part.instructions),
    inner,
    logs: parts.flatMap((part) => part.logs ?? []),
  };
}

/** A Pause of this stream's own instance, which emits nothing. */
export async function ownPause(signature: string): Promise<FakeTransaction> {
  const all = await signers();
  const protocol = await protocolOf(DEFAULT_INSTANCE);
  return {
    signature,
    failed: false,
    feePayer: all.deployer.address,
    instructions: [
      toFakeInstruction(
        getPauseInstruction({ protocol: protocol as Address, admin: all.admin, flags: 0 }),
      ),
    ],
    inner: [],
    logs: thetisLogs("Pause", []),
  };
}

/**
 * The token-simulation instance's seed, as scripts/seed-demo.ts sends it: initialize_protocol,
 * register_class CHROME v1, accredit_organisation for the same seven organisations, and
 * open_pool USD. Ten transactions, signatures k = 180 … 189. Slots: the first nine at
 * 10,100 + 50 i (between the fiat seed and the lot history), open_pool in slot 12,000, next to
 * the fiat IssueLot. Their accounts are written too, so the reconcile scan meets them.
 */
export async function simulationSeed(): Promise<History> {
  const signature = syntheticSignature;
  const f = await fixture();
  const all = await signers();
  const protocol = await protocolOf(SIMULATION_INSTANCE);
  const [, protocolBump] = await findProtocolPda({
    instanceId: instanceIdBytes(SIMULATION_INSTANCE),
  });
  const classPolicy = await findClassPolicyPda(
    protocol as Address,
    SEED.classCode,
    SEED.classVersion,
  );
  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint32(0, SEED.classVersion, true);
  const [, classBump] = await getProgramDerivedAddress({
    programAddress: PROGRAM as Address,
    seeds: [
      text.encode("class"),
      addressBytes.encode(protocol as Address),
      text.encode(SEED.classCode),
      version,
    ],
  });
  const blockTime = (i: number) =>
    new Date(Date.parse("2026-11-25T12:00:00Z") + i * 1000).toISOString();
  const history: History = [];
  history.push({
    slot: 10_100,
    blockTime: blockTime(0),
    transactions: [await initializeProtocol(signature(180), SIMULATION_INSTANCE)],
    accounts: {
      [protocol]: thetis(
        bytesOf(getProtocolEncoder(), {
          instanceId: instanceIdBytes(SIMULATION_INSTANCE),
          settlementMode: SettlementMode.DevnetTokenSimulation,
          admin: all.admin.address,
          accreditor: all.accreditor.address,
          pauseFlags: 0,
          bump: protocolBump,
        }),
      ),
    },
  });
  history.push({
    slot: 10_150,
    blockTime: blockTime(1),
    transactions: [
      thetisTransaction({
        signature: signature(181),
        feePayer: all.deployer.address,
        name: "RegisterClass",
        systemCpi: true,
        instruction: await buildRegisterClass(all, SIMULATION_INSTANCE),
        events: [
          bytesOf(getClassRegisteredEventEncoder(), { classPolicy, version: SEED.classVersion }),
        ],
      }),
    ],
    accounts: {
      [classPolicy]: thetis(
        bytesOf(getClassPolicyEncoder(), {
          protocol,
          classCode: SEED.classCode,
          version: SEED.classVersion,
          unit: QuantityUnit.Kilogram,
          grades: [...SEED.grades],
          originRequired: SEED.originRequired,
          lotValiditySecs: SEED.lotValiditySecs,
          splitInheritsExpiry: SEED.splitInheritsExpiry,
          bump: classBump,
        }),
      ),
    },
  });
  for (const [index, party] of f.organisations.entries()) {
    const [organisation, bump] = await findOrganisationPda({
      protocol: protocol as Address,
      orgId: party.orgId,
    });
    const nameMarker = await findOrganisationNamePda(protocol as Address, party.name);
    history.push({
      slot: 10_200 + index * 50,
      blockTime: blockTime(2 + index),
      transactions: [
        thetisTransaction({
          signature: signature(182 + index),
          feePayer: all.deployer.address,
          name: "AccreditOrganisation",
          systemCpi: true,
          instruction: await buildAccreditOrganisation(
            all,
            party,
            party.admin as Address,
            SIMULATION_INSTANCE,
          ),
          events: [
            bytesOf(getOrganisationAccreditedEventEncoder(), {
              organisation,
              role: Role[party.role],
            }),
          ],
        }),
      ],
      accounts: {
        [organisation]: thetis(
          bytesOf(getOrganisationEncoder(), {
            protocol,
            orgId: party.orgId,
            role: Role[party.role],
            displayName: party.name,
            admin: party.admin,
            related: [],
            bump,
          }),
        ),
        [nameMarker]: thetis(bytesOf(getOrganisationNameEncoder(), {})),
      },
    });
  }
  const mint = await simulationMint();
  const { pool, vault } = await derivePoolAddresses(protocol as Address, mint as Address);
  const [, poolBump] = await getProgramDerivedAddress({
    programAddress: PROGRAM as Address,
    seeds: [text.encode("pool"), addressBytes.encode(protocol as Address)],
  });
  history.push({
    slot: 12_000,
    blockTime: blockTime(9),
    transactions: [await openPool(signature(189), SIMULATION_INSTANCE)],
    accounts: {
      [pool]: thetis(
        bytesOf(getSimulationPoolEncoder(), {
          protocol,
          mint,
          vault,
          currency: text.encode(SIMULATION.currency),
          currencyDecimals: SIMULATION.mintDecimals,
          cashMinor: 0n,
          totalShares: 0n,
          lentMinor: 0n,
          incomeMinor: 0n,
          revision: 0n,
          bump: poolBump,
        }),
      ),
    },
  });
  return history;
}

/** Merges extra slots into a history: transactions and accounts of a shared slot are joined. */
export function mergeHistories(base: History, extra: History): History {
  const merged = new Map(base.map((entry) => [entry.slot, { ...entry }]));
  for (const entry of extra) {
    const found = merged.get(entry.slot);
    if (found) {
      found.transactions = [...found.transactions, ...entry.transactions];
      found.accounts = { ...found.accounts, ...entry.accounts };
    } else {
      merged.set(entry.slot, { ...entry });
    }
  }
  return [...merged.values()].sort((a, b) => a.slot - b.slot);
}
