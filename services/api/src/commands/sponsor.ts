// The fee sponsor, in-process from a key file (local runs) or by Lambda invoke.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { type Address, createKeyPairFromBytes, getAddressFromPublicKey } from "@solana/kit";
import { SponsorRefusedError, type SponsorContext } from "@thetis/sponsor/allowlist";
import { signAsSponsor } from "@thetis/sponsor/sign";
import { readKeyFile } from "./config.ts";

export interface SponsorPort {
  address(): Promise<Address>;
  sign(wireBase64: string, lookupTable: Address | null): Promise<string>;
}

/** The sponsor refused the transaction or did not answer: nothing was sent. */
export class SponsorUnavailableError extends Error {
  readonly detail: string;

  constructor(detail: string, cause?: unknown) {
    super(`SPONSOR_UNAVAILABLE: ${detail}`, { cause });
    this.name = "SponsorUnavailableError";
    this.detail = detail;
  }
}

export function keyFileSponsor(
  path: string,
  context: Omit<SponsorContext, "sponsor" | "lookupTable">,
): SponsorPort {
  let keys: Promise<{ keyPair: CryptoKeyPair; address: Address }> | undefined;
  function load() {
    keys ??= (async () => {
      const keyPair = await createKeyPairFromBytes(readKeyFile(path));
      return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
    })();
    return keys;
  }
  return {
    async address() {
      return (await load()).address;
    },
    async sign(wireBase64, lookupTable) {
      const { keyPair, address } = await load();
      try {
        return await signAsSponsor(keyPair, wireBase64, { ...context, sponsor: address, lookupTable });
      } catch (error) {
        if (error instanceof SponsorRefusedError) throw new SponsorUnavailableError(error.detail, error);
        throw error;
      }
    },
  };
}

export function lambdaSponsor(functionName: string): SponsorPort {
  const client = new LambdaClient({});
  async function invoke(payload: object): Promise<Record<string, unknown>> {
    let response: Awaited<ReturnType<LambdaClient["send"]>>;
    try {
      response = await client.send(
        new InvokeCommand({ FunctionName: functionName, Payload: new TextEncoder().encode(JSON.stringify(payload)) }),
      );
    } catch (error) {
      throw new SponsorUnavailableError("the sponsor did not answer", error);
    }
    if (response.FunctionError || !response.Payload) {
      throw new SponsorUnavailableError("the sponsor failed");
    }
    return JSON.parse(new TextDecoder().decode(response.Payload));
  }
  let address: Promise<Address> | undefined;
  return {
    address() {
      address ??= invoke({ op: "address" }).then((answer) => {
        if (typeof answer.address !== "string") throw new SponsorUnavailableError("no sponsor address");
        return answer.address as Address;
      });
      return address;
    },
    async sign(transactionBase64, lookupTable) {
      const answer = await invoke({ op: "sign", transactionBase64, lookupTable });
      if (typeof answer.transactionBase64 === "string") return answer.transactionBase64;
      throw new SponsorUnavailableError(typeof answer.detail === "string" ? answer.detail : "refused");
    },
  };
}
