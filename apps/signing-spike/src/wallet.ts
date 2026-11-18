import {
  type Account,
  type AuthorizationResult,
  type MobileWallet,
  transact,
} from "@solana-mobile/mobile-wallet-adapter-protocol";
import { copy } from "./lib/copy";
import { decodeBase64, encodeBase58, encodeBase64 } from "./lib/encoding";
import type { Intent, Route } from "./lib/relay";
import {
  getMessageSignature,
  matchesSignedMessage,
  matchesSignedTransaction,
  wrapUnsignedTransaction,
} from "./lib/wire";
import type { SignatureSubmission } from "./relay-client";

const authorizationRequest = {
  chain: "solana:devnet",
  identity: { name: copy.title },
} as const;

interface WalletAccount {
  address: string;
  addressBase64: string;
}

export interface WalletConnection {
  accounts: readonly [WalletAccount, ...WalletAccount[]];
  authToken: string;
  walletUri: string;
}

export class WalletRefused extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export class WalletAccountError extends Error {}

async function walletCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new WalletRefused(error);
  }
}

async function walletSession<T>(
  action: (wallet: MobileWallet) => Promise<T>,
  walletUri?: string,
): Promise<T> {
  // Keep callback errors separate from failures opening or closing the MWA session.
  const result = await walletCall(() =>
    transact(
      async (wallet) => {
        try {
          return { value: await action(wallet) };
        } catch (error) {
          return { error };
        }
      },
      walletUri ? { baseUri: walletUri } : undefined,
    ),
  );
  if ("error" in result) throw result.error;
  return result.value;
}

function walletAddress(account: Account): string {
  if ("publicKey" in account) return encodeBase64(account.publicKey);
  return account.address;
}

function readConnection(authorization: AuthorizationResult): WalletConnection {
  let accounts: WalletAccount[];
  try {
    accounts = authorization.accounts.map((account) => {
      const addressBase64 = walletAddress(account);
      const bytes = decodeBase64(addressBase64);
      if (bytes.length !== 32) throw new Error("Invalid account address length");
      return { addressBase64, address: encodeBase58(bytes) };
    });
  } catch (cause) {
    throw new WalletAccountError(copy.walletInvalidAddress, { cause });
  }
  const [first, ...others] = accounts;
  if (!first) throw new WalletAccountError(copy.walletNoAccount);

  return {
    accounts: [first, ...others],
    authToken: authorization.auth_token,
    walletUri: authorization.wallet_uri_base,
  };
}

export async function connectWallet(): Promise<WalletConnection> {
  return walletSession(async (wallet) =>
    readConnection(await walletCall(() => wallet.authorize(authorizationRequest))),
  );
}

type WalletPayload = { submission?: SignatureSubmission; payloadMismatch?: number | null };

export async function signWithWallet(
  connection: WalletConnection,
  intent: Intent,
  route: Route,
  onAuthorized: (connection: WalletConnection) => void,
  beforeSigning: () => Promise<boolean>,
): Promise<WalletPayload | undefined> {
  const message = decodeBase64(intent.authorizationBase64);
  const unsignedPayload = route === "transaction" ? wrapUnsignedTransaction(message) : message;
  const payloadBase64 = encodeBase64(unsignedPayload);
  const signed = await walletSession(async (wallet) => {
    const authorization = await walletCall(() =>
      wallet.authorize({ ...authorizationRequest, auth_token: connection.authToken }),
    );
    const refreshed = readConnection(authorization);
    const account = refreshed.accounts.find(({ address }) => address === intent.expectedAddress);
    if (!account) throw new WalletAccountError(copy.walletMismatch);
    onAuthorized(refreshed);

    if (!(await beforeSigning())) return undefined;
    const response = await walletCall(() =>
      route === "message"
        ? wallet.signMessages({ addresses: [account.addressBase64], payloads: [payloadBase64] })
        : wallet.signTransactions({ payloads: [payloadBase64] }),
    );
    return { account, payloads: response?.signed_payloads };
  }, connection.walletUri);
  if (!signed) return undefined;

  const { account, payloads } = signed;
  if (!Array.isArray(payloads)) return { payloadMismatch: null };
  if (payloads.length === 0) return { payloadMismatch: 0 };
  const [payload] = payloads;
  if (typeof payload !== "string") return { payloadMismatch: null };
  const bytes = readSignedPayload(payload);
  if (!bytes) return { payloadMismatch: null };

  const common = {
    role: intent.role,
    address: account.address,
    authorizationSha256: intent.authorizationSha256,
  };
  if (route === "message") {
    const signature = getMessageSignature(bytes);
    if (!signature) return { payloadMismatch: bytes.length };
    return {
      submission: { ...common, route, signatureBase58: encodeBase58(signature) },
      payloadMismatch:
        payloads.length === 1 && matchesSignedMessage(bytes, message) ? undefined : bytes.length,
    };
  }

  if (bytes.length === 0) return { payloadMismatch: 0 };
  return {
    submission: { ...common, route, signedTransactionBase64: payload },
    payloadMismatch:
      payloads.length === 1 && matchesSignedTransaction(bytes, unsignedPayload.length, message)
        ? undefined
        : bytes.length,
  };
}

function readSignedPayload(payload: string) {
  try {
    return decodeBase64(payload);
  } catch {
    return undefined;
  }
}
