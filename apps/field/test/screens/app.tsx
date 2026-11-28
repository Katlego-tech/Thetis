// A whole AppContext for screen tests: throwaway parties, an in-memory draft store, and command
// routes as spies. Every value is test-only (fixtures.ts says where the addresses come from).
import { act, render } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { vi } from "vitest";
import type { CommandView } from "../../src/api/commands";
import { AppContext, type AppContextValue } from "../../src/context";
import { createDraftStore, editDraft, type IntakeDraft, newDraft } from "../../src/drafts/store";
import type { EvidenceItem } from "../../src/evidence/upload";
import { createOfflineCache } from "../../src/offline-cache";
import { KOPANO_ORG, PROGRAM, PROTOCOL } from "../fixtures";
import { memoryStorage } from "./native";

export const USER = "fa57ea5f-9cf6-43fc-82b1-592d505bc3d7";
export const KHUNOU_ORG = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
export const WALLET = "G7sTxBJ1geeqZF7T3JuPX4bEqhQzyBLYPKAye11RXLrp";
export const SITE_ADDRESS = "5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG";
export const CLASS_POLICY = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
export const OWNER_ADDRESS = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
export const CUSTODIAN_ADDRESS = "3vZ67CubkWnFyUhyJ7PNbbZyXDVGQqS7j7qsc8rTDZ7G";
export const DEMO_PROTOCOL_HEX = "666961742d64656d6f2d72756e2d3031";

export const site = {
  address: SITE_ADDRESS,
  classPolicy: CLASS_POLICY,
  siteCode: "KOPANO-YARD-1",
  roomKg: 10_000_000n,
  classCode: "CHROME",
  classVersion: 1,
  grades: ["G1"],
  originRequired: false,
};
export const owner = {
  address: OWNER_ADDRESS,
  orgId: KHUNOU_ORG,
  displayName: "Khunou Ore Exports",
  synthetic: true,
};
export const chainOrganisation = {
  address: CUSTODIAN_ADDRESS,
  role: "Custodian",
  displayName: "Kopano Stockyard Custody",
};
export const membership = {
  organisationId: KOPANO_ORG,
  memberRole: "member",
  name: "Kopano Stockyard Custody",
  slug: "kopano-stockyard-custody",
  kind: "custodian",
  synthetic: true,
};
export const protocolContext = {
  protocol: PROTOCOL,
  instanceIdHex: DEMO_PROTOCOL_HEX,
  instanceLabel: "fiat-demo-run-01",
  settlementMode: "fiat",
  indexStatus: "running",
  lastSuccessAt: "2026-11-27T08:04:00.000Z",
};

export function finalized(purpose: "weighbridge" | "assay", sha: string): EvidenceItem {
  return {
    localId: `local-${purpose}`,
    purpose,
    localUri: `file:///data/drafts/d-1/local-${purpose}.jpg`,
    mime: "image/jpeg",
    sizeBytes: 1_234,
    capturedAt: "2026-11-27T08:03:00.000Z",
    objectId: `0a0a0a0a-0000-4000-8000-00000000000${purpose === "assay" ? 2 : 1}`,
    versionId: `0b0b0b0b-0000-4000-8000-00000000000${purpose === "assay" ? 2 : 1}`,
    version: 1,
    supersedesId: null,
    storagePath: `${KOPANO_ORG}/x/1`,
    upload: "finalized",
    sha256: sha,
    error: null,
  };
}

/** The demo intake, complete and with both required files finalized: it matches DEMO_TEXT. */
export function completeDraft(): IntakeDraft {
  const now = "2026-11-27T08:04:30.000Z";
  const draft = editDraft(
    newDraft({ id: "d-1", userId: USER, organisationId: KOPANO_ORG, protocol: PROTOCOL, now }),
    {
      custodianClass: SITE_ADDRESS,
      siteCode: "KOPANO-YARD-1",
      classLabel: "CHROME v1",
      ownerOrgId: KHUNOU_ORG,
      ownerName: "Khunou Ore Exports",
      lotId: "CR-0001",
      grade: "G1",
      quantityText: "5000",
      weighbridgeTicket: "WB2611-0042",
      evidence: [
        finalized("weighbridge", "7e8533c2".padEnd(64, "0")),
        finalized("assay", "a1b2c3d4".padEnd(64, "0")),
      ],
    },
    now,
  );
  return { ...draft, lotIdLocked: true, lotIdCommitted: true };
}

export interface Harness {
  app: AppContextValue;
  setOnline: (online: boolean) => void;
}

export function fakeApp(overrides: Partial<AppContextValue> = {}): AppContextValue {
  const storage = memoryStorage();
  return {
    config: {
      apiUrl: "http://127.0.0.1:3200",
      supabaseUrl: "http://127.0.0.1:54321",
      supabaseAnonKey: "anon",
      program: PROGRAM,
      network: "devnet",
    },
    db: {} as AppContextValue["db"],
    client: { request: vi.fn() },
    commands: {
      create: vi.fn<(body: unknown) => Promise<CommandView>>(),
      get: vi.fn<(id: string) => Promise<CommandView>>(),
      sign: vi.fn<(id: string, body: unknown) => Promise<CommandView>>(),
      renew: vi.fn<(id: string) => Promise<CommandView>>(),
    } as unknown as AppContextValue["commands"],
    walletLinks: { challenge: vi.fn(), complete: vi.fn() },
    evidence: { finalize: vi.fn() } as unknown as AppContextValue["evidence"],
    field: { batches: vi.fn(), loadingIntents: vi.fn() } as unknown as AppContextValue["field"],
    store: createDraftStore(storage),
    cache: createOfflineCache(memoryStorage()),
    user: { id: USER, email: "custodian@example.test" },
    memberships: [membership],
    organisation: membership,
    chooseOrganisation: vi.fn(),
    protocol: protocolContext,
    refreshProtocol: vi.fn(),
    online: true,
    offlineSince: null,
    wallet: { address: WALLET, walletUriBase: "https://wallet.example" },
    setWallet: vi.fn(async () => {}),
    connection: null,
    setConnection: vi.fn(),
    navigate: vi.fn(),
    back: vi.fn(),
    sessionExpired: vi.fn(),
    signOut: vi.fn(),
    ...overrides,
  };
}

const flips: { current: (online: boolean) => void } = { current: () => {} };

function Shell(props: { app: AppContextValue; children: ReactNode }) {
  const [online, setOnline] = useState(props.app.online);
  flips.current = setOnline;
  return (
    <AppContext.Provider value={{ ...props.app, online }}>{props.children}</AppContext.Provider>
  );
}

/** Renders a screen inside the context; setOnline flips the network as NetInfo would. */
export async function renderScreen(ui: ReactNode, app: AppContextValue): Promise<Harness> {
  await act(async () => {
    render(<Shell app={app}>{ui}</Shell>);
  });
  return {
    app,
    setOnline: (online) => {
      act(() => flips.current(online));
    },
  };
}
