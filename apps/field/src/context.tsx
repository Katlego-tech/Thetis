// What every screen shares once the gates have passed: the person, the organisation, the
// instance, the clients, the tabs and their route stacks.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createContext, type ReactNode, useContext, useEffect } from "react";
import type { ApiClient } from "./api/client";
import type { CommandsApi } from "./api/commands";
import type { evidenceApi } from "./api/evidence";
import type { FieldApi } from "./api/field";
import type { walletLinksApi } from "./api/walletLinks";
import { TabBar } from "./components/TabBar";
import type { FieldConfig } from "./config";
import type { Membership } from "./data/reads";
import type { DraftStore, StoredWallet } from "./drafts/store";
import type { Tab } from "./nav";
import type { OfflineCache } from "./offline-cache";
import type { ProtocolContext } from "./protocol";
import type { WalletConnection } from "./wallet";

export type Route =
  | { name: "home" }
  | { name: "account" } // replaces { name: "wallet" }: the Account tab's root
  | { name: "intake"; draftId: string }
  | { name: "issue"; draftId: string }
  // Custody flows: the holder's batches, one handover command (either side), the terminal's
  // loadings, one loading intent, and a border observation.
  | { name: "batches" }
  | { name: "handover"; commandId: string }
  | { name: "loadings" }
  | { name: "loading"; intent: string }
  | { name: "observation" };

export interface AppContextValue {
  config: FieldConfig;
  db: SupabaseClient;
  client: ApiClient;
  commands: CommandsApi;
  walletLinks: ReturnType<typeof walletLinksApi>;
  evidence: ReturnType<typeof evidenceApi>;
  field: FieldApi;
  store: DraftStore;
  cache: OfflineCache;
  user: { id: string; email: string };
  memberships: Membership[];
  organisation: Membership;
  chooseOrganisation: (organisationId: string | null) => void;
  protocol: ProtocolContext;
  refreshProtocol: () => void;
  /** False when the network is down, and in offline mode: then nothing needing it is offered. */
  online: boolean;
  /** When the gates opened from this phone's cache (offline cold start): the oldest read's time. */
  offlineSince: string | null;
  wallet: StoredWallet | null;
  setWallet: (wallet: StoredWallet | null) => Promise<void>;
  connection: WalletConnection | null;
  setConnection: (connection: WalletConnection | null) => void;
  /** Pushes on the current tab's stack; a tab's root switches to that tab (navigation.md §4.3). */
  navigate: (route: Route) => void;
  back: () => void;
  sessionExpired: () => void;
  signOut: () => void;
  tab: Tab;
  tabs: Tab[];
  openTab: (tab: Tab) => void;
  /** A wallet or relay call is in flight: the tabs and the switcher are disabled, Back is ignored. */
  busy: boolean;
  setBusy: (busy: boolean) => void;
  /** Opens SignedIn's organisation Picker; a no-op with one membership or while busy. */
  switchOrganisation: () => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp outside the app's gates");
  return value;
}

/** Marks a wallet or relay call in flight; clears on unmount. */
export function useBusy(active: boolean): void {
  const { setBusy } = useApp();
  useEffect(() => {
    if (!active) return;
    setBusy(true);
    return () => setBusy(false);
  }, [active, setBusy]);
}

/** For a tab root's Frame: the tab bar and the top-bar switcher; {} on pushed screens. */
export function useRootChrome(): { tabBar?: ReactNode; onSwitchOrganisation?: () => void } {
  const app = useApp();
  return {
    tabBar: <TabBar tabs={app.tabs} current={app.tab} disabled={app.busy} onSelect={app.openTab} />,
    onSwitchOrganisation: app.memberships.length > 1 ? app.switchOrganisation : undefined,
  };
}
