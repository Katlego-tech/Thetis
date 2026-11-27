import { record, string, UUID } from "../lib/shape";
import { type ApiClient, TIMEOUTS } from "./client";

export interface Challenge {
  challengeId: string;
  message: string;
  expiresAt: string;
}

export function walletLinksApi(client: ApiClient) {
  return {
    challenge: (organisationId: string, wallet: string) =>
      client.request("POST", "/v1/wallet-links/challenges", {
        body: { organisationId, wallet },
        timeoutMs: TIMEOUTS.walletLink,
        parse: (data): Challenge => {
          const c = record(data, "challenge", ["challengeId", "message", "expiresAt"]);
          return {
            challengeId: string(c.challengeId, "challengeId", UUID),
            message: string(c.message, "message"),
            expiresAt: string(c.expiresAt, "expiresAt"),
          };
        },
      }),
    complete: (challengeId: string, signatureBase58: string) =>
      client.request("POST", "/v1/wallet-links", {
        body: { challengeId, signatureBase58 },
        timeoutMs: TIMEOUTS.walletLink,
        parse: (data) => {
          const l = record(data, "link", ["linkId", "wallet", "organisationId"]);
          return {
            linkId: string(l.linkId, "linkId", UUID),
            wallet: string(l.wallet, "wallet"),
            organisationId: string(l.organisationId, "organisationId", UUID),
          };
        },
      }),
  };
}
