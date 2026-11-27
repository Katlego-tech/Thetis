// The wallet-link message the API hands out (data.md §5), checked before the wallet is asked to
// sign it: exactly that message, for this wallet, this organisation and this person, and nothing
// that could read as a Thetis authorisation.

export interface LinkExpectation {
  wallet: string;
  organisationSlug: string;
  userId: string;
}

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIRST_LINE = /^[\x21-\x7e]+ wants you to link a Solana wallet to Thetis\.$/;

export function checkLinkChallenge(message: string, expected: LinkExpectation): boolean {
  // Printable ASCII and \n only: no \r, tabs or look-alike letters.
  if (!/^[\x20-\x7e\n]*$/.test(message)) return false;
  const lines = message.split("\n");
  const fixed: [string, (value: string) => boolean][] = [
    ["Wallet", (v) => v === expected.wallet],
    ["Organisation", (v) => v === expected.organisationSlug],
    ["User", (v) => v === expected.userId],
    ["Action", (v) => v === "link_wallet"],
    ["Nonce", (v) => /^[0-9a-f]{32}$/.test(v)],
    ["Issued At", (v) => ISO_MS.test(v)],
    ["Expiration Time", (v) => ISO_MS.test(v)],
  ];
  if (lines.length !== 2 + fixed.length) return false;
  if (!FIRST_LINE.test(lines[0] ?? "") || lines[1] !== "") return false;
  return fixed.every(([label, valid], index) => {
    const line = lines[index + 2] ?? "";
    const prefix = `${label}: `;
    return line.startsWith(prefix) && valid(line.slice(prefix.length));
  });
}
