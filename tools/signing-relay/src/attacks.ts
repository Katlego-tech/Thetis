import {
  AccountRole,
  type Address,
  generateKeyPairSigner,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  signBytes,
} from "@solana/kit";
import { readBatch, readLookupTable, readNonce, setup } from "./setup.ts";
import { ChainTransactionError, type ChainTransport, sendConfirmed } from "./transport.ts";
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

  const send = (
    authorization: Authorization,
    signatures: ReadonlyMap<Address, ReadonlyUint8Array>,
  ) =>
    sendConfirmed(transport, sponsor, [submitInstruction(authorization, signatures)], {
      tables: { [scratch.lookupTable]: addresses },
    });

  async function expectRefused(
    label: string,
    authorization: Authorization,
    signatures: ReadonlyMap<Address, ReadonlyUint8Array>,
    expected: { name: string; program: Address; code: number },
    batch = scratch,
  ) {
    const before = await readBatch(transport, batch);
    const nonce = await readNonce(transport, scratch.nonce, sponsor.address);
    try {
      await send(authorization, signatures);
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

  await send(original, originalSignatures);
  await transport.waitForSlot(await transport.getSlot());
  await expectRefused("replay", original, originalSignatures, {
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
  await expectRefused("only sender", onlySender, await sign(onlySender, sender), wrongSigner);

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
    wrong,
    await sign(wrong, sender, receiver),
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
    { ...fresh, bytes: changed },
    freshSignatures,
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
  await expectRefused("swapped signatures", fresh, swapped, invalidSignature);

  const expired = authorize(sponsor.address, scratch, nonce, (await transport.getSlot()) - 1n, 1n);
  await expectRefused("expired", expired, await sign(expired, sender, receiver), {
    name: "Expired",
    program: stored.program,
    code: 6001,
  });
  const stale = authorize(sponsor.address, scratch, nonce, expiry, 0n);
  await expectRefused("stale sequence", stale, await sign(stale, sender, receiver), {
    name: "StaleSequence",
    program: stored.program,
    code: 6002,
  });
}
