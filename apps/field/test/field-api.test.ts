import { describe, expect, it, vi } from "vitest";
import { type ApiClient, ApiShapeError, createApiClient, TIMEOUTS } from "../src/api/client";
import { fieldApi, parseBatches, parseLoadingIntents } from "../src/api/field";
import {
  addr,
  fieldBatch,
  KOPANO_ORG,
  lenderOneAccepted,
  lenderTwoMissing,
  loadingIntent,
  wireBatch,
  wireIntent,
} from "./custody-fixtures";

const roundTrip = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));
const without = (value: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

describe("parseBatches (field-app.md §6.3)", () => {
  it("accepts the demo batch: CR-0001, batch 1 of 1, 5,000,000 kg, at source", () => {
    const wire = roundTrip([fieldBatch()]);
    expect(parseBatches(wire)).toStrictEqual([
      expect.objectContaining({
        lotId: "CR-0001",
        index: 1,
        batchCount: 1,
        quantityKg: "5000000",
        stage: "AtSource",
        holderName: "Kopano Stockyard Custody",
        carrierName: "Mosela Haulage",
        destinationName: "Port Terminal T1",
        observationCount: 0,
        sequence: "0",
      }),
    ]);
  });

  it("returns the entries as sent", () => {
    const wire = [
      fieldBatch(),
      fieldBatch({ lotId: "CR-0002", index: 2, batchCount: 3, stage: "InTransit" }),
    ];
    expect(parseBatches(roundTrip(wire))).toStrictEqual(wire);
  });

  it("accepts an empty list", () => {
    expect(parseBatches([])).toStrictEqual([]);
  });

  it("accepts every stage", () => {
    for (const stage of ["AtSource", "InTransit", "Arrived"]) {
      expect(parseBatches([wireBatch({ stage })])[0]?.stage).toBe(stage);
    }
  });

  it("refuses an unknown key", () => {
    expect(() => parseBatches([wireBatch({ extra: "x" })])).toThrow();
  });

  it.each(Object.keys(fieldBatch()))("refuses an entry with %s missing", (key) => {
    expect(() => parseBatches([without(wireBatch(), key)])).toThrow();
  });

  it.each(["5e6", "05000000", "-1", "5000.5", "", "5,000"])(
    "refuses the quantity %j: it is a decimal string of whole kilograms",
    (quantityKg) => {
      expect(() => parseBatches([wireBatch({ quantityKg })])).toThrow();
    },
  );

  it("refuses a quantity that is a number, not a decimal string", () => {
    expect(() => parseBatches([wireBatch({ quantityKg: 5_000_000 })])).toThrow();
  });

  it("refuses a sequence that is not a decimal string", () => {
    expect(() => parseBatches([wireBatch({ sequence: "-1" })])).toThrow();
    expect(() => parseBatches([wireBatch({ sequence: 0 })])).toThrow();
  });

  it("refuses an unknown stage", () => {
    expect(() => parseBatches([wireBatch({ stage: "Delivered" })])).toThrow();
    expect(() => parseBatches([wireBatch({ stage: "atsource" })])).toThrow();
  });

  it("refuses index 0 and an index above the batch count", () => {
    expect(() => parseBatches([wireBatch({ index: 0 })])).toThrow();
    expect(() => parseBatches([wireBatch({ index: 2, batchCount: 1 })])).toThrow();
    expect(() => parseBatches([wireBatch({ batchCount: 0, index: 0 })])).toThrow();
  });

  it("accepts the last batch of a shipment", () => {
    expect(parseBatches([wireBatch({ index: 3, batchCount: 3 })])[0]?.index).toBe(3);
  });

  it("refuses an index that is not a safe integer", () => {
    expect(() => parseBatches([wireBatch({ index: 1.5, batchCount: 2 })])).toThrow();
    expect(() => parseBatches([wireBatch({ index: "1" })])).toThrow();
  });

  it("refuses a negative or fractional observation count", () => {
    expect(() => parseBatches([wireBatch({ observationCount: -1 })])).toThrow();
    expect(() => parseBatches([wireBatch({ observationCount: 0.5 })])).toThrow();
  });

  it.each(["batch", "shipment", "lot", "holder", "carrier", "destinationCustodian"])(
    "refuses a bad address in %s",
    (key) => {
      expect(() => parseBatches([wireBatch({ [key]: "not-an-address" })])).toThrow();
      expect(() => parseBatches([wireBatch({ [key]: "0OIl".repeat(9) })])).toThrow();
      expect(() => parseBatches([wireBatch({ [key]: addr(5).slice(0, 20) })])).toThrow();
    },
  );

  it("refuses a lot ID outside A-Z, 0-9 and hyphen, or over 16 characters", () => {
    expect(() => parseBatches([wireBatch({ lotId: "cr-0001" })])).toThrow();
    expect(() => parseBatches([wireBatch({ lotId: "A".repeat(17) })])).toThrow();
    expect(() => parseBatches([wireBatch({ lotId: "" })])).toThrow();
  });

  it.each(["holderName", "carrierName", "destinationName"])("refuses an empty %s", (key) => {
    expect(() => parseBatches([wireBatch({ [key]: "" })])).toThrow();
  });

  it("refuses a body that is not a list", () => {
    expect(() => parseBatches(wireBatch())).toThrow();
    expect(() => parseBatches(null)).toThrow();
  });

  it("refuses the whole list when one entry is bad", () => {
    expect(() => parseBatches([wireBatch(), wireBatch({ stage: "Lost" })])).toThrow();
  });
});

describe("parseLoadingIntents (field-app.md §6.3)", () => {
  it("accepts the demo intent: nonce 1, 3,000,000 kg, one lender accepted", () => {
    const [intent] = parseLoadingIntents(roundTrip([loadingIntent()]));
    expect(intent).toMatchObject({
      lotId: "CR-0001",
      quantityKg: "3000000",
      lockedKg: "3000000",
      ownerName: "Khunou Ore Exports",
      terminalName: "Port Terminal T1",
      documentSha256: "aa".repeat(32),
      nonce: "1",
    });
    expect(intent?.acceptances).toStrictEqual([
      expect.objectContaining({ lenderName: "Lender One Bank", state: "accepted" }),
    ]);
  });

  it("returns the entries as sent, acceptances in order", () => {
    const wire = [loadingIntent({ acceptances: [lenderOneAccepted, lenderTwoMissing] })];
    expect(parseLoadingIntents(roundTrip(wire))).toStrictEqual(wire);
  });

  it("accepts an intent with no acceptances and an empty list", () => {
    expect(parseLoadingIntents([wireIntent({ acceptances: [] })])[0]?.acceptances).toStrictEqual(
      [],
    );
    expect(parseLoadingIntents([])).toStrictEqual([]);
  });

  it("accepts every acceptance state", () => {
    for (const state of ["accepted", "missing", "stale"]) {
      const wire = wireIntent({ acceptances: [{ ...lenderOneAccepted, state }] });
      expect(parseLoadingIntents([wire])[0]?.acceptances[0]?.state).toBe(state);
    }
  });

  it("refuses an unknown key, on the intent and on an acceptance", () => {
    expect(() => parseLoadingIntents([wireIntent({ extra: 1 })])).toThrow();
    expect(() =>
      parseLoadingIntents([wireIntent({ acceptances: [{ ...lenderOneAccepted, extra: 1 }] })]),
    ).toThrow();
  });

  it.each(Object.keys(loadingIntent()))("refuses an intent with %s missing", (key) => {
    expect(() => parseLoadingIntents([without(wireIntent(), key)])).toThrow();
  });

  it.each(Object.keys(lenderOneAccepted))("refuses an acceptance with %s missing", (key) => {
    const acceptance = without({ ...lenderOneAccepted }, key);
    expect(() => parseLoadingIntents([wireIntent({ acceptances: [acceptance] })])).toThrow();
  });

  it.each(["quantityKg", "lockedKg", "nonce", "expiresAt"])(
    "refuses %s that is not a decimal string",
    (key) => {
      for (const bad of ["5e6", "05", "-1", "1.5", "", 7]) {
        expect(() => parseLoadingIntents([wireIntent({ [key]: bad })])).toThrow();
      }
    },
  );

  it("refuses a lock quantity that is not a decimal string", () => {
    expect(() =>
      parseLoadingIntents([wireIntent({ acceptances: [{ ...lenderOneAccepted, lockKg: "1e3" }] })]),
    ).toThrow();
  });

  it("refuses an unknown acceptance state", () => {
    expect(() =>
      parseLoadingIntents([
        wireIntent({ acceptances: [{ ...lenderOneAccepted, state: "revoked" }] }),
      ]),
    ).toThrow();
  });

  it("refuses a document digest that is not 64 lower-case hex characters", () => {
    expect(() => parseLoadingIntents([wireIntent({ documentSha256: "AA".repeat(32) })])).toThrow();
    expect(() => parseLoadingIntents([wireIntent({ documentSha256: "aa".repeat(31) })])).toThrow();
  });

  it.each(["intent", "lot", "owner"])("refuses a bad address in %s", (key) => {
    expect(() => parseLoadingIntents([wireIntent({ [key]: "not-an-address" })])).toThrow();
  });

  it("refuses a bad lender or loan address in an acceptance", () => {
    for (const key of ["lender", "loan"]) {
      expect(() =>
        parseLoadingIntents([
          wireIntent({ acceptances: [{ ...lenderOneAccepted, [key]: "not-an-address" }] }),
        ]),
      ).toThrow();
    }
  });

  it("refuses a lot ID outside the lot ID shape and an empty name", () => {
    expect(() => parseLoadingIntents([wireIntent({ lotId: "cr 0001" })])).toThrow();
    expect(() => parseLoadingIntents([wireIntent({ ownerName: "" })])).toThrow();
    expect(() => parseLoadingIntents([wireIntent({ terminalName: "" })])).toThrow();
    expect(() =>
      parseLoadingIntents([
        wireIntent({ acceptances: [{ ...lenderOneAccepted, lenderName: "" }] }),
      ]),
    ).toThrow();
  });

  it("refuses a body that is not a list", () => {
    expect(() => parseLoadingIntents({})).toThrow();
  });
});

describe("fieldApi", () => {
  function fakeClient(answer: unknown) {
    const request = vi.fn(async (..._args: unknown[]) => answer);
    return { client: { request } as unknown as ApiClient, request };
  }

  it("reads GET /v1/field/batches?organisationId=<id> with the 8 s field-read timeout", async () => {
    expect(TIMEOUTS.fieldRead).toBe(8_000);
    const { client, request } = fakeClient([fieldBatch()]);
    const batches = await fieldApi(client).batches(KOPANO_ORG);
    expect(batches).toStrictEqual([fieldBatch()]);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "GET",
      `/v1/field/batches?organisationId=${KOPANO_ORG}`,
      expect.objectContaining({ timeoutMs: 8_000, parse: expect.any(Function) }),
    );
    const options = request.mock.calls[0]?.[2] as { parse: (data: unknown) => unknown };
    expect(options.parse([fieldBatch()])).toStrictEqual([fieldBatch()]);
    expect(() => options.parse([{ ...fieldBatch(), stage: "Lost" }])).toThrow();
  });

  it("reads GET /v1/field/loading-intents?organisationId=<id> with the 8 s field-read timeout", async () => {
    const { client, request } = fakeClient([loadingIntent()]);
    const intents = await fieldApi(client).loadingIntents(KOPANO_ORG);
    expect(intents).toStrictEqual([loadingIntent()]);
    expect(request).toHaveBeenCalledWith(
      "GET",
      `/v1/field/loading-intents?organisationId=${KOPANO_ORG}`,
      expect.objectContaining({ timeoutMs: 8_000, parse: expect.any(Function) }),
    );
    const options = request.mock.calls[0]?.[2] as { parse: (data: unknown) => unknown };
    expect(options.parse([loadingIntent()])).toStrictEqual([loadingIntent()]);
    expect(() => options.parse([{ ...loadingIntent(), extra: 1 }])).toThrow();
  });

  it("encodes the organisation id into the query", async () => {
    const { client, request } = fakeClient([]);
    await fieldApi(client).batches("a b&c=d/é");
    await fieldApi(client).loadingIntents("a b&c=d/é");
    const encoded = encodeURIComponent("a b&c=d/é");
    expect(encoded).toBe("a%20b%26c%3Dd%2F%C3%A9");
    expect(request.mock.calls.map((call) => call[1])).toStrictEqual([
      `/v1/field/batches?organisationId=${encoded}`,
      `/v1/field/loading-intents?organisationId=${encoded}`,
    ]);
  });

  it("a body the parser refuses is an ApiShapeError through the real client", async () => {
    const answer = (data: unknown) =>
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetch = vi.fn(async () => answer([{ ...fieldBatch(), stage: "Lost" }]));
    const api = fieldApi(
      createApiClient({ baseUrl: "http://h", getToken: async () => "t", fetch }),
    );
    await expect(api.batches(KOPANO_ORG)).rejects.toBeInstanceOf(ApiShapeError);
    const [url] = fetch.mock.calls[0] as unknown as [string];
    expect(url).toBe(`http://h/v1/field/batches?organisationId=${KOPANO_ORG}`);

    const intents = vi.fn(async () => answer([{ ...loadingIntent(), extra: true }]));
    const intentsApi = fieldApi(
      createApiClient({ baseUrl: "http://h", getToken: async () => "t", fetch: intents }),
    );
    await expect(intentsApi.loadingIntents(KOPANO_ORG)).rejects.toBeInstanceOf(ApiShapeError);
  });

  it("a well-formed body comes through the real client as parsed entries", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [fieldBatch()] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const api = fieldApi(
      createApiClient({ baseUrl: "http://h", getToken: async () => "t", fetch }),
    );
    expect(await api.batches(KOPANO_ORG)).toStrictEqual([fieldBatch()]);
  });
});
