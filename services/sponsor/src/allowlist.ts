// The sponsor signs only the transactions the relay builds (live-lending.md §6.6). Each rule
// below is a test in test/allowlist.test.ts. The sponsor is a signer, so it can only be a static
// account; the API keeps the protocol static too (it never enters the lookup table), so both are
// checkable without reading the chain.
import {
  type Address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";

export class SponsorRefusedError extends Error {
  // A declared field, not a parameter property: node runs these files in strip-only mode.
  readonly detail: string;

  constructor(detail: string) {
    super(`NOT_ALLOWED: ${detail}`);
    this.name = "SponsorRefusedError";
    this.detail = detail;
  }
}

export interface SponsorContext {
  sponsor: Address;
  programId: Address;
  protocol: Address;
  lookupTable: Address | null;
}

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const ED25519 = "Ed25519SigVerify111111111111111111111111111";
const LOOKUP_TABLE = "AddressLookupTab1e1111111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";
const MAX_COMPUTE_UNITS = 400_000;

/** The 14 Phase 2 instructions and the field kinds' (field-app.md §6.3), from packages/contracts/idl/thetis.json (checked by the tests):
 * the discriminator, the number of IDL accounts, the index of `protocol` and the slots named
 * `sponsor` or `payer`. An explicit list, so later kinds add entries (fold 7). */
const SPONSORED: readonly {
  name: string;
  discriminator: readonly number[];
  accounts: number;
  protocol: number;
  sponsorSlots: readonly number[];
}[] = [
  {
    name: "borrow",
    discriminator: [228, 253, 131, 202, 207, 116, 89, 18],
    accounts: 18,
    protocol: 1,
    sponsorSlots: [0],
  },
  {
    name: "close_loan",
    discriminator: [96, 114, 111, 204, 149, 228, 235, 124],
    accounts: 8,
    protocol: 1,
    sponsorSlots: [],
  },
  {
    name: "confirm_payment",
    discriminator: [221, 23, 112, 126, 29, 23, 159, 223],
    accounts: 11,
    protocol: 2,
    sponsorSlots: [1],
  },
  {
    name: "create_release_intent",
    discriminator: [170, 69, 51, 181, 33, 207, 255, 148],
    accounts: 14,
    protocol: 1,
    sponsorSlots: [0],
  },
  {
    name: "deposit",
    discriminator: [242, 35, 198, 137, 82, 225, 242, 182],
    accounts: 12,
    protocol: 2,
    sponsorSlots: [1],
  },
  {
    name: "liquidate",
    discriminator: [223, 179, 226, 125, 48, 46, 39, 74],
    accounts: 9,
    protocol: 1,
    sponsorSlots: [],
  },
  {
    name: "open_facility",
    discriminator: [3, 64, 248, 119, 95, 41, 149, 222],
    accounts: 9,
    protocol: 2,
    sponsorSlots: [1],
  },
  {
    name: "open_pool",
    discriminator: [96, 215, 110, 61, 1, 246, 205, 228],
    accounts: 10,
    protocol: 2,
    sponsorSlots: [1],
  },
  {
    name: "pledge",
    discriminator: [235, 47, 156, 254, 0, 88, 212, 142],
    accounts: 13,
    protocol: 1,
    sponsorSlots: [0],
  },
  {
    name: "record_advance",
    discriminator: [241, 72, 100, 239, 180, 170, 104, 238],
    accounts: 12,
    protocol: 1,
    sponsorSlots: [],
  },
  {
    name: "repay",
    discriminator: [234, 103, 67, 82, 208, 234, 219, 166],
    accounts: 13,
    protocol: 1,
    sponsorSlots: [],
  },
  {
    name: "sell_pledged",
    discriminator: [237, 3, 162, 72, 179, 144, 18, 228],
    accounts: 24,
    protocol: 1,
    sponsorSlots: [0],
  },
  {
    name: "set_valuation",
    discriminator: [201, 49, 221, 187, 246, 151, 253, 2],
    accounts: 10,
    protocol: 2,
    sponsorSlots: [1],
  },
  {
    name: "withdraw",
    discriminator: [183, 18, 70, 156, 148, 109, 161, 34],
    accounts: 11,
    protocol: 1,
    sponsorSlots: [],
  },
  // The field kinds (field-app.md §6.3), one entry each as its instruction exists.
  {
    name: "issue_lot",
    discriminator: [111, 135, 233, 181, 132, 0, 90, 138],
    accounts: 20,
    protocol: 1,
    sponsorSlots: [0],
  },
];

export const SPONSORED_INSTRUCTIONS = SPONSORED;

type Compiled = {
  version: number | "legacy";
  header: { numSignerAccounts: number };
  staticAccounts: Address[];
  instructions: {
    programAddressIndex: number;
    accountIndices?: readonly number[];
    data?: Uint8Array;
  }[];
  addressTableLookups?: { lookupTableAddress: Address }[];
};

function refuse(detail: string): never {
  throw new SponsorRefusedError(detail);
}

function decode(wireBase64: string) {
  try {
    const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wireBase64));
    const message = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    ) as unknown as Compiled;
    return { transaction, message };
  } catch {
    return refuse("not a transaction");
  }
}

