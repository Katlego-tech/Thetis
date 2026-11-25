import { verify } from "node:crypto";
import bs58 from "bs58";
import { expect, test } from "vitest";
import { linkableWallets, signLinkMessage } from "@/lib/wallets";
import { accountOf, fakeWallet, throwawayKey } from "./fake-wallet";

test("linkableWallets keeps only wallets with connect, signMessage and a solana chain", () => {
  const qualifying = fakeWallet("Backpack");
  const noConnect = fakeWallet("No connect", { without: ["standard:connect"] });
  const noSign = fakeWallet("No sign", { without: ["solana:signMessage"] });
  const evmOnly = fakeWallet("EVM only", { chains: ["eip155:1"] });
  const mixed = fakeWallet("Mixed", { chains: ["eip155:1", "solana:mainnet"] });

  const names = linkableWallets([
    qualifying.wallet,
    noConnect.wallet,
    noSign.wallet,
    evmOnly.wallet,
    mixed.wallet,
  ]).map((w) => w.name);

  expect(names).toEqual(["Backpack", "Mixed"]);
});

test("linkableWallets puts Solflare first, then orders by name", () => {
  const all = ["Phantom", "Backpack", "Solflare", "Glow"].map((name) => fakeWallet(name).wallet);
  const listed = linkableWallets(all);
  expect(listed.map((w) => w.name)).toEqual(["Solflare", "Backpack", "Glow", "Phantom"]);
  expect(listed[0]?.wallet).toBe(all[2]);
  expect(linkableWallets([])).toEqual([]);
});

test("signLinkMessage hands the wallet exactly the UTF-8 bytes and returns the base58 signature", async () => {
  const key = throwawayKey();
  const fake = fakeWallet("Solflare", { key });
  const message =
    "localhost:3100 wants you to link a Solana wallet to Thetis.\n\nOrganisation: Müller & Söhne";

  const signature = await signLinkMessage(fake.wallet, fake.account, message);

  expect(fake.signMessage).toHaveBeenCalledTimes(1);
  const [input] = fake.signMessage.mock.calls[0] ?? [];
  expect(input.account).toBe(fake.account);
  expect(input.message).toBeInstanceOf(Uint8Array);
  expect(input.message).toEqual(new TextEncoder().encode(message));
  expect(input.message.length).toBeGreaterThan(message.length);

  const raw = bs58.decode(signature);
  expect(raw).toHaveLength(64);
  expect(verify(null, new TextEncoder().encode(message), key.publicKey, raw)).toBe(true);
});

test("signLinkMessage returns whatever the wallet signed, without checking it", async () => {
  const fake = fakeWallet("Solflare");
  const other = throwawayKey();
  fake.signMessage.mockImplementation(async () => [
    {
      signedMessage: new TextEncoder().encode("something else"),
      signature: other.sign(new Uint8Array([1])),
    },
  ]);
  const signature = await signLinkMessage(fake.wallet, accountOf(fake.key), "the text");
  expect(bs58.decode(signature)).toEqual(other.sign(new Uint8Array([1])));
});

test("signLinkMessage rejects when the wallet rejects", async () => {
  const fake = fakeWallet("Solflare");
  fake.signMessage.mockRejectedValue(new Error("User rejected the request"));
  await expect(signLinkMessage(fake.wallet, fake.account, "text")).rejects.toThrow(
    "User rejected the request",
  );
});
