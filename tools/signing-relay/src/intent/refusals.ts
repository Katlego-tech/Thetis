import { randomBytes } from "node:crypto";
import {
  generateKeyPairSigner,
  getSignatureFromTransaction,
  type Address,
  type Instruction,
  type KeyPairSigner,
  signBytes,
} from "@solana/kit";
import {
  ChainTransactionError,
  type ChainTransport,
  prepareTransaction,
  sendConfirmed,
} from "../transport.ts";
import { type HandoverFields, handoverMessage } from "./message.ts";
import { setupIntent } from "./setup.ts";
import { ed25519VerifyInstruction, handoverInstruction, LOT_ID, QUANTITY_KG } from "./wire.ts";

export async function runIntentRefusals(
  transport: ChainTransport,
  sponsor: KeyPairSigner,
  program: Address,
  report: (line: string) => void = console.log,
) {
  const [sender, receiver, other] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  const suffix = randomBytes(6).toString("hex");
  const names = { sender: `Sender ${suffix}`, receiver: `Receiver ${suffix}` };
  const state = await setupIntent(
    transport,
    sponsor,
    program,
    sender.address,
    receiver.address,
    undefined,
    names,
  );
  const batchId = Buffer.from(state.batchId, "hex");
  const legacy = { version: "legacy" } as const;

  async function build(
    window: bigint,
    signers: [KeyPairSigner, KeyPairSigner] = [sender, receiver],
    quantityKg = QUANTITY_KG,
  ) {
    const validUntil = (await transport.getChainTime()) + window;
    const fields: HandoverFields = {
      program,
      batchId,
      lotId: LOT_ID,
      quantityKg,
      from: names.sender,
      to: names.receiver,
      sequence: 0n,
      validUntil,
    };
    const message = handoverMessage(fields);
    const [first, second] = signers;
    const entry = async (signer: KeyPairSigner) => ({
      publicKey: signer.address,
      signature: Uint8Array.from(await signBytes(signer.keyPair.privateKey, message)),
    });
    return [
      ed25519VerifyInstruction([await entry(first), await entry(second)], message),
      handoverInstruction(
        program,
        batchId,
        state.sender.party,
        state.receiver.party,
        QUANTITY_KG,
        validUntil,
        0n,
      ),
    ] as const;
  }

  async function errorName(send: () => Promise<unknown>) {
    try {
      await send();
    } catch (error) {
      if (!(error instanceof ChainTransactionError)) throw error;
      for (const line of error.logs) {
        const name = /Error Code: (\w+)\./.exec(line)?.[1];
        if (name) return name;
      }
      throw error;
    }
    throw new Error("Transaction unexpectedly confirmed");
  }

  const refusalName = (instructions: Instruction[]) =>
    errorName(() => sendConfirmed(transport, sponsor, instructions, legacy));

  function refused(label: string, actual: string, expected: string) {
    if (actual !== expected) throw new Error(`${label} returned ${actual}, expected ${expected}`);
    report(`D32-inhouse-devnet ${label}: refused (${actual})`);
  }

  const [, handover] = await build(570n);
  refused("no verify instruction", await refusalName([handover]), "MissingVerification");
  refused(
    "swapped signers",
    await refusalName([...(await build(570n, [receiver, sender]))]),
    "WrongSigner",
  );
  refused(
    "another receiver signer",
    await refusalName([...(await build(570n, [sender, other]))]),
    "WrongSigner",
  );
  refused(
    "another quantity in signed text",
    await refusalName([...(await build(570n, [sender, receiver], QUANTITY_KG + 1n))]),
    "MessageMismatch",
  );

  // The relay reads chain time from the latest confirmed block, which on devnet trails the
  // executing slot's clock by a few seconds, so a window one second over the 600 s ceiling can
  // land inside it. 660 s is over the ceiling by more than that drift. The second handover makes
  // the transaction roll back if the first were ever accepted, so the batch stays usable.
  const [verify, overlong] = await build(660n);
  refused("window 660 seconds", await refusalName([verify, overlong, overlong]), "WindowTooLong");

  const honest = [...(await build(570n))];
  const original = await sendConfirmed(transport, sponsor, honest, legacy);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const { transaction, lifetime } = await prepareTransaction(transport, sponsor, honest, legacy);
    if (getSignatureFromTransaction(transaction) === original) {
      if (attempt < 5) await transport.waitForSlot(await transport.getSlot());
      continue;
    }
    const result = await errorName(async () =>
      transport.confirm(await transport.send(transaction), lifetime),
    );
    refused("replay", result, "StaleSequence");
    return;
  }
  throw new Error("Could not obtain a different blockhash for the handover replay");
}
