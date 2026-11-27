import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  checkpoint,
  fakeSupabase,
  issuedSnapshot,
  membership,
  PROGRAM_ID,
  PROTOCOL,
} from "./snapshot";

const server = vi.hoisted(() => ({ client: null as unknown, calls: 0 }));
vi.mock("@/lib/supabase-server", () => ({
  supabaseServer: async () => {
    server.calls += 1;
    return server.client;
  },
}));

// The rail's account block reads the browser session: no session here, and no browser client.
vi.mock("@/lib/supabase-browser", () => ({
  supabaseBrowser: () => ({
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  }),
}));

const { default: Home } = await import("@/app/page");
const { default: ContextLayout } = await import("@/app/[context]/layout");
const { default: QueuePage } = await import("@/app/[context]/queue/page");
const { default: ExceptionsPage } = await import("@/app/[context]/exceptions/page");
const { default: LotPage } = await import("@/app/[context]/lots/[lotId]/page");
const { default: ReleasePage } = await import("@/app/[context]/releases/[releaseId]/page");

const failureBanner = "Thetis could not read the indexed registry. Nothing here is current.";
const liveBannerText =
  "Devnet test environment. Synthetic organisations. Records are read from the Thetis program on Solana devnet.";

function liveEnvironment() {
  vi.stubEnv("THETIS_DATA_SOURCE", "live");
  vi.stubEnv("THETIS_NETWORK", "devnet");
  vi.stubEnv("THETIS_PROGRAM_ID", PROGRAM_ID);
  vi.stubEnv("THETIS_PROTOCOL", PROTOCOL);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
}

function freshSnapshot(members: Parameters<typeof issuedSnapshot>[0] = ["khunou"]) {
  const snapshot = issuedSnapshot(members);
  snapshot.checkpoint = checkpoint({ last_success_at: new Date().toISOString() });
  return snapshot;
}

const queue = (context = "khunou", filter?: string) =>
  QueuePage({
    params: Promise.resolve({ context }),
    searchParams: Promise.resolve(filter === undefined ? {} : { filter }),
  });
const exceptions = (context = "khunou") => ExceptionsPage({ params: Promise.resolve({ context }) });
const dossier = (context = "khunou", lotId = "CR-0001", tab?: string) =>
  LotPage({
    params: Promise.resolve({ context, lotId }),
    searchParams: Promise.resolve(tab === undefined ? {} : { tab }),
  });
const release = () =>
  ReleasePage({
    params: Promise.resolve({ context: "lender-one", releaseId: "rel-0001" }),
    searchParams: Promise.resolve({}),
  });
