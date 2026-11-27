import { describe, expect, it } from "vitest";
import { checkLinkChallenge } from "../src/link-challenge";

const WALLET = "G7sTxBJ1geeqZF7T3JuPX4bEqhQzyBLYPKAye11RXLrp";
const USER = "fa57ea5f-9cf6-43fc-82b1-592d505bc3d7";
const expected = { wallet: WALLET, organisationSlug: "kopano-stockyard-custody", userId: USER };

// data.md §5, written out here independently of src/.
function message(overrides: Record<string, string> = {}, first = "localhost:3000") {
  const lines: [string, string][] = [
    ["Wallet", WALLET],
    ["Organisation", "kopano-stockyard-custody"],
    ["User", USER],
    ["Action", "link_wallet"],
    ["Nonce", "0123456789abcdef0123456789abcdef"],
    ["Issued At", "2026-11-27T08:00:00.000Z"],
    ["Expiration Time", "2026-11-27T08:05:00.000Z"],
  ];
  return [
    `${first} wants you to link a Solana wallet to Thetis.`,
    "",
    ...lines.map(([label, value]) => `${label}: ${overrides[label] ?? value}`),
  ].join("\n");
}

describe("the wallet-link message (F7, data.md §5)", () => {
  it("accepts the exact message for this wallet, organisation and user", () => {
    expect(checkLinkChallenge(message(), expected)).toBe(true);
  });

  it.each([
    ["another wallet", message({ Wallet: "11111111111111111111111111111111" })],
    ["another organisation", message({ Organisation: "port-terminal-t1" })],
    ["another user", message({ User: "00000000-0000-4000-8000-000000000000" })],
    ["another action", message({ Action: "authorise_transaction" })],
    ["a short nonce", message({ Nonce: "abc" })],
    ["CRLF line ends", message().replaceAll("\n", "\r\n")],
    ["a non-ASCII byte", message({}, "lоcalhost:3000")],
    ["a trailing newline", `${message()}\n`],
    ["an extra line", `${message()}\nAmount: 5`],
    ["a missing line", message().split("\n").slice(0, -1).join("\n")],
    ["another first line", message().replace("link a Solana wallet", "sign in")],
  ])("refuses %s", (_, text) => {
    expect(checkLinkChallenge(text, expected)).toBe(false);
  });
});
