import { readFileSync } from "node:fs";
import {
  AccountRole,
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createKeyPairSignerFromPrivateKeyBytes,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
} from "@solana/kit";
import {
  getCreateLookupTableInstruction,
  getExtendLookupTableInstruction,
} from "@solana-program/address-lookup-table";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { THETIS_PROGRAM_ADDRESS } from "@thetis/contracts";
import { describe, expect, it } from "vitest";
import {
  checkSponsorTransaction,
  SPONSORED_INSTRUCTIONS,
  type SponsorContext,
  SponsorRefusedError,
} from "../src/allowlist.ts";
import { signAsSponsor } from "../src/sign.ts";

interface IdlAccount {
  name: string;
  signer?: boolean;
  writable?: boolean;
  address?: string;
}
interface IdlInstruction {
  name: string;
  discriminator: number[];
  accounts: IdlAccount[];
}

const idl = JSON.parse(
  readFileSync(new URL("../../../packages/contracts/idl/thetis.json", import.meta.url), "utf8"),
) as { instructions: IdlInstruction[] };

// The Phase 2 lending instructions, then the field kinds whose instructions exist (field-app.md
// §6.3, T067r folds): each is an explicit entry (live-lending.md fold 7).
const SPONSORED_NAMES = [
  "open_facility",
  "set_valuation",
  "pledge",
  "record_advance",
  "confirm_payment",
  "repay",
  "create_release_intent",
  "sell_pledged",
  "liquidate",
  "close_loan",
  "open_pool",
  "deposit",
  "withdraw",
  "borrow",
  "issue_lot",
  "handover",
  "record_observation",
];
const TEXT_SIGNED = new Set([
  "pledge",
  "record_advance",
  "create_release_intent",
  "sell_pledged",
  "borrow",
  "issue_lot",
  "handover",
  "record_observation",
]);
const ED25519 = "Ed25519SigVerify111111111111111111111111111" as Address;
const SYSTEM = "11111111111111111111111111111111" as Address;
const LOOKUP_TABLE = "AddressLookupTab1e1111111111111111111111111" as Address;
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;
const BLOCKHASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY" as Blockhash;

const sponsorKey = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(7));
const sponsor = sponsorKey.address;
const [protocol, otherProtocol, table, otherTable, lender, filler] = (await Promise.all(
  Array.from({ length: 6 }, async () => (await generateKeyPairSigner()).address),
)) as [Address, Address, Address, Address, Address, Address];
const context: SponsorContext = {
  sponsor,
  programId: THETIS_PROGRAM_ADDRESS,
  protocol,
  lookupTable: table,
};

function idlInstruction(name: string) {
  const found = idl.instructions.find((instruction) => instruction.name === name);
  if (!found) throw new Error(`IDL has no ${name}`);
  return found;
}

/** One Thetis instruction with the IDL's account order: protocol, sponsor/payer slots and
 * every other slot filled as the relay fills them. */
function thetis(
  name: string,
  options: { protocol?: Address; sponsorAt?: string; extra?: Address[]; drop?: number } = {},
): Instruction {
  const definition = idlInstruction(name);
  const accounts = definition.accounts.map((account) => {
    let value: Address;
    if (account.name === "protocol") value = options.protocol ?? protocol;
    else if (account.name === "sponsor" || account.name === "payer") value = sponsor;
    else if (account.name === options.sponsorAt) value = sponsor;
    else if (account.address) value = account.address as Address;
    else if (account.signer) value = lender;
    else value = filler;
    const role = account.signer
      ? account.writable
        ? AccountRole.WRITABLE_SIGNER
        : AccountRole.READONLY_SIGNER
      : account.writable
        ? AccountRole.WRITABLE
        : AccountRole.READONLY;
    return { address: value, role };
  });
  for (const extra of options.extra ?? [])
    accounts.push({ address: extra, role: AccountRole.WRITABLE });
  accounts.splice(accounts.length - (options.drop ?? 0));
  return {
    programAddress: THETIS_PROGRAM_ADDRESS,
    accounts,
    data: Uint8Array.from([...definition.discriminator, ...new Uint8Array(24)]),
  };
}

function ed25519(): Instruction {
  return { programAddress: ED25519, accounts: [], data: new Uint8Array(2 + 14 + 96 + 10) };
}

function wire(
  instructions: Instruction[],
  options: { feePayer?: Address; tables?: Record<Address, Address[]> } = {},
): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(options.feePayer ?? sponsor, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const compressed = options.tables
    ? compressTransactionMessageUsingAddressLookupTables(message, options.tables)
    : message;
  return getBase64EncodedWireTransaction(compileTransaction(compressed));
}

