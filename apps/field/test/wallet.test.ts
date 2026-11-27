import { type MobileWallet, transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import { beforeEach, expect, it, vi } from "vitest";
import { decodeBase64, encodeBase58, encodeBase64 } from "../src/lib/encoding";
import {
  authorizationRequest,
  connectWallet,
  signText,
  WalletAccountError,
  type WalletConnection,
  WalletRefused,
} from "../src/wallet";

vi.mock("@solana-mobile/mobile-wallet-adapter-protocol", () => ({ transact: vi.fn() }));

// Throwaway keys only: these bytes are not anyone's wallet.
const publicKey = new Uint8Array(32).fill(7);
const address = encodeBase58(publicKey);
const addressBase64 = encodeBase64(publicKey);
const connection: WalletConnection = {
  accounts: [{ address, addressBase64 }],
  authToken: "previous-token",
  walletUri: "https://wallet.example",
};
const authorization = {
  accounts: [{ address: addressBase64 }],
  auth_token: "refreshed-token",
  wallet_uri_base: "https://wallet.example/next",
};
const message = Buffer.from("Thetis authorisation v1\nTest network only. Synthetic data.");
const request = { expectedAddress: address, messageBase64: encodeBase64(message) };

function mockWallet(wallet: Partial<MobileWallet>) {
  vi.mocked(transact).mockImplementation(async (callback) => callback(wallet as MobileWallet));
}

beforeEach(() => {
  vi.mocked(transact).mockReset();
});

it("asks for devnet with the field identity", async () => {
  const authorize = vi.fn().mockResolvedValue(authorization);
  mockWallet({ authorize });
  const result = await connectWallet();
  expect(authorize).toHaveBeenCalledWith(authorizationRequest);
  expect(authorizationRequest).toStrictEqual({
    chain: "solana:devnet",
    identity: { name: "Thetis field", uri: "https://github.com/Katlego-tech/Thetis" },
  });
  expect(result.accounts[0].address).toBe(address);
  expect(result.walletUri).toBe("https://wallet.example/next");
});

it("refuses an authorization with no account", async () => {
  mockWallet({ authorize: vi.fn().mockResolvedValue({ ...authorization, accounts: [] }) });
  await expect(connectWallet()).rejects.toBeInstanceOf(WalletAccountError);
});

it("turns a thrown transact into WalletRefused", async () => {
  vi.mocked(transact).mockRejectedValue(new Error("session closed"));
  await expect(connectWallet()).rejects.toBeInstanceOf(WalletRefused);
});

it.each([false, true])(
  "passes exactly the message bytes, nothing prepended (attached signature: %s)",
  async (attached) => {
    const signature = new Uint8Array(64).fill(19);
    const payload = attached ? Uint8Array.of(...message, ...signature) : signature;
    const signMessages = vi.fn().mockResolvedValue({ signed_payloads: [encodeBase64(payload)] });
    mockWallet({ authorize: vi.fn().mockResolvedValue(authorization), signMessages });

    const result = await signText(connection, request, vi.fn(), async () => true);
    expect(signMessages).toHaveBeenCalledWith({
      addresses: [addressBase64],
      payloads: [request.messageBase64],
    });
    expect(decodeBase64(signMessages.mock.lastCall?.[0].payloads[0])).toEqual(
      new Uint8Array(message),
    );
    expect(result).toStrictEqual({
      kind: "signed",
      address,
      signatureBase58: encodeBase58(signature),
    });
  },
);

it("refuses the wrong account before saving its token or asking it to sign", async () => {
  const onAuthorized = vi.fn();
  const signMessages = vi.fn();
  mockWallet({
    authorize: vi.fn().mockResolvedValue({
      ...authorization,
      accounts: [{ address: encodeBase64(new Uint8Array(32).fill(8)) }],
    }),
    signMessages,
  });
  await expect(
    signText(connection, request, onAuthorized, async () => true),
  ).rejects.toBeInstanceOf(WalletAccountError);
  expect(onAuthorized).not.toHaveBeenCalled();
  expect(signMessages).not.toHaveBeenCalled();
});

it("reports a payload that is neither message plus signature nor a bare signature", async () => {
  const payload = Uint8Array.of(42, ...message, ...new Uint8Array(64));
  mockWallet({
    authorize: vi.fn().mockResolvedValue(authorization),
    signMessages: vi.fn().mockResolvedValue({ signed_payloads: [encodeBase64(payload)] }),
  });
  await expect(signText(connection, request, vi.fn(), async () => true)).resolves.toStrictEqual({
    kind: "payload_mismatch",
    receivedBytes: payload.length,
  });
});

it("reports no payload at all as a mismatch with no length", async () => {
  mockWallet({
    authorize: vi.fn().mockResolvedValue(authorization),
    signMessages: vi.fn().mockResolvedValue({ signed_payloads: [] }),
  });
  await expect(signText(connection, request, vi.fn(), async () => true)).resolves.toStrictEqual({
    kind: "payload_mismatch",
    receivedBytes: 0,
  });
});

it("a cancel in the wallet is WalletRefused, after the refreshed token is saved", async () => {
  const onAuthorized = vi.fn();
  mockWallet({
    authorize: vi.fn().mockResolvedValue(authorization),
    signMessages: vi.fn().mockRejectedValue(new Error("User cancelled")),
  });
  await expect(
    signText(connection, request, onAuthorized, async () => true),
  ).rejects.toBeInstanceOf(WalletRefused);
  expect(onAuthorized).toHaveBeenCalledWith({
    accounts: [{ address, addressBase64 }],
    authToken: "refreshed-token",
    walletUri: "https://wallet.example/next",
  });
});

it("beforeSigning false never calls signMessages", async () => {
  const signMessages = vi.fn();
  const authorize = vi.fn().mockResolvedValue(authorization);
  mockWallet({ authorize, signMessages });
  const beforeSigning = vi.fn(async () => {
    expect(authorize).toHaveBeenCalledOnce();
    return false;
  });
  await expect(signText(connection, request, vi.fn(), beforeSigning)).resolves.toStrictEqual({
    kind: "not_asked",
  });
  expect(signMessages).not.toHaveBeenCalled();
});

it("opens the session at the stored wallet URI", async () => {
  mockWallet({
    authorize: vi.fn().mockResolvedValue(authorization),
    signMessages: vi
      .fn()
      .mockResolvedValue({ signed_payloads: [encodeBase64(new Uint8Array(64))] }),
  });
  await signText(connection, request, vi.fn(), async () => true);
  expect(vi.mocked(transact).mock.lastCall?.[1]).toStrictEqual({
    baseUri: "https://wallet.example",
  });
});
