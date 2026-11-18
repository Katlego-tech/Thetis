import {
  AccountRole,
  type Address,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  type Signature,
  signBytes,
} from "@solana/kit";
import { readBatch, readLookupTable, readNonce, setup } from "./setup.ts";
import { ChainTransactionError, type ChainTransport, prepareTransaction } from "./transport.ts";
import {
  type Authorization,
  account,
  authorize,
  batchAddresses,
  EXECUTOR,
  type RelayState,
  SIGNER,
  submitInstruction,
} from "./wire.ts";

const MAX_REPLAY_BLOCKHASH_ATTEMPTS = 5;

async function sign(authorization: Authorization, ...signers: KeyPairSigner[]) {
  return new Map(
    await Promise.all(
      signers.map(
        async (signer) =>
          [
            signer.address,
            await signBytes(signer.keyPair.privateKey, authorization.bytes),
          ] as const,
      ),
    ),
  );
}

export async function runRefusalChecks(
  transport: ChainTransport,
  sponsor: KeyPairSigner,
  stored: RelayState,
  report: (line: string) => void = console.log,
) {
  // Replay and stale sequence require a confirmed handover. Use throwaway parties and a
  // separate batch and nonce, and use the stored batch only for the wrong-signer refusal.
  const [sender, receiver] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  const scratch = await setup(
    transport,
    sponsor,
    stored.program,
    sender.address,
    receiver.address,
    batchAddresses(stored),
  );
  const { addresses } = await readLookupTable(transport, scratch.lookupTable);
  const expiry = (await transport.getSlot()) + 9_000n;
  const nonceBefore = await readNonce(transport, scratch.nonce, sponsor.address);
  const original = authorize(sponsor.address, scratch, nonceBefore, expiry, 0n);
  const originalSignatures = await sign(original, sender, receiver);

  const prepare = (
    authorization: Authorization,
    signatures: ReadonlyMap<Address, ReadonlyUint8Array>,
  ) =>
    prepareTransaction(transport, sponsor, [submitInstruction(authorization, signatures)], {
      tables: { [scratch.lookupTable]: addresses },
    });

  async function send({ transaction, lifetime }: Awaited<ReturnType<typeof prepare>>) {
    const signature = await transport.send(transaction);
    await transport.confirm(signature, lifetime);
  }

  async function prepareReplay(originalSignature: Signature) {
    for (let attempt = 1; attempt <= MAX_REPLAY_BLOCKHASH_ATTEMPTS; attempt++) {
      const candidate = await prepare(original, originalSignatures);
      // A duplicate outer signature can be discarded before the Executor sees the nonce.
      if (getSignatureFromTransaction(candidate.transaction) !== originalSignature) {
        return candidate;
      }
      if (attempt < MAX_REPLAY_BLOCKHASH_ATTEMPTS) {
        await transport.waitForSlot(await transport.getSlot());
      }
    }
    throw new Error("Could not obtain a different blockhash for the nonce replay");
  }

  async function expectRefused(
    label: string,
    prepared: Awaited<ReturnType<typeof prepare>>,
    expected: { name: string; program: Address; code: number },
    batch = scratch,
  ) {
    const before = await readBatch(transport, batch);
    const nonce = await readNonce(transport, scratch.nonce, sponsor.address);
    try {
      await send(prepared);
    } catch (error) {
      const firstFailure =
        error instanceof ChainTransactionError
          ? error.logs.find((line) => /^Program \S+ failed:/.test(line))
          : undefined;
      if (
        firstFailure !==
        `Program ${expected.program} failed: custom program error: 0x${expected.code.toString(16)}`
      ) {
        throw new Error(`${label} did not return ${expected.name}`, { cause: error });
      }
      const after = await readBatch(transport, batch);
      const afterNonce = await readNonce(transport, scratch.nonce, sponsor.address);
      if (!before.bytes.equals(after.bytes) || !nonce.equals(afterNonce)) {
        throw new Error(`${label} changed the batch or nonce`);
      }
      report(`D32-devnet ${label}: refused (${expected.name})`);
      return;
    }
    throw new Error(`${label} unexpectedly succeeded`);
  }

  const originalTransaction = await prepare(original, originalSignatures);
  await send(originalTransaction);
  const replay = await prepareReplay(getSignatureFromTransaction(originalTransaction.transaction));
  await expectRefused("replay", replay, {
    name: "NonceMismatch",
    program: EXECUTOR,
    code: 3,
  });

  const nonce = await readNonce(transport, scratch.nonce, sponsor.address);
  const wrongSigner = { name: "WrongSigner", program: stored.program, code: 6000 };
  const senderSigner = account(scratch.sender.signer, AccountRole.READONLY_SIGNER);
  const onlySender = authorize(sponsor.address, scratch, nonce, expiry, 1n, {
    authorities: [sender.address],
    handoverSigners: [senderSigner, account(scratch.receiver.signer)],
  });
  await expectRefused(
    "only sender",
    await prepare(onlySender, await sign(onlySender, sender)),
    wrongSigner,
  );

  const storedBatch = await readBatch(transport, stored);
  const wrong = authorize(
    sponsor.address,
    { ...stored, nonce: scratch.nonce },
    nonce,
    expiry,
    storedBatch.sequence,
    {
      authorities: [sender.address, receiver.address],
      handoverSigners: [
        senderSigner,
        account(scratch.receiver.signer, AccountRole.READONLY_SIGNER),
      ],
    },
  );
  await expectRefused(
    "wrong signer",
    await prepare(wrong, await sign(wrong, sender, receiver)),
    wrongSigner,
    stored,
  );

  const fresh = authorize(sponsor.address, scratch, nonce, expiry, 1n);
  const freshSignatures = await sign(fresh, sender, receiver);
  const changed = Buffer.from(fresh.bytes);
  changed.writeUInt8(changed.readUInt8(changed.length - 1) ^ 1, changed.length - 1);
  const invalidSignature = { name: "InvalidSignature", program: SIGNER, code: 3 };
  await expectRefused(
    "altered byte",
    await prepare({ ...fresh, bytes: changed }, freshSignatures),
    invalidSignature,
  );
  const entries = [...freshSignatures.entries()];
  const swapped = new Map(
    entries.map(([key], index) => {
      const other = entries[1 - index];
      if (!other) throw new Error("Swapping requires two signatures");
      return [key, other[1]] as const;
    }),
  );
  await expectRefused("swapped signatures", await prepare(fresh, swapped), invalidSignature);

  const expired = authorize(sponsor.address, scratch, nonce, (await transport.getSlot()) - 1n, 1n);
  await expectRefused("expired", await prepare(expired, await sign(expired, sender, receiver)), {
    name: "Expired",
    program: stored.program,
    code: 6001,
  });
  const stale = authorize(sponsor.address, scratch, nonce, expiry, 0n);
  await expectRefused("stale sequence", await prepare(stale, await sign(stale, sender, receiver)), {
    name: "StaleSequence",
    program: stored.program,
    code: 6002,
  });
}