function startsWith(data: Uint8Array, prefix: readonly number[]) {
  return prefix.every((byte, index) => data[index] === byte);
}

/** Throws SponsorRefusedError unless the transaction is one of the allowlisted shapes. */
export function checkSponsorTransaction(wireBase64: string, context: SponsorContext): void {
  const { transaction, message } = decode(wireBase64);
  if (message.version !== 0) refuse("the message version is not 0");
  const accounts = message.staticAccounts;
  if (accounts[0] !== context.sponsor) refuse("the fee payer is not the sponsor");
  const sponsorSignature = transaction.signatures[context.sponsor];
  if (sponsorSignature !== null && sponsorSignature !== undefined) {
    refuse("the sponsor signature slot is not empty");
  }
  for (const lookup of message.addressTableLookups ?? []) {
    if (lookup.lookupTableAddress !== context.lookupTable) {
      refuse("a lookup references a table other than the instance's");
    }
  }
  const program = (index: number) =>
    accounts[index] ?? refuse("a program comes from a lookup table");
  const at = (indices: readonly number[] | undefined, slot: number) => {
    const index = indices?.[slot];
    return index === undefined ? undefined : accounts[index];
  };
  const instructions = message.instructions;
  const programs = instructions.map((instruction) => program(instruction.programAddressIndex));

  if (programs.length === 1 && programs[0] === LOOKUP_TABLE) {
    const [instruction] = instructions;
    const data = instruction?.data ?? new Uint8Array();
    const indices = instruction?.accountIndices ?? [];
    if (data.length < 4) refuse("the lookup-table instruction has no 4-byte tag");
    const kind = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
    if (kind === 0) {
      // CreateLookupTable: [table, authority, payer, system]
      if (at(indices, 1) !== context.sponsor || at(indices, 2) !== context.sponsor) {
        refuse("the lookup table's authority and payer must be the sponsor");
      }
      if (at(indices, 3) !== SYSTEM || indices.length !== 4) refuse("not a lookup-table creation");
      return;
    }
    if (kind === 2) {
      // ExtendLookupTable: [table, authority, payer, system]
      if (at(indices, 0) !== context.lookupTable)
        refuse("the extended table is not the instance's");
      if (at(indices, 1) !== context.sponsor || at(indices, 2) !== context.sponsor) {
        refuse("the lookup table's authority and payer must be the sponsor");
      }
      return;
    }
    refuse("a lookup-table instruction other than create or extend");
  }

  const [first, ...rest] = instructions;
  if (programs[0] !== COMPUTE_BUDGET || !first)
    refuse("the first instruction is not a compute limit");
  const limitData = first.data ?? new Uint8Array();
  if (limitData.length !== 5 || limitData[0] !== 2)
    refuse("the compute-budget instruction is not SetComputeUnitLimit");
  if (
    new DataView(limitData.buffer, limitData.byteOffset, limitData.byteLength).getUint32(1, true) >
    MAX_COMPUTE_UNITS
  ) {
    refuse("the compute limit is above 400,000");
  }
  if ((first.accountIndices ?? []).length !== 0) refuse("the compute limit names accounts");

  let thetisAt = 1;
  if (programs[1] === ED25519) {
    if ((rest[0]?.accountIndices ?? []).length !== 0)
      refuse("the Ed25519 instruction names accounts");
    thetisAt = 2;
  }
  if (instructions.length !== thetisAt + 1)
    refuse("the instructions are not [compute limit, (Ed25519), Thetis]");
  if (programs[thetisAt] !== context.programId) refuse("another program is invoked");
  const thetis = instructions[thetisAt];
  const data = thetis?.data ?? new Uint8Array();
  const indices = thetis?.accountIndices ?? [];
  const shape = SPONSORED.find((entry) => startsWith(data, entry.discriminator));
  if (!shape) refuse("the Thetis instruction is not a sponsored command");
  if (indices.length < shape.accounts) refuse(`${shape.name} names too few accounts`);
  const protocolIndex = indices[shape.protocol];
  if (protocolIndex === undefined || protocolIndex >= accounts.length) {
    refuse("the protocol account is not a static account");
  }
  if (accounts[protocolIndex] !== context.protocol) refuse("the protocol is not this instance");
  // The sponsor may only appear where a rule names it, compared by address.
  indices.forEach((index, slot) => {
    if (accounts[index] === context.sponsor && !shape.sponsorSlots.includes(slot)) {
      refuse(`the sponsor appears in ${shape.name} at a slot not named sponsor or payer`);
    }
  });
}
