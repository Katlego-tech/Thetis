import { SolanaSignMessage, type SolanaSignMessageFeature } from "@solana/wallet-standard-features";
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
