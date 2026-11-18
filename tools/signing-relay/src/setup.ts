import { randomBytes } from "node:crypto";
import {
  AccountRole,
  type Address,
  generateKeyPairSigner,
  getAddressDecoder,
  type KeyPairSigner,
} from "@solana/kit";
import { type ChainTransport, sendConfirmed } from "./transport.ts";
import {
  account,
  batchAddresses,
  CLOCK,
  derive,
  deriveParty,
  discriminator,
  EXECUTOR,
  keyBytes,
  LOOKUP,
  NONCE,
  NONCE_SPACE,
  type Party,
  QUANTITY,
  type RelayState,
  SIGNER,
  SLOT_HASHES,
  SYSTEM,
  spikeInstruction,
  TRANSITION,
  u32,
  u64,
} from "./wire.ts";

export async function setup(
  transport: ChainTransport,
  sponsor: KeyPairSigner,
  program: Address,
  senderWallet: Address,
  receiverWallet: Address,
  additionalTableAddresses: Address[] = [],
): Promise<RelayState> {
  if (new Set([senderWallet, receiverWallet, sponsor.address]).size !== 3) {
    throw new Error("The sender, receiver and sponsor must have distinct addresses");
  }
  const [sender, receiver] = await Promise.all([
    deriveParty(program, senderWallet),
    deriveParty(program, receiverWallet),
  ]);
  const payer = account(sponsor.address, AccountRole.WRITABLE_SIGNER);
  const system = account(SYSTEM);
  const register = [];
  for (const party of [sender, receiver]) {
    const existing = await transport.getAccount(party.party);
    if (!existing) {
      register.push(
        spikeInstruction(
          program,
          "register_party",
          [payer, account(party.party, AccountRole.WRITABLE), system],
          keyBytes(party.wallet),
        ),
      );
      continue;
    }
    validateParty(existing, program, party);
  }
  const id = randomBytes(16);
  const [batch] = await derive(program, "batch", id);
  const open = spikeInstruction(
    program,
    "open_batch",
    [
      payer,
      account(batch, AccountRole.WRITABLE),
      account(sender.party),
      account(receiver.party),
      system,
    ],
    id,
    keyBytes(senderWallet),
    keyBytes(receiverWallet),
    u64(QUANTITY),
  );
  await sendConfirmed(transport, sponsor, [...register, open]);

  const nonceSigner = await generateKeyPairSigner();
  const nonce = nonceSigner.address;
  const rent = await transport.getRent(NONCE_SPACE);
  await sendConfirmed(
    transport,
    sponsor,
    [
      {
        programAddress: SYSTEM,
        accounts: [payer, account(nonce, AccountRole.WRITABLE_SIGNER)],
        data: Buffer.concat([u32(0), u64(rent), u64(BigInt(NONCE_SPACE)), keyBytes(NONCE)]),
      },
      {
        programAddress: NONCE,
        accounts: [
          account(nonce, AccountRole.WRITABLE),
          account(sponsor.address),
          account(SLOT_HASHES),
        ],
        data: Buffer.of(0),
      },
    ],
    { signers: [nonceSigner] },
  );

  const tableAddresses = [
    ...new Set([
      SIGNER,
      EXECUTOR,
      NONCE,
      program,
      SYSTEM,
      CLOCK,
      SLOT_HASHES,
      TRANSITION,
      nonce,
      ...batchAddresses({ batch, sender, receiver }),
      ...additionalTableAddresses,
    ]),
  ];
  const { lookupTable, bump, slot } = await findTableAddress(transport, sponsor.address);
  const tableAccounts = [
    account(lookupTable, AccountRole.WRITABLE),
    account(sponsor.address, AccountRole.READONLY_SIGNER),
    payer,
    system,
  ];
  await sendConfirmed(transport, sponsor, [
    {
      programAddress: LOOKUP,
      accounts: tableAccounts,
      data: Buffer.concat([u32(0), u64(slot), Buffer.of(bump)]),
    },
    {
      programAddress: LOOKUP,
      accounts: tableAccounts,
      data: Buffer.concat([
        u32(2),
        u64(BigInt(tableAddresses.length)),
        ...tableAddresses.map(keyBytes),
      ]),
    },
  ]);
  const table = await readLookupTable(transport, lookupTable);
  if (!tableAddresses.every((key, index) => table.addresses[index] === key)) {
    throw new Error("Lookup table does not contain the expected addresses");
  }
  await transport.waitForSlot(table.lastExtendedSlot);
  return { program, batchId: id.toString("hex"), batch, sender, receiver, nonce, lookupTable };
}

