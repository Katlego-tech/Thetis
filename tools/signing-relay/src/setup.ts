import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AccountRole,
  type Address,
  generateKeyPairSigner,
  getAddressDecoder,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { readState, type SetupProgress, writeState } from "./state.ts";
import {
  type ChainTransport,
  requireDevnet,
  SendPreflightError,
  sendConfirmed,
} from "./transport.ts";
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

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    // A process owned by another user may still hold a live lock.
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    throw error;
  }
}

export async function acquireSetupLock(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const prefix = `${process.pid}-`;
  const entry = await mkdtemp(join(directory, prefix));
  const release = () => rm(entry, { recursive: true, force: true });
  try {
    // Publish our marker before checking for peers so two live processes cannot both enter.
    for (const name of await readdir(directory)) {
      if (join(directory, name) === entry) continue;
      const owner = /^([1-9][0-9]*)-/.exec(name);
      if (!owner) continue;
      const pid = Number(owner[1]);
      if (processIsAlive(pid)) throw new Error(`Signing relay setup already running (PID ${pid})`);
      await rm(join(directory, name), { recursive: true, force: true });
    }
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

function discardPendingStep(progress: SetupProgress) {
  if (progress.lookupTable) {
    delete progress.lookupTable;
  } else if (progress.nonce) {
    delete progress.nonce;
  } else {
    delete progress.batch;
    delete progress.batchId;
  }
  delete progress.pending;
}

async function reconcileSetup(transport: ChainTransport, progress: SetupProgress) {
  const pending = progress.pending;
  const key = progress.lookupTable ?? progress.nonce ?? progress.batch;
  if (!pending || !key || (await transport.getAccount(key))) return;

  const expired = (await transport.getBlockHeight()) > BigInt(pending.lastValidBlockHeight);
  const status = await transport.getSignatureStatus(pending.signature);
  if (status === "failed") {
    discardPendingStep(progress);
    return;
  }
  // Check again after the status and expiry reads in case the account just appeared.
  if (await transport.getAccount(key)) return;
  if (status === "confirmed" || !expired) {
    throw new Error(
      `Setup transaction ${pending.signature} is awaiting account visibility or expiry; rerun setup`,
    );
  }
  discardPendingStep(progress);
}

export async function setup(
  transport: ChainTransport,
  sponsor: KeyPairSigner,
  program: Address,
  senderWallet: Address,
  receiverWallet: Address,
  additionalTableAddresses: Address[] = [],
  statePath?: string,
): Promise<RelayState> {
  await requireDevnet(transport);
  if (new Set([senderWallet, receiverWallet, sponsor.address]).size !== 3) {
    throw new Error("The sender, receiver and sponsor must have distinct addresses");
  }
  const [sender, receiver] = await Promise.all([
    deriveParty(program, senderWallet),
    deriveParty(program, receiverWallet),
  ]);
  const saved = statePath ? await readState(statePath) : null;
  if (saved?.complete) return saved;
  const progress: SetupProgress = saved ?? {
    complete: false,
    program,
    sponsor: sponsor.address,
    sender,
    receiver,
  };
  if (
    progress.program !== program ||
    progress.sponsor !== sponsor.address ||
    progress.sender.wallet !== senderWallet ||
    progress.sender.party !== sender.party ||
    progress.sender.signer !== sender.signer ||
    progress.receiver.wallet !== receiverWallet ||
    progress.receiver.party !== receiver.party ||
    progress.receiver.signer !== receiver.signer
  ) {
    throw new Error("Setup checkpoint does not match the configured program, wallets and sponsor");
  }
  await reconcileSetup(transport, progress);

  async function checkpoint() {
    if (statePath) await writeState(statePath, progress);
  }

  async function sendStep(instructions: Instruction[], signers?: KeyPairSigner[]) {
    try {
      await sendConfirmed(
        transport,
        sponsor,
        instructions,
        signers ? { signers } : undefined,
        statePath
          ? async (signature, { lastValidBlockHeight }) => {
              // Keep the candidate address recoverable if the send or confirmation response is lost.
              progress.pending = {
                signature,
                lastValidBlockHeight: lastValidBlockHeight.toString(),
              };
              await checkpoint();
            }
          : undefined,
      );
    } catch (error) {
      if (error instanceof SendPreflightError && progress.pending) {
        discardPendingStep(progress);
        await checkpoint();
      }
      throw error;
    }
    delete progress.pending;
    await checkpoint();
  }

  const payer = account(sponsor.address, AccountRole.WRITABLE_SIGNER);
  const system = account(SYSTEM);
  const register = [];
  for (const party of [sender, receiver]) {
    const existing = await transport.getAccount(party.party);
    if (!existing) {
      if (progress.batch) throw new Error(`Missing party record ${party.party}`);
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
  const id = progress.batchId ? Buffer.from(progress.batchId, "hex") : randomBytes(16);
  const [batch] = await derive(program, "batch", id);
  const batchDetails = { program, batchId: id.toString("hex"), batch, sender, receiver };
  if (progress.batch) {
    if (progress.batch !== batch) throw new Error("Setup checkpoint has an invalid batch address");
    await readBatch(transport, batchDetails);
    if (!progress.nonce && progress.pending) {
      delete progress.pending;
      await checkpoint();
    }
  } else {
    progress.batch = batch;
    progress.batchId = batchDetails.batchId;
    await sendStep([
      ...register,
      spikeInstruction(
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
      ),
    ]);
  }

  let nonce = progress.nonce;
  if (nonce) {
    await readNonce(transport, nonce, sponsor.address);
    if (!progress.lookupTable && progress.pending) {
      delete progress.pending;
      await checkpoint();
    }
  } else {
    const nonceSigner = await generateKeyPairSigner();
    nonce = nonceSigner.address;
    const rent = await transport.getRent(NONCE_SPACE);
    progress.nonce = nonce;
    await sendStep(
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
      [nonceSigner],
    );
  }

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
  let lookupTable = progress.lookupTable;
  if (!lookupTable) {
    const table = await findTableAddress(transport, sponsor.address);
    lookupTable = table.lookupTable;
    progress.lookupTable = lookupTable;
    const tableAccounts = [
      account(lookupTable, AccountRole.WRITABLE),
      account(sponsor.address, AccountRole.READONLY_SIGNER),
      payer,
      system,
    ];
    await sendStep([
      {
        programAddress: LOOKUP,
        accounts: tableAccounts,
        data: Buffer.concat([u32(0), u64(table.slot), Buffer.of(table.bump)]),
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
  }
  const table = await readLookupTable(transport, lookupTable);
  if (!tableAddresses.every((key, index) => table.addresses[index] === key)) {
    throw new Error("Lookup table does not contain the expected addresses");
  }
  if (progress.pending) {
    delete progress.pending;
    await checkpoint();
  }
  await transport.waitForSlot(table.lastExtendedSlot);
  const state = { ...batchDetails, nonce, lookupTable };
  if (statePath) await writeState(statePath, { ...state, complete: true });
  return state;
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

export async function readBatch(
  transport: ChainTransport,
  state: Pick<RelayState, "program" | "batchId" | "batch" | "sender" | "receiver">,
) {
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
    batch.data.readUInt8(104) > 1 ||
    !batch.data.subarray(0, 96).equals(expected)
  ) {
    throw new Error(`Invalid batch ${state.batch}`);
  }
  return {
    sequence: batch.data.readBigUInt64LE(96),
    handedOver: batch.data.readUInt8(104) === 1,
    bytes: batch.data,
  };
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
