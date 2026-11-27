import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ApiShapeError,
  ApiTimeout,
  ApiUnreachable,
  createApiClient,
} from "../src/api/client";
import { type CommandStatus, commandsApi, parseCommandView } from "../src/api/commands";
import { REFETCH_CODES, relayErrorCopy } from "../src/copy";
import { commandView } from "./fixtures";

const STATUSES: CommandStatus[] = [
  "awaiting_signatures",
  "submitted",
  "confirmed",
  "failed",
  "outcome_unknown",
  "expired",
];

describe("parseCommandView", () => {
  it.each(STATUSES)("parses a %s view", (status) => {
    const view = commandView(status);
    expect(parseCommandView(JSON.parse(JSON.stringify(view)))).toStrictEqual(view);
  });

  it("refuses an unknown field", () => {
    expect(() => parseCommandView({ ...commandView("submitted"), extra: 1 })).toThrow();
  });

  it("refuses an unknown field inside text", () => {
    const view = commandView("awaiting_signatures");
    expect(() => parseCommandView({ ...view, text: { ...view.text, more: "x" } })).toThrow();
  });

  it("refuses a bad digest", () => {
    const view = commandView("awaiting_signatures");
    if (!view.text) throw new Error("fixture");
    expect(() =>
      parseCommandView({ ...view, text: { ...view.text, messageSha256: "FB1D".repeat(16) } }),
    ).toThrow();
  });

  it("refuses a non-decimal integer", () => {
    expect(() => parseCommandView({ ...commandView("confirmed"), confirmedSlot: "5e8" })).toThrow();
    expect(() =>
      parseCommandView({ ...commandView("confirmed"), confirmedSlot: "0526890114" }),
    ).toThrow();
    const view = commandView("awaiting_signatures");
    if (!view.text) throw new Error("fixture");
    expect(() => parseCommandView({ ...view, text: { ...view.text, validUntil: "-1" } })).toThrow();
  });

  it("refuses an unknown status, kind or role", () => {
    expect(() => parseCommandView({ ...commandView("submitted"), status: "done" })).toThrow();
    expect(() => parseCommandView({ ...commandView("submitted"), kind: "mint" })).toThrow();
    const view = commandView("submitted");
    expect(() =>
      parseCommandView({ ...view, signers: [{ ...view.signers[0], role: "driver" }] }),
    ).toThrow();
  });

  it("accepts the relay core's lender kinds too", () => {
    expect(parseCommandView({ ...commandView("submitted"), kind: "pledge" }).kind).toBe("pledge");
  });
});

describe("no confirmed or failed state without the chain's facts (F5)", () => {
  it("refuses confirmed with no transaction", () => {
    expect(() => parseCommandView({ ...commandView("confirmed"), transaction: null })).toThrow(
      /transaction/,
    );
  });

  it("refuses confirmed with no commitment", () => {
    expect(() =>
      parseCommandView({ ...commandView("confirmed"), confirmedCommitment: null }),
    ).toThrow(/confirmedCommitment/);
  });

  it("refuses finalized with no transaction", () => {
    expect(() =>
      parseCommandView({
        ...commandView("confirmed"),
        confirmedCommitment: "finalized",
        transaction: null,
      }),
    ).toThrow(/transaction/);
  });

  it("refuses an issue_lot outcome that is not LotIssued", () => {
    const view = commandView("confirmed");
    if (!view.outcome) throw new Error("fixture");
    expect(() =>
      parseCommandView({ ...view, outcome: { ...view.outcome, event: "LotRedeemed" } }),
    ).toThrow(/outcome/);
  });

  it("accepts a confirmed issue with the outcome still unread (OUTCOME_UNREADABLE)", () => {
    const view = commandView("confirmed", { outcome: null });
    expect(parseCommandView(view)).toStrictEqual(view);
  });

  it("refuses failed with no error", () => {
    expect(() => parseCommandView({ ...commandView("failed"), error: null })).toThrow(/error/);
  });
});

