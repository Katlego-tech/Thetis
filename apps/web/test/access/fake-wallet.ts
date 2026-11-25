import { sign as ed25519Sign, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import bs58 from "bs58";
import { type Mock, vi } from "vitest";

const icon = "data:image/svg+xml;base64,PHN2Zy8+" as const;

export type ThrowawayKey = {
  address: string;
  publicKey: KeyObject;
  rawPublicKey: Uint8Array;
  sign: (message: Uint8Array) => Uint8Array;
};

/** A key made for one test run. It belongs to no party. */
export function throwawayKey(): ThrowawayKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x;
  if (!x) throw new Error("no public key");
  const rawPublicKey = new Uint8Array(Buffer.from(x, "base64url"));
  return {
    address: bs58.encode(rawPublicKey),
    publicKey,
    rawPublicKey,
    sign: (message) => new Uint8Array(ed25519Sign(null, message, privateKey)),
  };
}

export function accountOf(key: ThrowawayKey, chains: string[] = ["solana:devnet"]): WalletAccount {
  return {
    address: key.address,
    publicKey: key.rawPublicKey,
    chains: chains as WalletAccount["chains"],
    features: ["solana:signMessage"],
  };
}

type Change = { accounts?: readonly WalletAccount[] };
type Listener = (properties: Change) => void;

export type FakeWallet = {
  wallet: Wallet;
  key: ThrowawayKey;
  account: WalletAccount;
  connect: Mock;
  signMessage: Mock;
  listeners: Set<Listener>;
  emitChange: (properties: Change) => void;
};

export function fakeWallet(
  name: string,
  options: {
    chains?: string[];
    without?: ("standard:connect" | "solana:signMessage")[];
    key?: ThrowawayKey;
  } = {},
): FakeWallet {
  const key = options.key ?? throwawayKey();
  const account = accountOf(key);
  const listeners = new Set<Listener>();
  const connect = vi.fn(async () => ({ accounts: [account] }));
  const signMessage = vi.fn(async (...inputs: { account: WalletAccount; message: Uint8Array }[]) =>
    inputs.map(({ message }) => ({ signedMessage: message, signature: key.sign(message) })),
  );
  const all: Record<string, unknown> = {
    "standard:connect": { version: "1.0.0", connect },
    "standard:events": {
      version: "1.0.0",
      on: (_event: "change", listener: Listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    "solana:signMessage": { version: "1.1.0", signMessage },
  };
  for (const feature of options.without ?? []) delete all[feature];
  const wallet = {
    version: "1.0.0",
    name,
    icon,
    chains: (options.chains ?? ["solana:devnet"]) as Wallet["chains"],
    features: all as Wallet["features"],
    accounts: [account],
  } satisfies Wallet;
  return {
    wallet,
    key,
    account,
    connect,
    signMessage,
    listeners,
    emitChange: (properties) => {
      for (const listener of [...listeners]) listener(properties);
    },
  };
}
