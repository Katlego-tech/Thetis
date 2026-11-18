import {
  type Account,
  type AuthorizationResult,
  type MobileWallet,
  transact,
} from "@solana-mobile/mobile-wallet-adapter-protocol";
import { copy } from "./lib/copy";
import { decodeBase64, encodeBase58, encodeBase64 } from "./lib/encoding";
import type { Intent, Route } from "./lib/relay";
import { getMessageSignature, wrapUnsignedTransaction } from "./lib/wire";
import type { SignatureSubmission } from "./relay-client";

const authorizationRequest = {
  chain: "solana:devnet",
  identity: { name: copy.title },
} as const;

export interface WalletConnection {
  address: string;
  addressBase64: string;
  authToken: string;
  walletUri: string;
}

function walletAddress(account: Account): WalletConnection["addressBase64"] {
  if ("publicKey" in account) return encodeBase64(account.publicKey);
  return account.address;
}

function selectAccount(authorization: AuthorizationResult, expected?: string): WalletConnection {
  const accounts = authorization.accounts.map((account) => {
    const addressBase64 = walletAddress(account);
    const bytes = decodeBase64(addressBase64);
    if (bytes.length !== 32) throw new Error("Wallet returned an invalid account address");
    return { addressBase64, address: encodeBase58(bytes) };
  });
  const account = accounts.find(({ address }) => address === expected) ?? accounts[0];
  if (!account) throw new Error("Wallet returned no authorized account");

  return {
    ...account,
    authToken: authorization.auth_token,
    walletUri: authorization.wallet_uri_base,
  };
}

export async function connectWallet(expected?: string): Promise<WalletConnection> {
  return transact(async (wallet) =>
    selectAccount(await wallet.authorize(authorizationRequest), expected),
  );
}

async function sign(
  wallet: MobileWallet,
  connection: WalletConnection,
  intent: Intent,
  route: Route,
  onAuthorized: (account: WalletConnection) => void,
) {
  const authorization = await wallet.authorize({
    ...authorizationRequest,
    auth_token: connection.authToken,
  });
  const account = selectAccount(authorization, intent.expectedAddress);
  if (account.address !== intent.expectedAddress) throw new Error(copy.walletMismatch);
  onAuthorized(account);

  const message = decodeBase64(intent.authorizationBase64);
  const common = { role: intent.role, address: account.address };
  let submission: SignatureSubmission;
  if (route === "message") {
    const {
      signed_payloads: [signed],
    } = await wallet.signMessages({
      addresses: [account.addressBase64],
      payloads: [intent.authorizationBase64],
    });
    if (!signed) throw new Error("Wallet returned no signed message");
    submission = {
      ...common,
      route,
      signatureBase58: encodeBase58(getMessageSignature(decodeBase64(signed), message.length)),
    };
  } else {
    const {
      signed_payloads: [signed],
    } = await wallet.signTransactions({
      payloads: [encodeBase64(wrapUnsignedTransaction(message))],
    });
    if (!signed) throw new Error("Wallet returned no signed transaction");
    submission = { ...common, route, signedTransactionBase64: signed };
  }

  return submission;
}

export async function signWithWallet(
  connection: WalletConnection,
  intent: Intent,
  route: Route,
  onAuthorized: (account: WalletConnection) => void,
) {
  return transact(
    (wallet) => sign(wallet, connection, intent, route, onAuthorized),
    connection.walletUri ? { baseUri: connection.walletUri } : undefined,
  );
}