describe("relay error copy (field-app.md §6.7)", () => {
  const vars = {
    org: "Kopano Stockyard Custody",
    detail: "scope",
    signBefore: "10:14:05 SAST",
    siteCode: "KOPANO-YARD-1",
    classLabel: "CHROME v1",
    ownerName: "Khunou Ore Exports",
  };

  it.each([
    [
      "WALLET_NOT_LINKED",
      "create",
      "This wallet is not linked to you for Kopano Stockyard Custody. Link it on the Wallet screen.",
    ],
    [
      "AUTHORITY_INVALID",
      "signatures",
      "Thetis did not send this: this wallet has no current authority for Kopano Stockyard Custody that allows this action (scope).",
    ],
    [
      "BAD_SIGNATURE",
      "signatures",
      "Your wallet's signature does not match the exact text. Nothing was sent. Try another wallet and report the wallet name.",
    ],
    ["TEXT_EXPIRED", "signatures", "This text expired at 10:14:05 SAST. Nothing was sent."],
    ["ROLE_INVALID", "signatures", "This phone's organisation is not a signer of this command."],
    [
      "EVIDENCE_INVALID",
      "create",
      "One of the files is not stored for this record. Upload it again.",
    ],
    [
      "CHAIN_UNAVAILABLE",
      "create",
      "Thetis can't reach devnet right now. Nothing was sent. Try again.",
    ],
    [
      "SPONSOR_UNAVAILABLE",
      "signatures",
      "The fee sponsor did not answer. Nothing was sent. Try again.",
    ],
    [
      "COMMANDS_UNAVAILABLE",
      "create",
      "Signing is not available on this Thetis server right now (COMMANDS_UNAVAILABLE). Nothing was sent.",
    ],
    [
      "LOOKUP_TABLE_FULL",
      "signatures",
      "Signing is not available on this Thetis server right now (LOOKUP_TABLE_FULL). Nothing was sent.",
    ],
    ["NOT_FOUND", "get", "Thetis can't find this command, or it is not one of yours."],
    [
      "TOO_MANY_OPEN_COMMANDS",
      "create",
      "You have five texts open that nobody finished. Finish one or wait for it to expire, then try again. Nothing was sent.",
    ],
    [
      "INTERNAL",
      "create",
      "Thetis could not prepare this text (INTERNAL). Nothing was sent. Try again.",
    ],
    [
      "VALIDATION",
      "renew",
      "Thetis could not prepare this text (VALIDATION). Nothing was sent. Try again.",
    ],
    [
      "INTERNAL",
      "signatures",
      "Thetis could not take your signature (INTERNAL). Nothing was sent. Try again.",
    ],
    ["INTERNAL", "get", "Thetis could not read this command's status (INTERNAL). Nothing changed."],
  ] as const)("%s on %s", (code, phase, text) => {
    expect(relayErrorCopy(code, phase, vars)).toBe(text);
  });

  it.each([
    [
      "custodianClass: 4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
      "Site KOPANO-YARD-1 is not set up on this Thetis instance. Nothing was sent.",
    ],
    ["classPolicy: x", "Class CHROME v1 is not set up on this Thetis instance. Nothing was sent."],
    ["ownerOrg: x", "Khunou Ore Exports is not set up on this Thetis instance. Nothing was sent."],
    [
      "custodianOrg: x",
      "Kopano Stockyard Custody is not set up on this Thetis instance. Nothing was sent.",
    ],
    [
      "origin: none valid",
      "An origin attestation for this intake is not set up on this Thetis instance. Nothing was sent.",
    ],
    ["mint: abc", "mint: abc is not set up on this Thetis instance. Nothing was sent."],
  ])("ACCOUNT_MISSING %s", (detail, text) => {
    expect(relayErrorCopy("ACCOUNT_MISSING", "create", { ...vars, detail })).toBe(text);
  });

  it("COMMAND_STATE, ALREADY_SIGNED and STALE_TEXT have no copy: they re-fetch", () => {
    for (const code of ["COMMAND_STATE", "ALREADY_SIGNED", "STALE_TEXT"]) {
      expect(REFETCH_CODES.has(code)).toBe(true);
      expect(relayErrorCopy(code, "signatures", vars)).toBeNull();
    }
    expect(relayErrorCopy("NOT_AUTHENTICATED", "get", vars)).toBeNull();
  });
});

describe("the client", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends the bearer token and parses the view", async () => {
    const fetch = vi.fn(async () => json(201, { data: commandView("awaiting_signatures") }));
    const api = commandsApi(
      createApiClient({ baseUrl: "http://127.0.0.1:3200", getToken: async () => "tok", fetch }),
    );
    const view = await api.create({ kind: "issue_lot", organisationId: "o", args: {} });
    expect(view.status).toBe("awaiting_signatures");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3200/v1/commands");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
  });

  it("maps the error envelope, keeping the detail", async () => {
    const fetch = vi.fn(async () =>
      json(409, { error: { code: "ACCOUNT_MISSING", message: "m", detail: "custodianClass: x" } }),
    );
    const api = commandsApi(
      createApiClient({ baseUrl: "http://h", getToken: async () => "t", fetch }),
    );
    const error = await api.get("6a1f0c3e-8b2d-4e5f-9a7b-1c2d3e4f5a6b").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "ACCOUNT_MISSING",
      detail: "custodianClass: x",
    });
  });

  it("times out at the route's limit", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const api = commandsApi(
      createApiClient({ baseUrl: "http://h", getToken: async () => "t", fetch }),
    );
    const pending = api
      .create({ kind: "issue_lot", organisationId: "o", args: {} })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2);
    expect(await pending).toBeInstanceOf(ApiTimeout);
    vi.useRealTimers();
  });

  it("a network failure is ApiUnreachable", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Network request failed");
    });
    const api = commandsApi(
      createApiClient({ baseUrl: "http://h", getToken: async () => "t", fetch }),
    );
    await expect(api.renew("6a1f0c3e-8b2d-4e5f-9a7b-1c2d3e4f5a6b")).rejects.toBeInstanceOf(
      ApiUnreachable,
    );
  });

  it("refuses a 2xx body that is not a command view", async () => {
    const fetch = vi.fn(async () =>
      json(200, { data: { ...commandView("submitted"), extra: true } }),
    );
    const api = commandsApi(
      createApiClient({ baseUrl: "http://h", getToken: async () => "t", fetch }),
    );
    await expect(api.get("6a1f0c3e-8b2d-4e5f-9a7b-1c2d3e4f5a6b")).rejects.toThrow();
  });

  it("a view that fails the parser is ApiShapeError, never a plain error (F6)", async () => {
    const fetch = vi.fn(async () =>
      json(200, { data: { ...commandView("submitted"), status: "landed" } }),
    );
    const api = commandsApi(
      createApiClient({ baseUrl: "http://h", getToken: async () => "t", fetch }),
    );
    await expect(api.get("6a1f0c3e-8b2d-4e5f-9a7b-1c2d3e4f5a6b")).rejects.toBeInstanceOf(
      ApiShapeError,
    );
  });
});
