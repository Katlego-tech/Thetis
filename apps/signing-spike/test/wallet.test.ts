import { type MobileWallet, transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import { expect, it, vi } from "vitest";
import { decodeBase64, encodeBase58, encodeBase64 } from "../src/lib/encoding";
import type { Intent } from "../src/lib/relay";
import { connectWallet, signIntent, type WalletConnection } from "../src/wallet";

vi.mock("@solana-mobile/mobile-wallet-adapter-protocol", () => ({ transact: vi.fn() }));

const publicKey = new Uint8Array(32).fill(7);
const address = encodeBase58(publicKey);
const addressBase64 = encodeBase64(publicKey);
const connection: WalletConnection = {
  accounts: [{ address, addressBase64 }],
  authToken: "previous-token",
  walletUri: "",
};
const authorization = {
  accounts: [{ address: addressBase64 }],
  auth_token: "refreshed-token",
  wallet_uri_base: "https://wallet.example",
};
const expectedIdentity = {
  name: "Thetis signing spike",
  uri: "https://github.com/Katlego-tech/Thetis",
};
const messageText = "Thetis authorisation v1\nTest network only. Synthetic data.";
const message = Buffer.from(messageText);
const intent: Intent = {
  role: "sender",
  expectedAddress: address,
  messageBase64: encodeBase64(message),
  messageText,
  messageSha256: "0".repeat(64),
  validUntil: "1795098725",
  validUntilText: "2026-11-19 16:32:05 SAST",
  expectedSequence: "0",
  network: "devnet",
};

function mockWallet(wallet: Partial<MobileWallet>) {
  vi.mocked(transact).mockImplementation(async (callback) => callback(wallet as MobileWallet));
}

it("sends the exact MWA identity when connecting", async () => {
  const authorize = vi.fn<MobileWallet["authorize"]>().mockResolvedValue(authorization);
  mockWallet({ authorize });

  await connectWallet();

  expect(authorize.mock.calls[0]?.[0].identity).toStrictEqual(expectedIdentity);
});

it("saves the refreshed token before signing even when the wallet cancels", async () => {
  const saveConnection = vi.fn();
  const authorize = vi.fn().mockResolvedValue(authorization);
  const refreshedConnection = {
    accounts: [{ address, addressBase64 }],
    authToken: authorization.auth_token,
    walletUri: authorization.wallet_uri_base,
  };
  const signMessages = vi.fn(() => {
    expect(saveConnection).toHaveBeenCalledWith(refreshedConnection);
    throw new Error("User cancelled signing");
  });
  mockWallet({ authorize, signMessages });

  await expect(signIntent(connection, intent, saveConnection, async () => true)).rejects.toThrow(
    "User cancelled signing",
  );
  expect(authorize.mock.calls).toStrictEqual([
    [{ chain: "solana:devnet", identity: expectedIdentity }],
  ]);
  expect(signMessages).toHaveBeenCalledOnce();
  expect(saveConnection.mock.calls).toStrictEqual([[refreshedConnection]]);
});

it("rejects a different wallet account before saving its token or asking it to sign", async () => {
  const saveConnection = vi.fn();
  const authorize = vi.fn().mockResolvedValue({
    ...authorization,
    accounts: [{ address: encodeBase64(new Uint8Array(32).fill(8)) }],
  });
  const signMessages = vi.fn();
  mockWallet({ authorize, signMessages });

  await expect(signIntent(connection, intent, saveConnection, async () => true)).rejects.toThrow(
    "The authorized address does not match this role.",
  );
  expect(saveConnection).not.toHaveBeenCalled();
  expect(signMessages).not.toHaveBeenCalled();
});

it("rechecks freshness after wallet authorization before prompting for a signature", async () => {
  const authorize = vi.fn().mockResolvedValue(authorization);
  const signMessages = vi.fn();
  mockWallet({ authorize, signMessages });
  const checkFreshness = vi.fn(async () => {
    expect(authorize).toHaveBeenCalledOnce();
    return false;
  });

  await expect(signIntent(connection, intent, vi.fn(), checkFreshness)).resolves.toBeUndefined();
  expect(checkFreshness).toHaveBeenCalledOnce();
  expect(signMessages).not.toHaveBeenCalled();
});

it("reports a prefixed message's received length and submits its trailing signature with the digest", async () => {
  const signature = new Uint8Array(64).fill(19);
  const payload = Uint8Array.of(42, ...message, ...signature);
  const checkFreshness = vi.fn().mockResolvedValue(true);
  const signMessages = vi.fn(() => {
    expect(checkFreshness).toHaveBeenCalledOnce();
    return Promise.resolve({ signed_payloads: [encodeBase64(payload)] });
  });
  mockWallet({ authorize: vi.fn().mockResolvedValue(authorization), signMessages });

  await expect(signIntent(connection, intent, vi.fn(), checkFreshness)).resolves.toEqual({
    payloadMismatch: payload.length,
    submission: {
      role: "sender",
      address,
      messageSha256: intent.messageSha256,
      signatureBase58: encodeBase58(signature),
    },
  });
});

it("reports a short message as a payload mismatch without fabricating a signature", async () => {
  mockWallet({
    authorize: vi.fn().mockResolvedValue(authorization),
    signMessages: vi
      .fn()
      .mockResolvedValue({ signed_payloads: [encodeBase64(new Uint8Array(63))] }),
  });
  const result = await signIntent(connection, intent, vi.fn(), async () => true);
  expect(result?.payloadMismatch).toBe(63);
  expect(result?.submission).toBeUndefined();
});

it.each([false, true])(
  "sends the exact message bytes and reads the signature (attached: %s)",
  async (attached) => {
    const signature = new Uint8Array(64).fill(19);
    const payload = attached ? Uint8Array.of(...message, ...signature) : signature;
    const signMessages = vi.fn().mockResolvedValue({ signed_payloads: [encodeBase64(payload)] });
    mockWallet({ authorize: vi.fn().mockResolvedValue(authorization), signMessages });

    const signed = await signIntent(connection, intent, vi.fn(), async () => true);
    expect(signMessages).toHaveBeenCalledWith({
      addresses: [addressBase64],
      payloads: [intent.messageBase64],
    });
    expect(decodeBase64(signMessages.mock.lastCall?.[0].payloads[0])).toEqual(
      decodeBase64(intent.messageBase64),
    );
    expect(signed?.payloadMismatch).toBeUndefined();
    expect(signed?.submission).toEqual({
      role: "sender",
      address,
      messageSha256: intent.messageSha256,
      signatureBase58: encodeBase58(signature),
    });
  },
);
