// Shared set-up for the custody screens: a phone for each organisation, a wallet stand-in and the
// few queries every screen test makes. The test file mocks the modules; this only drives them.
import { type MobileWallet, transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import { screen, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import type { AppContextValue } from "../../src/context";
import { readChainOrganisation } from "../../src/data/reads";
import { decodeBase58, encodeBase58, encodeBase64 } from "../../src/lib/encoding";
import {
  kopanoChain,
  kopanoMembership,
  moselaChain,
  moselaMembership,
  portChain,
  portMembership,
} from "../custody-fixtures";
import { fakeApp, WALLET } from "./app";

export type Who = "kopano" | "mosela" | "port";

const PHONES = {
  kopano: { membership: kopanoMembership, chain: kopanoChain },
  mosela: { membership: moselaMembership, chain: moselaChain },
  port: { membership: portMembership, chain: portChain },
} as const;

/** The base58 of the 64 bytes the wallet stand-in appends to the text it "signs". */
export const SIGNATURE = encodeBase58(new Uint8Array(64).fill(9));

/** A phone signed in as `who`: its organisation, the chain organisation the index reads for it. */
export function phone(who: Who, overrides: Partial<AppContextValue> = {}): AppContextValue {
  const { membership, chain } = PHONES[who];
  vi.mocked(readChainOrganisation).mockReset();
  vi.mocked(readChainOrganisation).mockResolvedValue(chain);
  const app = fakeApp({ organisation: membership, memberships: [membership], ...overrides });
  vi.mocked(app.field.batches).mockResolvedValue([]);
  vi.mocked(app.field.loadingIntents).mockResolvedValue([]);
  return app;
}

/**
 * Makes the wallet stand-in answer: authorize offers WALLET, and signMessages returns the text with
 * 64 bytes appended. The wallet's real key is never used. Returns the signMessages spy.
 */
export function installWallet() {
  const signMessages = vi.fn(async ({ payloads }: { payloads: string[] }) => ({
    signed_payloads: payloads.map((payload) =>
      encodeBase64(
        new Uint8Array([...Buffer.from(payload, "base64"), ...new Uint8Array(64).fill(9)]),
      ),
    ),
  }));
  vi.mocked(transact).mockReset();
  vi.mocked(transact).mockImplementation(async (callback) =>
    callback({
      authorize: async () => ({
        accounts: [{ address: encodeBase64(decodeBase58(WALLET)) }],
        auth_token: "token",
        wallet_uri_base: "https://wallet.example",
      }),
      signMessages,
    } as unknown as MobileWallet),
  );
  return signMessages;
}

export const button = (name: string) =>
  screen.queryByRole("button", { name }) as HTMLButtonElement | null;

/** Waits until the named button is on screen and can be pressed. */
export async function enabled(name: string): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const found = screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(found.disabled).toBe(false);
    return found;
  });
}

/** True when the named button is absent, or present and not pressable. */
export function cannotPress(name: string): boolean {
  const found = button(name);
  return found === null || found.disabled;
}

/** Everything a summary row shows (its label, value and sub line), found by the row's label. */
export function rowText(label: string): string {
  return screen.getByText(label).parentElement?.textContent ?? "";
}
