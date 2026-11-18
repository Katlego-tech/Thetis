import { type MobileWallet, transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import { expect, it, vi } from "vitest";
import { encodeBase58, encodeBase64 } from "../src/lib/encoding";
import type { Intent } from "../src/lib/relay";
import { signWithWallet } from "../src/wallet";

vi.mock("@solana-mobile/mobile-wallet-adapter-protocol", () => ({ transact: vi.fn() }));

const publicKey = new Uint8Array(32).fill(7);
const address = encodeBase58(publicKey);
const addressBase64 = encodeBase64(publicKey);
const connection = { address, addressBase64, authToken: "previous-token", walletUri: "" };
const authorization = {
  accounts: [{ address: addressBase64 }],
  auth_token: "refreshed-token",
  wallet_uri_base: "https://wallet.example",
};
const intent: Intent = {
  role: "sender",
  expectedAddress: address,
  authorizationBase64: "AQ==",
  authorizationSha256: "0".repeat(64),
  intent: {
    text: "Synthetic test data.",
    batchId: "0123456789abcdef0123456789abcdef",
    quantityKg: "2000000",
    from: "Kopano Stockyard Custody",
    to: "Mosela Haulage",
    expirySlot: 9001,
    expectedSequence: 0,
  },
  network: "devnet",
};

function mockWallet(wallet: Pick<MobileWallet, "authorize" | "signMessages">) {
  vi.mocked(transact).mockImplementation(async (callback) => callback(wallet as MobileWallet));
}

it("saves the refreshed token before signing even when the wallet cancels", async () => {
  const saveConnection = vi.fn();
  const authorize = vi.fn().mockResolvedValue(authorization);
  const signMessages = vi.fn(() => {
    expect(saveConnection).toHaveBeenCalledWith({
      address,
      addressBase64,
      authToken: authorization.auth_token,
      walletUri: authorization.wallet_uri_base,
    });
    throw new Error("User cancelled signing");
  });
  mockWallet({ authorize, signMessages });

  await expect(signWithWallet(connection, intent, "message", saveConnection)).rejects.toThrow(
    "User cancelled signing",
  );
  expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ auth_token: "previous-token" }));
  expect(signMessages).toHaveBeenCalledOnce();
  expect(saveConnection).toHaveBeenCalledOnce();
});

it("rejects a different wallet account before saving its token or asking it to sign", async () => {
  const saveConnection = vi.fn();
  const authorize = vi.fn().mockResolvedValue({
    ...authorization,
    accounts: [{ address: encodeBase64(new Uint8Array(32).fill(8)) }],
  });
  const signMessages = vi.fn();
  mockWallet({ authorize, signMessages });

  await expect(signWithWallet(connection, intent, "message", saveConnection)).rejects.toThrow(
    "The authorized address does not match this role.",
  );
  expect(saveConnection).not.toHaveBeenCalled();
  expect(signMessages).not.toHaveBeenCalled();
});
