// What every screen shares once the gates have passed: the person, the organisation, the
// instance, the clients and the route stack.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext } from "react";
import type { ApiClient } from "./api/client";
import type { CommandsApi } from "./api/commands";
import type { evidenceApi } from "./api/evidence";
import type { walletLinksApi } from "./api/walletLinks";
import type { FieldConfig } from "./config";
import type { Membership } from "./data/reads";
import type { DraftStore, StoredWallet } from "./drafts/store";
import type { OfflineCache } from "./offline-cache";
import type { ProtocolContext } from "./protocol";
import type { WalletConnection } from "./wallet";

export type Route =
  | { name: "home" }
  | { name: "wallet" }
  | { name: "intake"; draftId: string }
  | { name: "issue"; draftId: string };

export interface AppContextValue {
  config: FieldConfig;
  db: SupabaseClient;
  client: ApiClient;
  commands: CommandsApi;
  walletLinks: ReturnType<typeof walletLinksApi>;
  evidence: ReturnType<typeof evidenceApi>;
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
  navigate: (route: Route) => void;
  back: () => void;
  sessionExpired: () => void;
  signOut: () => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp outside the app's gates");
  return value;
}
