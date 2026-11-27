import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  ReadError,
  readOpenLoadingCommand,
  readOrganisationAt,
  readWaiting,
} from "../src/data/reads";
import {
  HANDOVER_ID,
  INTENT_ADDRESS,
  KHUNOU_ORG,
  KOPANO_ORG,
  LOADING_ID,
  MOSELA_ORG,
  PORT_ORG,
} from "./custody-fixtures";
import { PROTOCOL } from "./fixtures";

vi.mock("../src/supabase", () => ({ SupabaseTimeout: class extends Error {} }));

type Call = [string, ...unknown[]];

/**
 * A Supabase client whose query builder records each call and, awaited at any point of the chain,
 * answers `{ data, error }`. The real builder is thenable the same way.
 */
function fakeDb(answer: { data: unknown; error?: { message: string } | null }) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "eq", "in", "is", "order", "limit", "maybeSingle"]) {
    builder[name] = (...args: unknown[]) => {
      calls.push([name, ...args]);
      return builder;
    };
  }
  // biome-ignore lint/suspicious/noThenProperty: the real query builder is awaited the same way
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve({ data: answer.data, error: answer.error ?? null }).then(resolve, reject);
  const db = {
    from: (table: string) => {
      calls.push(["from", table]);
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

const callsNamed = (calls: Call[], name: string) => calls.filter((call) => call[0] === name);

const fieldsOf = (...pairs: [string, string][]) =>
  pairs.map(([label, value]) => ({ label, value }));

const HANDOVER_FIELDS = fieldsOf(
  ["Lot", "CR-0001"],
  ["Batch", "1 of 1"],
  ["From", "Kopano Stockyard Custody"],
  ["To", "Mosela Haulage"],
  ["Stage", "Departure"],
);

function handoverRow(over: Record<string, unknown> = {}) {
  return {
    id: HANDOVER_ID,
    kind: "handover",
    intent: null,
    fields: HANDOVER_FIELDS,
    signers: [
      { role: "holder", organisationId: KOPANO_ORG, method: "text" },
      { role: "next_holder", organisationId: MOSELA_ORG, method: "text" },
    ],
    signatures: [],
    created_at: "2026-11-28T10:00:05.000Z",
    ...over,
  };
}

function loadingRow(over: Record<string, unknown> = {}) {
  return {
    id: LOADING_ID,
    kind: "record_loading",
    intent: INTENT_ADDRESS,
    fields: fieldsOf(["Lot", "CR-0001"], ["Owner", "Khunou Ore Exports"]),
    signers: [
      { role: "owner", organisationId: KHUNOU_ORG, method: "text" },
      { role: "terminal", organisationId: PORT_ORG, method: "text" },
    ],
    signatures: [{ role: "owner", wallet: "x" }],
    created_at: "2026-11-28T09:30:00.000Z",
    ...over,
  };
}

describe("readWaiting (field-app.md §6.5 Waiting for you)", () => {
  it("asks for this instance's open handovers and loadings, newest first", async () => {
    const { db, calls } = fakeDb({ data: [] });
    expect(await readWaiting(db, PROTOCOL, MOSELA_ORG)).toStrictEqual([]);
    expect(calls).toContainEqual(["from", "commands"]);
    expect(callsNamed(calls, "select")).toStrictEqual([
      ["select", "id, kind, intent, fields, signers, signatures, created_at"],
    ]);
    expect(calls).toContainEqual(["eq", "protocol", PROTOCOL]);
    expect(calls).toContainEqual(["eq", "status", "awaiting_signatures"]);
    expect(calls).toContainEqual(["in", "kind", ["handover", "record_loading"]]);
    const orders = callsNamed(calls, "order");
    expect(orders).toHaveLength(1);
    expect(orders[0]?.[1]).toBe("created_at");
    const options = orders[0]?.[2] as { ascending: boolean } | undefined;
    expect(options?.ascending).toBe(false);
  });

  it("keeps a handover where this organisation's signer has not signed, with its role", async () => {
    const { db } = fakeDb({ data: [handoverRow()] });
    expect(await readWaiting(db, PROTOCOL, MOSELA_ORG)).toStrictEqual([
      {
        id: HANDOVER_ID,
        kind: "handover",
        intent: null,
        createdAt: "2026-11-28T10:00:05.000Z",
        fields: HANDOVER_FIELDS,
        role: "next_holder",
      },
    ]);
  });

  it("keeps the holder's own handover too, as role holder", async () => {
    const { db } = fakeDb({ data: [handoverRow()] });
    const [row] = await readWaiting(db, PROTOCOL, KOPANO_ORG);
    expect(row?.role).toBe("holder");
  });

  it("drops a handover where this organisation's signer has already signed", async () => {
    const signed = handoverRow({ signatures: [{ role: "next_holder", wallet: "x" }] });
    const { db } = fakeDb({ data: [signed] });
    expect(await readWaiting(db, PROTOCOL, MOSELA_ORG)).toStrictEqual([]);
  });

  it("keeps it for the other signer when only the next holder has signed", async () => {
    const row = handoverRow({ signatures: [{ role: "next_holder", wallet: "x" }] });
    const { db } = fakeDb({ data: [row] });
    expect((await readWaiting(db, PROTOCOL, KOPANO_ORG)).map((r) => r.role)).toStrictEqual([
      "holder",
    ]);
  });

  it("drops a handover where this organisation is not a signer", async () => {
    const { db } = fakeDb({ data: [handoverRow()] });
    expect(await readWaiting(db, PROTOCOL, PORT_ORG)).toStrictEqual([]);
  });

  it("keeps a record_loading for the terminal with its intent, and drops it once the terminal signed", async () => {
    const open = fakeDb({ data: [loadingRow()] });
    expect(await readWaiting(open.db, PROTOCOL, PORT_ORG)).toStrictEqual([
      {
        id: LOADING_ID,
        kind: "record_loading",
        intent: INTENT_ADDRESS,
        createdAt: "2026-11-28T09:30:00.000Z",
        fields: fieldsOf(["Lot", "CR-0001"], ["Owner", "Khunou Ore Exports"]),
        role: "terminal",
      },
    ]);
    const signed = fakeDb({
      data: [loadingRow({ signatures: [{ role: "owner" }, { role: "terminal" }] })],
    });
    expect(await readWaiting(signed.db, PROTOCOL, PORT_ORG)).toStrictEqual([]);
  });

  it("keeps the order the rows came in, and filters each row alone", async () => {
    const rows = [
      loadingRow(),
      handoverRow({
        id: "11111111-2222-4333-8444-555555555555",
        signatures: [{ role: "next_holder" }],
      }),
      handoverRow(),
    ];
    const { db } = fakeDb({ data: rows });
    const kept = await readWaiting(db, PROTOCOL, MOSELA_ORG);
    expect(kept.map((r) => r.id)).toStrictEqual([HANDOVER_ID]);
    const all = fakeDb({ data: rows });
    expect((await readWaiting(all.db, PROTOCOL, PORT_ORG)).map((r) => r.id)).toStrictEqual([
      LOADING_ID,
    ]);
  });

  it("skips a row whose jsonb is not the expected shape, and still returns the others", async () => {
    const rows = [
      handoverRow({ signers: "oops" }),
      handoverRow({ signatures: null }),
      handoverRow({ signers: [null, 7] }),
      handoverRow({ fields: [{ label: "Lot" }] }),
      handoverRow({ fields: "none" }),
      handoverRow(),
    ];
    const { db } = fakeDb({ data: rows });
    const kept = await readWaiting(db, PROTOCOL, MOSELA_ORG);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.fields).toStrictEqual(HANDOVER_FIELDS);
  });

  it("a read that fails is a ReadError", async () => {
    const { db } = fakeDb({ data: null, error: { message: "permission denied" } });
    await expect(readWaiting(db, PROTOCOL, MOSELA_ORG)).rejects.toBeInstanceOf(ReadError);
  });
});

describe("readOpenLoadingCommand (owner decision: link to the open text, never prepare a second)", () => {
  it("is the first open record_loading for the intent: the oldest, ties by id", async () => {
    const { db, calls } = fakeDb({ data: [{ id: LOADING_ID }] });
    expect(await readOpenLoadingCommand(db, PROTOCOL, INTENT_ADDRESS)).toBe(LOADING_ID);
    expect(calls).toContainEqual(["from", "commands"]);
    expect(callsNamed(calls, "select")).toStrictEqual([["select", "id"]]);
    expect(calls).toContainEqual(["eq", "protocol", PROTOCOL]);
    expect(calls).toContainEqual(["eq", "kind", "record_loading"]);
    expect(calls).toContainEqual(["eq", "intent", INTENT_ADDRESS]);
    expect(calls).toContainEqual([
      "in",
      "status",
      ["awaiting_signatures", "submitted", "outcome_unknown"],
    ]);
    expect(calls).toContainEqual(["limit", 1]);
    const orders = callsNamed(calls, "order");
    expect(orders.map((call) => call[1])).toStrictEqual(["created_at", "id"]);
    for (const order of orders) {
      expect((order[2] as { ascending?: boolean } | undefined)?.ascending ?? true).toBe(true);
    }
  });

  it("is null when there is no open text", async () => {
    const { db } = fakeDb({ data: [] });
    expect(await readOpenLoadingCommand(db, PROTOCOL, INTENT_ADDRESS)).toBeNull();
  });

  it("a read that fails is a ReadError, not null: the screen must not prepare a second text", async () => {
    const { db } = fakeDb({ data: null, error: { message: "did not answer" } });
    await expect(readOpenLoadingCommand(db, PROTOCOL, INTENT_ADDRESS)).rejects.toBeInstanceOf(
      ReadError,
    );
  });
});

describe("readOrganisationAt", () => {
  it("maps org_id and display_name of the organisation at a chain address", async () => {
    const { db, calls } = fakeDb({ data: { org_id: MOSELA_ORG, display_name: "Mosela Haulage" } });
    expect(await readOrganisationAt(db, PROTOCOL, "SomeChainAddress")).toStrictEqual({
      orgId: MOSELA_ORG,
      displayName: "Mosela Haulage",
    });
    expect(calls).toContainEqual(["from", "chain_organisations"]);
    expect(callsNamed(calls, "select")).toStrictEqual([["select", "org_id, display_name"]]);
    expect(calls).toContainEqual(["eq", "protocol", PROTOCOL]);
    expect(calls).toContainEqual(["eq", "address", "SomeChainAddress"]);
    expect(callsNamed(calls, "maybeSingle")).toHaveLength(1);
  });

  it("is null when no organisation is at that address", async () => {
    const { db } = fakeDb({ data: null });
    expect(await readOrganisationAt(db, PROTOCOL, "SomeChainAddress")).toBeNull();
  });
});
