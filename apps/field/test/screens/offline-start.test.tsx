// @vitest-environment jsdom
import type { Session } from "@supabase/supabase-js";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftStore } from "../../src/drafts/store";
import { createOfflineCache } from "../../src/offline-cache";
import { SignedIn } from "../../src/SignedIn";
import { completeDraft, fakeApp, membership, protocolContext, USER } from "./app";

const stores = vi.hoisted(() => {
  const make = () => {
    const values = new Map<string, string>();
    return {
      values,
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => void values.set(key, value),
      removeItem: async (key: string) => void values.delete(key),
    };
  };
  return { drafts: make(), secure: make() };
});

vi.mock("react-native", async () => (await import("./native")).reactNative);
vi.mock("react-native-safe-area-context", async () => (await import("./native")).safeArea);
vi.mock("@solana-mobile/mobile-wallet-adapter-protocol", () => ({ transact: vi.fn() }));
vi.mock("expo-crypto", async () => ({ randomUUID: (await import("node:crypto")).randomUUID }));
vi.mock("expo-image-picker", () => ({}));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-file-system", () => ({ File: class {}, Directory: class {}, Paths: {} }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: stores.drafts }));
vi.mock("../../src/supabase", () => ({
  sessionStorage: stores.secure,
  SupabaseTimeout: class extends Error {},
}));
vi.mock("../../src/data/reads", async (importOriginal) => {
  const offline = async () => {
    throw new TypeError("Network request failed");
  };
  return {
    ...(await importOriginal<typeof import("../../src/data/reads")>()),
    readMemberships: vi.fn(offline),
    readProtocol: vi.fn(offline),
    readChainOrganisation: vi.fn(offline),
    readSignerLinks: vi.fn(offline),
    readAuthority: vi.fn(offline),
    readSites: vi.fn(offline),
    readLotsAtSites: vi.fn(offline),
  };
});

const AT = "2026-11-27T08:04:00.000Z";
const session = { user: { id: USER, email: "custodian@example.test" } } as unknown as Session;
const config = fakeApp().config;

function start() {
  render(
    <SignedIn
      config={config}
      db={{ auth: { getSession: async () => ({ data: { session } }) } } as never}
      session={session}
      online={false}
      sessionExpired={() => {}}
      signOut={() => {}}
    />,
  );
}

beforeEach(() => {
  stores.drafts.values.clear();
  stores.secure.values.clear();
});
afterEach(cleanup);

describe("cold start with no network (F3, A24)", () => {
  it("opens Home in offline mode from the cache and lists the drafts", async () => {
    await createDraftStore(stores.drafts).save(completeDraft());
    const cache = createOfflineCache(stores.secure);
    await cache.setMemberships(USER, [membership], AT);
    await cache.setProtocol(USER, protocolContext, AT);
    await cache.setSigning(
      USER,
      membership.organisationId,
      {
        wallet: null,
        chainOrganisation: {
          address: "3vZ67CubkWnFyUhyJ7PNbbZyXDVGQqS7j7qsc8rTDZ7G",
          role: "Custodian",
          displayName: "Kopano Stockyard Custody",
        },
        link: null,
        linkOtherOrgId: null,
        authorityRow: null,
      },
      AT,
    );
    start();
    await screen.findByText("Drafts on this phone");
    await screen.findByText("CR-0001");
    await screen.findByText("As of 10:04 SAST, offline");
    expect(screen.getByText("Custodian")).toBeTruthy();
  });

  it("without a cache says what it can't open, and promises no drafts", async () => {
    await createDraftStore(stores.drafts).save(completeDraft());
    start();
    await screen.findByText(/This phone has not loaded them before, so drafts open once it has/);
    expect(screen.queryByText("Drafts on this phone")).toBeNull();
    expect(screen.queryByText(/Your drafts are still on this phone/)).toBeNull();
  });
});
