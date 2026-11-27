import { describe, expect, it } from "vitest";
import { createOfflineCache } from "../src/offline-cache";
import { PROTOCOL } from "./fixtures";

function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => void values.set(key, value),
    removeItem: async (key: string) => void values.delete(key),
  };
}

const USER = "fa57ea5f-9cf6-43fc-82b1-592d505bc3d7";
const ORG = "0b9f4d2e-3c1a-4f6e-9d8b-7a6c5e4d3b2a";
const AT = "2026-11-27T08:04:00.000Z";
const membership = {
  organisationId: ORG,
  memberRole: "member",
  name: "Kopano Stockyard Custody",
  slug: "kopano-stockyard-custody",
  kind: "custodian",
  synthetic: true,
};
const protocol = {
  protocol: PROTOCOL,
  instanceIdHex: "666961742d64656d6f2d72756e2d3031",
  instanceLabel: "fiat-demo-run-01",
  settlementMode: "fiat",
  indexStatus: "running",
  lastSuccessAt: AT,
};

describe("the offline cache (F3)", () => {
  it("keeps memberships, the instance and the signing facts per user, with the time read", async () => {
    const cache = createOfflineCache(memory());
    await cache.setMemberships(USER, [membership], AT);
    await cache.setProtocol(USER, protocol, AT);
    const facts = {
      wallet: "G7sTxBJ1geeqZF7T3JuPX4bEqhQzyBLYPKAye11RXLrp",
      chainOrganisation: { address: PROTOCOL, role: "Custodian", displayName: "Kopano" },
      link: "linked" as const,
      linkOtherOrgId: null,
      authorityRow: null,
    };
    await cache.setSigning(USER, ORG, facts, AT);
    expect(await cache.memberships(USER)).toStrictEqual({ value: [membership], savedAt: AT });
    expect(await cache.protocol(USER)).toStrictEqual({ value: protocol, savedAt: AT });
    expect(await cache.signing(USER, ORG)).toStrictEqual({ value: facts, savedAt: AT });
    expect(await cache.memberships("someone-else")).toBeNull();
    expect(await cache.signing(USER, "another-org")).toBeNull();
  });

  it("reads a damaged entry as no cache", async () => {
    const storage = memory();
    const cache = createOfflineCache(storage);
    await cache.setMemberships(USER, [membership], AT);
    for (const key of storage.values.keys()) storage.values.set(key, "{not json");
    expect(await cache.memberships(USER)).toBeNull();
  });
});