const pages: [string, () => Promise<ReactNode>][] = [
  ["queue", () => queue()],
  ["exceptions", () => exceptions()],
  ["dossier", () => dossier()],
  ["home", () => Home()],
];

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
beforeEach(() => {
  server.client = null;
  server.calls = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function expectFailure(container: HTMLElement, message: string) {
  expect(container.querySelector(".reference-banner")?.textContent).toBe(failureBanner);
  expect(
    screen.getByRole("heading", { level: 1, name: "The registry could not be read" }),
  ).toBeInTheDocument();
  expect(screen.getByText(message)).toBeInTheDocument();
  expect(container.querySelector("main.workspace-main")).not.toBeNull();
  expect(container.querySelector(".side-rail")).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Workspace" })).not.toBeInTheDocument();
  expect(screen.queryByText(liveBannerText)).not.toBeInTheDocument();
}

describe("routes", () => {
  test("reference mode still renders the fixture banner and the CR-0001 scenario", async () => {
    vi.stubEnv("THETIS_DATA_SOURCE", undefined);
    const params = Promise.resolve({ context: "lender-one" });
    const { container } = render(
      await ContextLayout({ params, children: await dossier("lender-one", "CR-0001") }),
    );
    expect(container.querySelector(".reference-banner")?.textContent).toBe(
      "Design reference. Synthetic parties and amounts. Nothing on this page is recorded on chain.",
    );
    expect(
      screen.getByRole("heading", { name: "CR-0001 Chrome ore, single grade class" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Loan to value 60\.00%/ })).toBeInTheDocument();
    expect(container.querySelector(".side-rail")).toHaveTextContent("Lender One Bank");
    cleanup();

    render(await ContextLayout({ params, children: await queue("lender-one") }));
    expect(screen.getByText("Facility currency USD")).toBeInTheDocument();
    expect(screen.getByText("Review payment evidence")).toBeInTheDocument();
    cleanup();

    render(await release());
    expect(
      screen.getByRole("heading", { name: "Release 2,000.000 t to Buyer Smelter Co" }),
    ).toBeInTheDocument();
    await expect(Home()).rejects.toMatchObject({
      digest: expect.stringContaining(";/lender-one/queue;"),
    });
    expect(server.calls).toBe(0);
  });

  test("on READ_FAILED and NOT_SYNTHETIC the page shows the failure banner and LiveReadFailed without the rail", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    liveEnvironment();
    const fake = fakeSupabase(freshSnapshot());
    server.client = fake.client;
    fake.getUser = async () => ({
      data: { user: null },
      error: { name: "AuthUnknownError", status: 500 },
    });
    for (const [name, page] of pages) {
      const { container } = render(await page());
      expectFailure(
        container,
        "Reload the page to try again. Nothing on chain changed because of this.",
      );
      cleanup();
      expect(logged, name).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: "READ_FAILED", path: "auth.getUser" }),
      );
    }

    fake.getUser = async () => ({
      data: { user: { id: "21000000-0000-4000-8000-000000000001" } },
      error: null,
    });
    fake.tables.organisations = [{ ...membership("khunou"), synthetic: false }];
    for (const [, page] of pages) {
      const { container } = render(await page());
      expectFailure(
        container,
        "This workspace includes an organisation that is not marked synthetic, so it is not shown in the test environment.",
      );
      cleanup();
    }
    expect(logged).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "NOT_SYNTHETIC", path: "memberships[0].synthetic" }),
    );

    // An invalid source is CONFIG on every page, the release route included, and the layout adds nothing.
    vi.stubEnv("THETIS_DATA_SOURCE", "staging");
    for (const [, page] of [...pages, ["release", release] as const]) {
      const { container } = render(await page());
      expectFailure(
        container,
        "Reload the page to try again. Nothing on chain changed because of this.",
      );
      cleanup();
    }
    const layout = render(
      await ContextLayout({
        params: Promise.resolve({ context: "khunou" }),
        children: <p>Page body</p>,
      }),
    );
    expect(layout.container.innerHTML).toBe("<p>Page body</p>");
    expect(logged).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "CONFIG", path: "THETIS_DATA_SOURCE" }),
    );
  });

  test("each live page renders its banner and rail from its own read", async () => {
    liveEnvironment();
    const fake = fakeSupabase(freshSnapshot());
    server.client = fake.client;
    const reads = () => fake.calls.filter(({ table }) => table === "organisations").length;
    const rail = () => {
      const root = document.querySelector<HTMLElement>(".side-rail");
      if (!root) throw new Error("no rail on the page");
      return within(root);
    };
    const currentLine =
      /^Live from devnet\. Indexed through slot 12,000, last reported \d\d:\d\d:\d\d SAST\.$/;

    const layout = render(
      await ContextLayout({
        params: Promise.resolve({ context: "khunou" }),
        children: <p>Page body</p>,
      }),
    );
    expect(layout.container.innerHTML).toBe("<p>Page body</p>");
    layout.unmount();

    const queuePage = render(await queue());
    expect(reads()).toBe(1);
    expect(queuePage.container.querySelector(".reference-banner")).toHaveTextContent(
      liveBannerText,
    );
    expect(screen.getByRole("status").textContent).toMatch(currentLine);
    expect(rail().getByText("Khunou Ore Exports")).toBeInTheDocument();
    expect(rail().getByRole("link", { name: /^Work queue/, current: "page" })).toHaveAttribute(
      "href",
      "/khunou/queue",
    );
    expect(rail().queryByRole("link", { name: /^Lots/ })).not.toBeInTheDocument();
    expect(rail().getByRole("link", { name: "CR-0001" })).toHaveAttribute(
      "href",
      "/khunou/lots/CR-0001",
    );
    expect(rail().getByRole("heading", { level: 2, name: "Releases, 0" })).toBeInTheDocument();
    expect(rail().getByText("No releases yet")).toBeInTheDocument();
    expect(rail().getByRole("link", { name: /^Exceptions/ })).toHaveAttribute(
      "href",
      "/khunou/exceptions",
    );
    expect(screen.getByText("No facility on chain")).toBeInTheDocument();
    expect(screen.getByText("FIAT_ATTESTATION_TEST · devnet")).toBeInTheDocument();
    expect(screen.getByText("Nothing needs you right now.")).toBeInTheDocument();
    expect(screen.queryByText(/Facility currency/)).not.toBeInTheDocument();
    cleanup();

    render(await queue("khunou", "overdue"));
    expect(screen.getByText("No overdue work.")).toBeInTheDocument();
    cleanup();

    render(await exceptions());
    expect(reads()).toBe(3);
    expect(rail().getByRole("link", { name: /^Exceptions/, current: "page" })).toBeInTheDocument();
    expect(screen.getByText("No open exceptions.")).toBeInTheDocument();
    cleanup();

    // The indexer halts before the next request: the dossier shows it, from its own read.
    fake.tables.indexer_checkpoints = [
      {
        ...checkpoint({
          status: "halted",
          last_success_at: new Date().toISOString(),
          halt_reason: "MIXED_INSTANCE",
          halted_at: "2026-11-26T00:05:00.000Z",
        }),
      },
    ];
    render(await dossier("khunou", "CR-0001", "overview"));
    expect(reads()).toBe(4);
    expect(screen.getAllByRole("status").map((node) => node.textContent)).toEqual([
      "Indexing stopped 26 Nov 2026, 02:05 SAST: the program sent something this version of Thetis does not recognise. What you see may be out of date; the chain itself is unaffected.",
      "Indexing has stopped, so this lot may have changed since. The figures below may be out of date.",
    ]);
    expect(rail().getByRole("link", { name: "CR-0001", current: "page" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "CR-0001 CHROME v1, grade G1" }),
    ).toBeInTheDocument();
    cleanup();

    await expect(queue("lender-one")).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    await expect(dossier("khunou", "CR-0002")).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    await expect(exceptions("kopano")).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });

    fake.getUser = async () => ({ data: { user: null }, error: null });
    await expect(queue("khunou", "mine")).rejects.toMatchObject({
      digest: expect.stringContaining(";/login?next=%2Fkhunou%2Fqueue%3Ffilter%3Dmine;"),
    });
    await expect(dossier("khunou", "CR-0001", "custody")).rejects.toMatchObject({
      digest: expect.stringContaining(";/login?next=%2Fkhunou%2Flots%2FCR-0001%3Ftab%3Dcustody;"),
    });
    await expect(exceptions()).rejects.toMatchObject({
      digest: expect.stringContaining(";/login?next=%2Fkhunou%2Fexceptions;"),
    });
  });

  test("the cause of a failed read reaches the server log and never the page", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    liveEnvironment();
    const fake = fakeSupabase(freshSnapshot());
    server.client = fake.client;

    fake.getUser = async () => ({
      data: { user: null },
      error: { name: "AuthUnknownError", status: 500, message: "upstream auth detail" },
    });
    const auth = render(await queue());
    expect(auth.container.textContent).not.toMatch(/upstream auth detail|AuthUnknownError/);
    expect(logged).toHaveBeenLastCalledWith("Could not read the indexed registry", {
      code: "READ_FAILED",
      path: "auth.getUser",
      cause: "upstream auth detail (500)",
    });
    cleanup();

    fake.getUser = async () => ({
      data: { user: { id: "21000000-0000-4000-8000-000000000001" } },
      error: null,
    });
    fake.respond = (call) =>
      call.table === "indexer_checkpoints"
        ? {
            data: null,
            error: { message: "permission denied for table indexer_checkpoints", code: "42501" },
            count: null,
          }
        : undefined;
    const read = render(await dossier());
    expect(read.container.textContent).not.toMatch(/permission denied|42501|indexer_checkpoints/);
    expect(logged).toHaveBeenLastCalledWith("Could not read the indexed registry", {
      code: "READ_FAILED",
      path: "checkpoint",
      cause: "permission denied for table indexer_checkpoints (42501)",
    });
  });

  test("the home route redirects to the first context's queue, or to /account with no membership", async () => {
    liveEnvironment();
    const fake = fakeSupabase(freshSnapshot(["lender-one", "khunou"]));
    server.client = fake.client;
    await expect(Home()).rejects.toMatchObject({
      digest: expect.stringContaining(";/khunou/queue;"),
    });
    fake.tables.organisations = [];
    await expect(Home()).rejects.toMatchObject({ digest: expect.stringContaining(";/account;") });
    fake.getUser = async () => ({
      data: { user: null },
      error: { name: "AuthApiError", status: 403 },
    });
    await expect(Home()).rejects.toMatchObject({
      digest: expect.stringContaining(";/login?next=%2F&reason=expired;"),
    });
  });

  test("the release route is notFound in live mode for an address that is not a visible intent", async () => {
    liveEnvironment();
    server.client = fakeSupabase(freshSnapshot(["lender-one"])).client;
    await expect(release()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });
});
