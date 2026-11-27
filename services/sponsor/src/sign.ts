import {
  type createKeyPairFromBytes,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from "@solana/kit";
import { checkSponsorTransaction, type SponsorContext } from "./allowlist.ts";

/** Checks the allowlist, then adds the sponsor's signature and returns the wire transaction. */
export async function signAsSponsor(
  keyPair: Awaited<ReturnType<typeof createKeyPairFromBytes>>,
  wireBase64: string,
  context: SponsorContext,
): Promise<string> {
  checkSponsorTransaction(wireBase64, context);
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wireBase64));
  const signed = await partiallySignTransaction([keyPair], transaction);
  return getBase64Decoder().decode(getTransactionEncoder().encode(signed));
}
