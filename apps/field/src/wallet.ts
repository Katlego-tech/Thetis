// Mobile Wallet Adapter, narrowed from the signing spike: connect, and sign one exact text.
import {
  type Account,
  type AuthorizationResult,
  type MobileWallet,
  transact,
} from "@solana-mobile/mobile-wallet-adapter-protocol";
import { decodeBase64, encodeBase58, encodeBase64 } from "./lib/encoding";
import { getMessageSignature, matchesSignedMessage } from "./lib/wire";

export const authorizationRequest = {
  chain: "solana:devnet",
  identity: { name: "Thetis field", uri: "https://github.com/Katlego-tech/Thetis" },
} as const; // replaced by the hosted web domain with Digital Asset Links before release

export interface WalletAccount {
  address: string;
  addressBase64: string;
}

export interface WalletConnection {
  accounts: readonly [WalletAccount, ...WalletAccount[]];
  authToken: string; // memory only
  walletUri: string; // wallet_uri_base
}

/** transact or a wallet call threw: cancelled, session closed, nothing returned. */
export class WalletRefused extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "WalletRefused";
  }
}

/** No usable account, or not the expected one. */
export class WalletAccountError extends Error {
  constructor(
    readonly reason: "no_account" | "wrong_account",
    options?: ErrorOptions,
  ) {
    super(reason, options);
    this.name = "WalletAccountError";
  }
}

export type SignResult =
  | { kind: "signed"; address: string; signatureBase58: string }
  | { kind: "not_asked" }
  | { kind: "payload_mismatch"; receivedBytes: number | null };

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
  // Errors from the callback stay apart from failures opening or closing the session.
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
    throw new WalletAccountError("no_account", { cause });
  }
  const [first, ...others] = accounts;
  if (!first) throw new WalletAccountError("no_account");
  return {
    accounts: [first, ...others],
    authToken: authorization.auth_token,
    walletUri: authorization.wallet_uri_base,
  };
}

export async function connectWallet(walletUri?: string): Promise<WalletConnection> {
  return walletSession(
    async (wallet) =>
      readConnection(await walletCall(() => wallet.authorize(authorizationRequest))),
    walletUri,
  );
}

function readSignedPayload(payload: string) {
  try {
    return decodeBase64(payload);
  } catch {
    return undefined;
  }
}

export async function signText(
  connection: WalletConnection,
  request: { expectedAddress: string; messageBase64: string },
  onAuthorized: (connection: WalletConnection) => void,
  beforeSigning: () => Promise<boolean>,
): Promise<SignResult> {
  const message = decodeBase64(request.messageBase64);
  const signed = await walletSession(async (wallet) => {
    const refreshed = readConnection(
      await walletCall(() => wallet.authorize(authorizationRequest)),
    );
    const account = refreshed.accounts.find(({ address }) => address === request.expectedAddress);
    if (!account) throw new WalletAccountError("wrong_account");
    onAuthorized(refreshed);
    if (!(await beforeSigning())) return undefined;
    const response = await walletCall(() =>
      wallet.signMessages({
        addresses: [account.addressBase64],
        payloads: [request.messageBase64],
      }),
    );
    return { account, payloads: response?.signed_payloads };
  }, connection.walletUri);
  if (!signed) return { kind: "not_asked" };

  const { account, payloads } = signed;
  if (!Array.isArray(payloads)) return { kind: "payload_mismatch", receivedBytes: null };
  if (payloads.length !== 1) {
    return { kind: "payload_mismatch", receivedBytes: payloads.length === 0 ? 0 : null };
  }
  const [payload] = payloads;
  const bytes = typeof payload === "string" ? readSignedPayload(payload) : undefined;
  if (!bytes) return { kind: "payload_mismatch", receivedBytes: null };
  const signature = getMessageSignature(bytes);
  if (!signature || !matchesSignedMessage(bytes, message)) {
    return { kind: "payload_mismatch", receivedBytes: bytes.length };
  }
  return { kind: "signed", address: account.address, signatureBase58: encodeBase58(signature) };
}

/**
 * The connection to open a signing session with. Only the wallet URI is used to reach the wallet;
 * signText authorises afresh and checks the account itself, so a stored address is enough.
 */
export function sessionConnection(
  stored: { address: string; walletUriBase: string },
  connection: WalletConnection | null,
): WalletConnection {
  return (
    connection ?? {
      accounts: [{ address: stored.address, addressBase64: "" }],
      authToken: "",
      walletUri: stored.walletUriBase,
    }
  );
}
