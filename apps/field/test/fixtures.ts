// Test-only command views. Values are throwaway: the addresses are base58 of fixed bytes, the
// organisation ids are random uuids, and the transaction signature is drawn, not from devnet.
import { createHash } from "node:crypto";
import type { CommandStatus, CommandView } from "../src/api/commands";

export const PROGRAM = "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3";
export const PROTOCOL = "G9GNDdbYKQY14xv1xgNw1D6EY8SFnZxgHrDBdEbHsoo3";
export const KOPANO_ORG = "0b9f4d2e-3c1a-4f6e-9d8b-7a6c5e4d3b2a";
export const KHUNOU_ORG = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
export const TX_SIGNATURE =
  "NEVugYssVA2tVwAx56esENiHkzfvnGiTKuCGWmBjZAbn5BP7mycZCsutqrx6ZapTQxK3NN3NLhfwG6LVx949JVe";
export const LOT_ADDRESS = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
export const OWNER_ORG_ADDRESS = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";

export const DEMO_TEXT = [
  "Thetis authorisation v1",
  "Network: devnet",
  `Program: ${PROGRAM}`,
  "Protocol: 666961742d64656d6f2d72756e2d3031",
  "Action: Issue lot",
  "Lot: CR-0001",
  "Class: CHROME v1",
  "Grade: G1",
  "Quantity: 5,000.000 t",
  "Owner: Khunou Ore Exports",
  "Custodian: Kopano Stockyard Custody",
  "Site: KOPANO-YARD-1",
  "Intake: 71813b946d9d53f619f3cd4e1fce2d7d8dd6cbe8e0fc44876ac5e09a3c1483de",
  "Origin document: not required",
  "Valid until: 2026-11-27 10:14:35 SAST",
  "Test network only. Synthetic data.",
].join("\n");

export function commandView(status: CommandStatus, overrides: Partial<CommandView> = {}): CommandView {
  const sent = status !== "awaiting_signatures" && status !== "expired";
  const confirmed = status === "confirmed";
  return {
    id: "6a1f0c3e-8b2d-4e5f-9a7b-1c2d3e4f5a6b",
    kind: "issue_lot",
    status,
    network: "devnet",
    programId: PROGRAM,
    protocol: PROTOCOL,
    initiatorOrganisationId: KOPANO_ORG,
    parties: [KOPANO_ORG, KHUNOU_ORG],
    lot: LOT_ADDRESS,
    facility: null,
    loan: null,
    intent: null,
    payment: null,
    args: { lotId: "CR-0001", quantityKg: "5000000" },
    fields: [{ label: "Lot", value: "CR-0001" }],
    text: {
      version: 1,
      messageBase64: Buffer.from(DEMO_TEXT).toString("base64"),
      messageSha256: createHash("sha256").update(DEMO_TEXT).digest("hex"),
      validUntil: "1795767275",
      validUntilText: "2026-11-27 10:14:35 SAST",
    },
    signers: [
      {
        role: "custodian",
        organisationId: KOPANO_ORG,
        method: "text",
        signed: sent ? { wallet: "G7sTxBJ1geeqZF7T3JuPX4bEqhQzyBLYPKAye11RXLrp", signedAt: "2026-11-27T08:06:01.000Z" } : null,
      },
    ],
    transaction: sent
      ? { signature: TX_SIGNATURE, sends: 1, explorerUrl: `https://explorer.solana.com/tx/${TX_SIGNATURE}?cluster=devnet` }
      : null,
    confirmedSlot: confirmed ? "526890114" : null,
    confirmedCommitment: confirmed ? "confirmed" : null,
    outcome: confirmed
      ? {
          event: "LotIssued",
          slot: "526890114",
          commitment: "confirmed",
          data: { lot: LOT_ADDRESS, owner: OWNER_ORG_ADDRESS, quantityKg: "5000000" },
        }
      : null,
    error: status === "failed" ? { code: "Anchor0", detail: null } : null,
    createdAt: "2026-11-27T08:05:05.000Z",
    updatedAt: "2026-11-27T08:06:02.000Z",
    ...overrides,
  };
}