const limit = (units = 400_000) => getSetComputeUnitLimitInstruction({ units });

function refused(wireBase64: string, detail?: RegExp) {
  let error: unknown;
  try {
    checkSponsorTransaction(wireBase64, context);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(SponsorRefusedError);
  if (detail) expect((error as SponsorRefusedError).detail).toMatch(detail);
}

describe("sponsor allowlist", () => {
  it("signs each allowlisted command shape and both lookup-table shapes", async () => {
    // The hard-coded table is the IDL's: discriminator, account count, protocol and sponsor slots.
    expect(SPONSORED_INSTRUCTIONS.map((entry) => entry.name).sort()).toEqual(
      [...SPONSORED_NAMES].sort(),
    );
    for (const entry of SPONSORED_INSTRUCTIONS) {
      const definition = idlInstruction(entry.name);
      const names = definition.accounts.map((account) => account.name);
      expect(entry.discriminator, entry.name).toEqual(definition.discriminator);
      expect(entry.accounts, entry.name).toBe(names.length);
      expect(entry.protocol, entry.name).toBe(names.indexOf("protocol"));
      expect(entry.sponsorSlots, entry.name).toEqual(
        names.flatMap((name, index) => (name === "sponsor" || name === "payer" ? [index] : [])),
      );
    }
    for (const name of SPONSORED_NAMES) {
      const instructions = TEXT_SIGNED.has(name)
        ? [limit(), ed25519(), thetis(name)]
        : [limit(), thetis(name)];
      const plain = wire(instructions);
      expect(() => checkSponsorTransaction(plain, context), name).not.toThrow();
      const compressed = wire(instructions, { tables: { [table]: [filler] } });
      expect(() => checkSponsorTransaction(compressed, context), `${name} via table`).not.toThrow();

      const signed = await signAsSponsor(sponsorKey.keyPair, compressed, context);
      const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(signed));
      const signature = transaction.signatures[sponsor];
      expect(signature, name).toBeTruthy();
      expect(
        await verifySignature(
          sponsorKey.keyPair.publicKey,
          signature as never,
          transaction.messageBytes,
        ),
      ).toBe(true);
    }
    // The simulated repay names the lender's pool share after the IDL accounts.
    expect(() =>
      checkSponsorTransaction(wire([limit(), thetis("repay", { extra: [filler] })]), context),
    ).not.toThrow();

    const noop = createNoopSigner(sponsor);
    const create = getCreateLookupTableInstruction({
      address: [table, 255 as never],
      authority: noop,
      payer: noop,
      recentSlot: 10n,
    });
    expect(() => checkSponsorTransaction(wire([create]), context)).not.toThrow();
    expect(() =>
      checkSponsorTransaction(wire([create]), { ...context, lookupTable: null }),
    ).not.toThrow();
    const extend = getExtendLookupTableInstruction({
      address: table,
      authority: noop,
      payer: noop,
      addresses: [filler, lender],
    });
    expect(() => checkSponsorTransaction(wire([extend]), context)).not.toThrow();
  });

  it("refuses another fee payer, another program, a System transfer, the sponsor in a non-payer slot, another protocol, two Thetis instructions and a compute limit above 400,000", async () => {
    const pledge = [limit(), ed25519(), thetis("pledge")];
    refused(wire(pledge, { feePayer: lender }), /fee payer/);
    refused(
      wire([...pledge, { programAddress: MEMO, accounts: [], data: new Uint8Array([1]) }]),
      /program|instructions/,
    );
    const transfer: Instruction = {
      programAddress: SYSTEM,
      accounts: [
        { address: sponsor, role: AccountRole.WRITABLE_SIGNER },
        { address: lender, role: AccountRole.WRITABLE },
      ],
      data: Uint8Array.from([2, 0, 0, 0, 0, 202, 154, 59, 0, 0, 0, 0]),
    };
    refused(wire([transfer]));
    refused(wire([limit(), transfer]));
    refused(wire([limit(), ed25519(), thetis("pledge", { sponsorAt: "position" })]), /sponsor/);
    refused(wire([limit(), thetis("close_loan", { sponsorAt: "loan" })]), /sponsor/);
    refused(wire([limit(), thetis("pledge", { protocol: otherProtocol })]), /protocol/);
    refused(wire([limit(), thetis("liquidate"), thetis("close_loan")]));
    refused(wire([limit(400_001), thetis("close_loan")]), /compute/);
    // A Phase 1 or unknown instruction is not a sponsored command.
    refused(wire([limit(), thetis("transfer")]));
    refused(wire([thetis("close_loan")]));
    // Lookups through a table other than the instance's.
    refused(wire([limit(), thetis("close_loan")], { tables: { [otherTable]: [filler] } }), /table/);
    // The sponsor's signature slot must be empty.
    const signed = await signAsSponsor(
      sponsorKey.keyPair,
      wire([limit(), thetis("close_loan")]),
      context,
    );
    refused(signed, /signature/);
    // A table extension paid by someone else.
    const other = createNoopSigner(lender);
    refused(
      wire([
        getExtendLookupTableInstruction({
          address: table,
          authority: createNoopSigner(sponsor),
          payer: other,
          addresses: [filler],
        }),
      ]),
    );
    // A legacy message.
    const legacy = pipe(
      createTransactionMessage({ version: "legacy" }),
      (m) => setTransactionMessageFeePayer(sponsor, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH, lastValidBlockHeight: 1n },
          m,
        ),
      (m) => appendTransactionMessageInstructions([limit(), thetis("close_loan")], m),
    );
    refused(getBase64EncodedWireTransaction(compileTransaction(legacy)), /version/);
    // Not a transaction at all.
    refused(Buffer.from("not a transaction").toString("base64"));
  });

  it("refuses each field kind with the sponsor at a slot other than 0, or with too few accounts", () => {
    for (const [name, slot] of [
      ["issue_lot", "custodian"],
      ["handover", "from_org"],
      ["record_observation", "observer_org"],
    ] as const) {
      const shape = SPONSORED_INSTRUCTIONS.find((entry) => entry.name === name);
      expect(shape?.sponsorSlots, name).toStrictEqual([0]);
      refused(wire([limit(), ed25519(), thetis(name, { sponsorAt: slot })]), /sponsor/);
      refused(wire([limit(), ed25519(), thetis(name, { drop: 1 })]), /too few accounts/);
    }
  });

  it("refuses a protocol through the table, foreign lookup-table authorities, another table, an Ed25519 instruction with accounts, a compute price, a trailing instruction and short lookup-table data", () => {
    // The protocol slot must be a static account, never a table entry.
    refused(wire([limit(), thetis("close_loan")], { tables: { [table]: [protocol] } }), /protocol/);
    const sponsorSigner = createNoopSigner(sponsor);
    const other = createNoopSigner(lender);
    for (const [authority, payer] of [
      [other, sponsorSigner],
      [sponsorSigner, other],
    ] as const) {
      refused(
        wire([
          getCreateLookupTableInstruction({
            address: [table, 255 as never],
            authority,
            payer,
            recentSlot: 10n,
          }),
        ]),
        /authority and payer/,
      );
      refused(
        wire([
          getExtendLookupTableInstruction({
            address: table,
            authority,
            payer,
            addresses: [filler],
          }),
        ]),
        /authority and payer/,
      );
    }
    refused(
      wire([
        getExtendLookupTableInstruction({
          address: otherTable,
          authority: sponsorSigner,
          payer: sponsorSigner,
          addresses: [filler],
        }),
      ]),
      /extended table/,
    );
    refused(
      wire([
        limit(),
        {
          programAddress: ED25519,
          accounts: [{ address: filler, role: AccountRole.READONLY }],
          data: new Uint8Array(2 + 14 + 96 + 10),
        },
        thetis("pledge"),
      ]),
      /Ed25519/,
    );
    const price = getSetComputeUnitPriceInstruction({ microLamports: 1n });
    refused(wire([price, thetis("close_loan")]), /compute/);
    refused(wire([limit(), price, thetis("close_loan")]));
    refused(wire([price, limit(), thetis("close_loan")]));
    refused(wire([limit(), thetis("close_loan"), limit()]), /instructions/);
    refused(wire([limit(), ed25519(), thetis("pledge"), ed25519()]), /instructions/);
    refused(wire([limit(), thetis("close_loan"), price]), /instructions/);
    // Lookup-table instruction data shorter than its 4-byte tag.
    for (const length of [0, 1, 2, 3]) {
      refused(
        wire([
          {
            programAddress: LOOKUP_TABLE,
            accounts: [
              { address: table, role: AccountRole.WRITABLE },
              { address: sponsor, role: AccountRole.READONLY_SIGNER },
              { address: sponsor, role: AccountRole.WRITABLE_SIGNER },
              { address: SYSTEM, role: AccountRole.READONLY },
            ],
            data: Uint8Array.from([2, 0, 0].slice(0, length)),
          },
        ]),
      );
    }
  });
});