async function findTableAddress(transport: ChainTransport, sponsor: Address) {
  // CreateLookupTable requires a slot actually present in SlotHashes, which can lag Clock.
  const slotHashes = await transport.getAccount(SLOT_HASHES);
  const data = slotHashes?.data;
  if (!data || data.length < 48 || data.readBigUInt64LE(0) === 0n) {
    throw new Error("SlotHashes does not contain a recent slot");
  }
  const slot = data.readBigUInt64LE(8);
  const [lookupTable, bump] = await derive(LOOKUP, keyBytes(sponsor), u64(slot));
  if (await transport.getAccount(lookupTable)) {
    throw new Error(
      `A lookup table already exists for sponsor ${sponsor} and slot ${slot}; retry in a later slot`,
    );
  }
  return { lookupTable, bump, slot };
}

function validateParty(existing: { owner: Address; data: Buffer }, program: Address, party: Party) {
  const expected = Buffer.concat([
    discriminator("account:Party"),
    keyBytes(party.wallet),
    keyBytes(party.signer),
  ]);
  if (
    existing.owner !== program ||
    existing.data.length !== 73 ||
    !existing.data.subarray(0, 72).equals(expected)
  ) {
    throw new Error(`Invalid party record ${party.party}`);
  }
}

export async function readBatch(transport: ChainTransport, state: RelayState) {
  const batch = await transport.getAccount(state.batch);
  const expected = Buffer.concat([
    discriminator("account:Batch"),
    Buffer.from(state.batchId, "hex"),
    keyBytes(state.sender.party),
    keyBytes(state.receiver.party),
    u64(QUANTITY),
  ]);
  if (
    batch?.owner !== state.program ||
    batch.data.length !== 106 ||
    !batch.data.subarray(0, 96).equals(expected)
  ) {
    throw new Error(`Invalid batch ${state.batch}`);
  }
  return { sequence: batch.data.readBigUInt64LE(96), bytes: batch.data };
}

export async function readNonce(transport: ChainTransport, nonce: Address, sponsor: Address) {
  const entry = await transport.getAccount(nonce);
  if (
    entry?.owner !== NONCE ||
    entry.data.length !== NONCE_SPACE ||
    !entry.data.subarray(32, 64).equals(keyBytes(sponsor))
  ) {
    throw new Error(`Invalid nonce or nonce authority for ${nonce}`);
  }
  return entry.data.subarray(0, 32);
}

export async function readLookupTable(transport: ChainTransport, lookupTable: Address) {
  const table = await transport.getAccount(lookupTable);
  const metadataSize = 56;
  if (
    table?.owner !== LOOKUP ||
    table.data.length < metadataSize ||
    (table.data.length - metadataSize) % 32 !== 0 ||
    table.data.readUInt32LE(0) !== 1 ||
    table.data.readBigUInt64LE(4) !== 0xffff_ffff_ffff_ffffn
  ) {
    throw new Error(`Invalid or inactive lookup table ${lookupTable}`);
  }
  const addresses: Address[] = [];
  const decoder = getAddressDecoder();
  for (let offset = metadataSize; offset < table.data.length; offset += 32) {
    addresses.push(decoder.decode(table.data.subarray(offset, offset + 32)));
  }
  return { addresses, lastExtendedSlot: table.data.readBigUInt64LE(12) };
}
