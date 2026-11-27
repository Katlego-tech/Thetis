import {
  SolanaSignMessage,
  type SolanaSignMessageFeature,
  SolanaSignTransaction,
  type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { StandardConnect } from "@wallet-standard/features";
import bs58 from "bs58";

export type LinkableWallet = { name: string; wallet: Wallet };

const preferredWallet = "Solflare";

export function linkableWallets(all: readonly Wallet[]): LinkableWallet[] {
  return all
    .filter(
      (wallet) =>
        StandardConnect in wallet.features &&
        SolanaSignMessage in wallet.features &&
        wallet.chains.some((chain) => chain.startsWith("solana:")),
    )
    .map((wallet) => ({ name: wallet.name, wallet }))
    .sort((a, b) => {
      if (a.name === b.name) return 0;
      if (a.name === preferredWallet) return -1;
      if (b.name === preferredWallet) return 1;
      return a.name < b.name ? -1 : 1;
    });
}

// Posts whatever signature the wallet returns: the API verifies it, not this function.
export async function signLinkMessage(
  w: Wallet,
  account: WalletAccount,
  message: string,
): Promise<string> {
  const feature = w.features[SolanaSignMessage] as
    | SolanaSignMessageFeature[typeof SolanaSignMessage]
    | undefined;
  if (!feature) throw new Error(`${w.name} cannot sign messages`);
  const [output] = await feature.signMessage({
    account,
    message: new TextEncoder().encode(message),
  });
  if (!output) throw new Error(`${w.name} returned no signature`);
  return bs58.encode(output.signature);
}

export type SigningWallet = { name: string; wallet: Wallet; signsTransactions: boolean };

/** Wallets that connect and sign messages, Solflare first, then by name (live-lending.md §6.8). */
export function signingWallets(all: readonly Wallet[]): SigningWallet[] {
  return all
    .filter((wallet) => StandardConnect in wallet.features && SolanaSignMessage in wallet.features)
    .map((wallet) => {
      const feature = wallet.features[SolanaSignTransaction] as
        | SolanaSignTransactionFeature[typeof SolanaSignTransaction]
        | undefined;
      const versions: readonly unknown[] = feature?.supportedTransactionVersions ?? [];
      return { name: wallet.name, wallet, signsTransactions: versions.includes(0) };
    })
    .sort((a, b) => {
      if (a.name === b.name) return 0;
      if (a.name === preferredWallet) return -1;
      if (b.name === preferredWallet) return 1;
      return a.name < b.name ? -1 : 1;
    });
}

/** Signs the exact bytes the API issued; returns the signature in base58. */
export async function signTextBytes(
  w: Wallet,
  account: WalletAccount,
  bytes: Uint8Array,
): Promise<string> {
  const feature = w.features[SolanaSignMessage] as
    | SolanaSignMessageFeature[typeof SolanaSignMessage]
    | undefined;
  if (!feature) throw new Error(`${w.name} cannot sign messages`);
  const [output] = await feature.signMessage({ account, message: bytes });
  if (!output) throw new Error(`${w.name} returned no signature`);
  return bs58.encode(output.signature);
}

/** Has the wallet sign a wire transaction and returns the bytes it gives back, unchanged. */
export async function signTransactionBytes(
  w: Wallet,
  account: WalletAccount,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const feature = w.features[SolanaSignTransaction] as
    | SolanaSignTransactionFeature[typeof SolanaSignTransaction]
    | undefined;
  if (!feature) throw new Error(`${w.name} cannot sign transactions`);
  const [output] = await feature.signTransaction({
    account,
    transaction: bytes,
    chain: "solana:devnet",
  });
  if (!output) throw new Error(`${w.name} returned no transaction`);
  return output.signedTransaction;
}
