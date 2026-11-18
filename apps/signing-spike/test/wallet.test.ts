import {
  blockhash,
  getCompiledTransactionMessageEncoder,
  address as solanaAddress,
} from "@solana/kit";
import { type MobileWallet, transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import { expect, it, vi } from "vitest";
import { decodeBase64, encodeBase58, encodeBase64 } from "../src/lib/encoding";
import type { Intent } from "../src/lib/relay";
import { wrapUnsignedTransaction } from "../src/lib/wire";
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
const message = getCompiledTransactionMessageEncoder().encode({
  version: "legacy",
  header: {
    numSignerAccounts: 1,
    numReadonlySignerAccounts: 0,
    numReadonlyNonSignerAccounts: 0,
  },
  staticAccounts: [solanaAddress(address)],
  lifetimeToken: blockhash("11111111111111111111111111111111"),
  instructions: [],
});
const intent: Intent = {
  role: "sender",
  expectedAddress: address,
  authorizationBase64: encodeBase64(message),
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

function mockWallet(wallet: Partial<MobileWallet>) {
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

  await expect(
    signWithWallet(connection, intent, "message", saveConnection, async () => true),
  ).rejects.toThrow("User cancelled signing");
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

  await expect(
    signWithWallet(connection, intent, "message", saveConnection, async () => true),
  ).rejects.toThrow("The authorized address does not match this role.");
  expect(saveConnection).not.toHaveBeenCalled();
  expect(signMessages).not.toHaveBeenCalled();
});

it.each(["message", "transaction"] as const)(
  "rechecks freshness after wallet authorization and suppresses the %s signing prompt",
  async (route) => {
    const authorize = vi.fn().mockResolvedValue(authorization);
    const signMessages = vi.fn();
    const signTransactions = vi.fn();
    mockWallet({ authorize, signMessages, signTransactions });
    const checkFreshness = vi.fn(async () => {
      expect(authorize).toHaveBeenCalledOnce();
      return false;
    });

    await expect(
      signWithWallet(connection, intent, route, vi.fn(), checkFreshness),
    ).resolves.toBeUndefined();
    expect(checkFreshness).toHaveBeenCalledOnce();
    expect(signMessages).not.toHaveBeenCalled();
    expect(signTransactions).not.toHaveBeenCalled();
  },
);

it("reports a prefixed message's received length and submits its trailing signature with the digest", async () => {
  const signature = new Uint8Array(64).fill(19);
  const payload = Uint8Array.of(42, ...message, ...signature);
  const checkFreshness = vi.fn().mockResolvedValue(true);
  const signMessages = vi.fn(() => {
    expect(checkFreshness).toHaveBeenCalledOnce();
    return Promise.resolve({ signed_payloads: [encodeBase64(payload)] });
  });
  mockWallet({ authorize: vi.fn().mockResolvedValue(authorization), signMessages });

  await expect(
    signWithWallet(connection, intent, "message", vi.fn(), checkFreshness),
  ).resolves.toEqual({
    payloadMismatch: payload.length,
    submission: {
      role: "sender",
      route: "message",
      address,
      authorizationSha256: intent.authorizationSha256,
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
  const result = await signWithWallet(connection, intent, "message", vi.fn(), async () => true);
  expect(result?.payloadMismatch).toBe(63);
  expect(result?.submission).toBeUndefined();
});

it.each(["extra bytes", "changed message at the expected length"] as const)(
  "reports a signed transaction with %s and submits the full payload with the digest",
  async (change) => {
    const unsigned = wrapUnsignedTransaction(decodeBase64(intent.authorizationBase64));
    const payload =
      change === "extra bytes" ? Uint8Array.of(...unsigned, 99) : Uint8Array.from(unsigned);
    if (change !== "extra bytes") payload.set([1], payload.length - 1);
    const signed = encodeBase64(payload);
    const signTransactions = vi.fn().mockResolvedValue({ signed_payloads: [signed] });
    mockWallet({ authorize: vi.fn().mockResolvedValue(authorization), signTransactions });

    await expect(
      signWithWallet(connection, intent, "transaction", vi.fn(), async () => true),
    ).resolves.toEqual({
      payloadMismatch: payload.length,
      submission: {
        role: "sender",
        route: "transaction",
        address,
        authorizationSha256: intent.authorizationSha256,
        signedTransactionBase64: signed,
      },
    });
    expect(signTransactions).toHaveBeenCalledWith({ payloads: [encodeBase64(unsigned)] });
  },
);
