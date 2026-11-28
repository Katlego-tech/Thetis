// navigation.md §8.1: the web workspace navigation (T074a). Organisations, lots and quantities are the
// synthetic demo cast's; the fake readers below never touch a database or the chain.

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  test,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  pathname: "/lender-one/queue" as string,
  replace: vi.fn(),
  push: vi.fn(),
  auth: {} as unknown as { getSession: Mock; onAuthStateChange: Mock; signOut: Mock },
  from: vi.fn(),
}));

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  usePathname: () => mocks.pathname,
  useRouter: () => ({
    replace: mocks.replace,
    push: mocks.push,
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
}));

vi.mock("@/lib/supabase-browser", () => ({
  supabaseBrowser: () => ({ auth: mocks.auth, from: mocks.from }),
}));

vi.mock("@/app/fonts", () => ({ archivo: { variable: "" }, jetbrainsMono: { variable: "" } }));

vi.mock("@/lib/supabase-server", () => ({
  supabaseServer: async () => {
    throw new Error("no server reads in the navigation tests");
  },
}));

const { activeHref, RailNav } = await import("@/components/shell/rail-nav");
const { railSections } = await import("@/components/shell/side-rail");
const { ContextSwitcher, switchHref } = await import("@/components/shell/context-switcher");
const { AccountBlock } = await import("@/components/shell/account-block");
const { MenuSheet } = await import("@/components/shell/menu-sheet");
const { LiveShell } = await import("@/components/shell/live-shell");
const { WorkspaceLoading } = await import("@/components/shell/workspace-loading");
const { TopBar } = await import("@/components/access/access-shell");
const { AccountScreen } = await import("@/components/access/account-screen");
const { default: ContextLayout } = await import("@/app/[context]/layout");

import type { LiveIntent, LiveLotView, LiveReader } from "@/data/live/types";
import type { Context, Organisation } from "@/data/types";

const EMAIL = "naledi.dube@lender-one.example";
const SESSION = { access_token: "t", user: { id: "u-1", email: EMAIL } };

const org = (id: string, name: string, role: string): Organisation => ({ id, name, role });
const LENDER_ONE = org("lender-one", "Lender One Bank", "lender");
const KHUNOU = org("khunou", "Khunou Ore Exports", "exporter");
const BUYER = org("buyer-smelter", "Buyer Smelter Co", "buyer");
const ctx = (organisation: Organisation): Context => ({
  organisationId: organisation.id,
  role: organisation.role,
  organisation,
});
const CONTEXTS = [ctx(LENDER_ONE), ctx(KHUNOU), ctx(BUYER)];

const lot = (id: string) => ({ id }) as unknown as LiveLotView;
const intent = (address: string, lotId: string, quantityKg: bigint) =>
  ({ address, lotId, quantityKg }) as unknown as LiveIntent;

/** A live reader with only what the rail reads: Lender One finances two lots, one with a release. */
function fakeLive(): LiveReader {
  const lots: Record<string, LiveLotView[]> = {
    "lender-one": [lot("CR-0001"), lot("CR-0002")],
    khunou: [lot("CR-0001")],
    "buyer-smelter": [],
  };
  const releases: Record<string, LiveIntent[]> = {
    "lender-one": [intent("Intent1111", "CR-0001", 2_000_000n)],
    khunou: [intent("Intent1111", "CR-0001", 2_000_000n)],
    "buyer-smelter": [],
  };
  return {
    mode: "live",
    freshness: {
      state: "current",
      indexedThroughSlot: 12_000n,
      lastSuccessAt: "2026-11-28T08:02:00Z",
      haltReason: null,
      haltedAt: null,
      checkedAt: "2026-11-28T08:02:05Z",
    },
    contexts: () => CONTEXTS,
    context: (id: string) => CONTEXTS.find(({ organisationId }) => organisationId === id) ?? null,
    workQueue: (id: string) => (id === "lender-one" ? [{}, {}, {}] : []),
    exceptions: () => [],
    lots: (id: string) => lots[id] ?? [],
    releases: (id: string) => releases[id] ?? [],
  } as unknown as LiveReader;
}

function renderRail(organisationId = "lender-one", fallback: string | null = null) {
  return render(
    <RailNav sections={railSections(fakeLive(), organisationId)} fallback={fallback} />,
  );
}

const currentLinks = () =>
  screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");

function signedIn() {
  mocks.auth.getSession.mockResolvedValue({ data: { session: SESSION }, error: null });
}

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  mocks.pathname = "/lender-one/queue";
  mocks.replace.mockReset();
  mocks.push.mockReset();
  mocks.from.mockReset();
  mocks.auth = {
    getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    onAuthStateChange: vi
      .fn()
      .mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("rail sections", () => {
  test("lists every lot and every release of the context under its heading, each linking to its page", () => {
    renderRail();
    const nav = within(screen.getByRole("navigation", { name: "Workspace" }));
    expect(nav.getByRole("heading", { level: 2, name: "Lots, 2" })).toBeInTheDocument();
    const lots = within(nav.getByRole("list", { name: "Lots, 2" })).getAllByRole("link");
    expect(lots.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["CR-0001", "/lender-one/lots/CR-0001"],
      ["CR-0002", "/lender-one/lots/CR-0002"],
    ]);
    const releases = within(nav.getByRole("list", { name: "Releases, 1" })).getAllByRole("link");
    expect(releases).toHaveLength(1);
    expect(releases[0]).toHaveAccessibleName("CR-0001, 2,000.000 t");
    expect(releases[0]).toHaveAttribute("href", "/lender-one/releases/Intent1111");
    expect(nav.getByRole("link", { name: "Work queue, 3" })).toHaveAttribute(
      "href",
      "/lender-one/queue",
    );
    expect(nav.getByRole("link", { name: "Exceptions, 0" })).toHaveAttribute(
      "href",
      "/lender-one/exceptions",
    );
    // "Lots" and "Releases" are headings, not links (§5.2).
    expect(nav.queryByRole("link", { name: /^Lots/ })).not.toBeInTheDocument();
    expect(nav.queryByRole("link", { name: /^Releases/ })).not.toBeInTheDocument();
  });

  test("shows No lots yet and No releases yet under headings with nothing to list", () => {
    renderRail("buyer-smelter");
    expect(screen.getByRole("heading", { level: 2, name: "Lots, 0" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Releases, 0" })).toBeInTheDocument();
    expect(screen.getByText("No lots yet")).toBeInTheDocument();
    expect(screen.getByText("No releases yet")).toBeInTheDocument();
  });

  it.each([
    ["the queue", "/lender-one/queue"],
    ["exceptions", "/lender-one/exceptions"],
    ["a lot", "/lender-one/lots/CR-0002"],
    ["a release", "/lender-one/releases/Intent1111"],
  ])("marks exactly one rail link as the current page", (_name, path) => {
    mocks.pathname = path;
    renderRail("lender-one", "/lender-one/queue");
    const current = currentLinks();
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute("href", path);
  });

  test("marks the command's lot as current on a command page, and the work queue when it has no lot", () => {
    mocks.pathname = "/lender-one/commands/1a2b3c4d-0000-4000-8000-000000000001";
    const sections = railSections(fakeLive(), "lender-one");
    expect(activeHref(mocks.pathname, sections, "/lender-one/lots/CR-0001")).toBe(
      "/lender-one/lots/CR-0001",
    );
    renderRail("lender-one", "/lender-one/lots/CR-0001");
    expect(currentLinks().map((link) => link.getAttribute("href"))).toEqual([
      "/lender-one/lots/CR-0001",
    ]);
    cleanup();

    renderRail("lender-one", "/lender-one/queue");
    expect(currentLinks().map((link) => link.getAttribute("href"))).toEqual(["/lender-one/queue"]);
  });
});

describe("context switcher", () => {
  test("keeps the work queue or exceptions when switching organisation and otherwise opens the work queue", () => {
    expect(switchHref("khunou", "/lender-one/queue")).toBe("/khunou/queue");
    expect(switchHref("khunou", "/lender-one/exceptions")).toBe("/khunou/exceptions");
    expect(switchHref("khunou", "/lender-one/lots/CR-0001")).toBe("/khunou/queue");
    expect(switchHref("khunou", "/lender-one/releases/Intent1111")).toBe("/khunou/queue");
    expect(switchHref("khunou", "/lender-one/commands/1a2b3c4d")).toBe("/khunou/queue");
  });

  test("shows a single organisation as text, not a menu", () => {
    render(<ContextSwitcher current={ctx(KHUNOU)} contexts={[ctx(KHUNOU)]} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Acting as")).toBeInTheDocument();
    expect(screen.getByText("Khunou Ore Exports")).toBeInTheDocument();
    expect(screen.getByText("Exporter, synthetic")).toBeInTheDocument();
  });

  test("lists each organisation with its role in the switcher and marks the current one", async () => {
    mocks.pathname = "/lender-one/exceptions";
    render(<ContextSwitcher current={ctx(LENDER_ONE)} contexts={CONTEXTS} />);
    const trigger = screen.getByRole("button", {
      name: "Acting as Lender One Bank. Switch organisation",
    });
    expect(screen.getByText("Lender, synthetic")).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "Enter" });
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Lender One BankLender, synthetic",
      "Khunou Ore ExportsExporter, synthetic",
      "Buyer Smelter CoBuyer, synthetic",
    ]);
    expect(items.map((item) => item.getAttribute("href"))).toEqual([
      "/lender-one/exceptions",
      "/khunou/exceptions",
      "/buyer-smelter/exceptions",
    ]);
    expect(items.map((item) => item.getAttribute("aria-current"))).toEqual(["true", null, null]);
  });
});

describe("account block", () => {
  test("shows the email, Your account and Sign out in the rail when signed in", async () => {
    signedIn();
    render(<AccountBlock />);
    const account = within(await screen.findByRole("navigation", { name: "Account" }));
    expect(account.getByText(EMAIL)).toBeInTheDocument();
    expect(account.getByRole("link", { name: "Your account" })).toHaveAttribute("href", "/account");
    expect(account.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  test("shows no account block without a session", async () => {
    const { container } = render(<AccountBlock />);
    await waitFor(() => expect(mocks.auth.getSession).toHaveBeenCalled());
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("navigation", { name: "Account" })).not.toBeInTheDocument();
  });

  test("signs out from the rail and goes to /login, even when sign-out fails", async () => {
    signedIn();
    mocks.auth.signOut.mockRejectedValue(new TypeError("fetch failed"));
    render(<AccountBlock />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/login"));
    expect(mocks.auth.signOut).toHaveBeenCalledTimes(1);
  });
});

describe("menu sheet", () => {
  test("opens the menu as a dialog with the workspace links, closes it on Escape and returns focus to Menu", async () => {
    signedIn();
    render(<MenuSheet sections={railSections(fakeLive(), "buyer-smelter")} />);
    const menu = screen.getByRole("button", { name: "Menu" });
    fireEvent.click(menu);
    const dialog = within(await screen.findByRole("dialog", { name: "Menu" }));
    const workspace = within(dialog.getByRole("navigation", { name: "Workspace" }));
    expect(workspace.getByRole("link", { name: "Work queue, 0" })).toHaveAttribute(
      "href",
      "/buyer-smelter/queue",
    );
    expect(workspace.getByText("No lots yet")).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(await dialog.findByRole("button", { name: "Sign out" })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(menu).toHaveFocus();
  });

  test("closes the menu when a link is chosen", async () => {
    const view = render(<MenuSheet sections={railSections(fakeLive(), "lender-one")} />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Menu" }));
    fireEvent.click(dialog.getByRole("link", { name: "CR-0002" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // A pathname change (the chosen page arriving) also closes it.
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    await screen.findByRole("dialog", { name: "Menu" });
    mocks.pathname = "/lender-one/exceptions";
    view.rerender(<MenuSheet sections={railSections(fakeLive(), "lender-one")} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("keyboard and titles", () => {
  test("puts Skip to content first, pointing at the main landmark", async () => {
    vi.stubEnv("THETIS_DATA_SOURCE", undefined);
    const reference = render(
      await ContextLayout({
        params: Promise.resolve({ context: "lender-one" }),
        children: <p>Page body</p>,
      }),
    );
    const focusable = () =>
      document.body.querySelectorAll<HTMLElement>(
        "a[href], button, [tabindex]:not([tabindex='-1'])",
      );
    expect(focusable()[0]).toHaveTextContent("Skip to content");
    expect(focusable()[0]).toHaveAttribute("href", "#content");
    expect(screen.getByRole("main")).toHaveAttribute("id", "content");
    expect(screen.getByRole("main")).toHaveTextContent("Page body");
    reference.unmount();

    render(
      <LiveShell reader={fakeLive()} current={ctx(LENDER_ONE)} fallback="/lender-one/queue">
        <p>Live body</p>
      </LiveShell>,
    );
    expect(focusable()[0]).toHaveTextContent("Skip to content");
    expect(focusable()[0]).toHaveAttribute("href", "#content");
    expect(screen.getByRole("main")).toHaveAttribute("id", "content");
    expect(screen.getByRole("main")).toHaveTextContent("Live body");
  });

  test("names each workspace and access page in the document title", async () => {
    const root = await import("@/app/layout");
    expect(root.metadata.title).toEqual({ default: "Thetis", template: "%s · Thetis" });
    expect((await import("@/app/[context]/queue/page")).metadata.title).toBe("Work queue");
    expect((await import("@/app/[context]/exceptions/page")).metadata.title).toBe("Exceptions");
    const lotPage = await import("@/app/[context]/lots/[lotId]/page");
    expect(
      (
        await lotPage.generateMetadata({
          params: Promise.resolve({ context: "lender-one", lotId: "CR-0001" }),
        })
      ).title,
    ).toBe("Lot CR-0001");
    expect((await import("@/app/[context]/releases/[releaseId]/page")).metadata.title).toBe(
      "Release review",
    );
    const commandPage = await import("@/app/[context]/commands/[commandId]/page");
    expect(
      (
        await commandPage.generateMetadata({
          params: Promise.resolve({
            context: "lender-one",
            commandId: "1a2b3c4d-0000-4000-8000-000000000001",
          }),
        })
      ).title,
    ).toBe("Command 1a2b3c4d");
    expect((await import("@/app/(access)/account/page")).metadata.title).toBe("Your account");
    expect((await import("@/app/(access)/login/page")).metadata.title).toBe("Sign in");
    expect((await import("@/app/(access)/invite/page")).metadata.title).toBe("Invitation");
  });
});

describe("access pages", () => {
  test("links each organisation on the account page to its work queue", async () => {
    signedIn();
    const rows: Record<string, unknown[]> = {
      memberships: [
        {
          id: "m-1",
          member_role: "member",
          created_at: "2026-11-18T14:05:00Z",
          organisations: {
            id: "o-1",
            slug: "lender-one",
            name: "Lender One Bank",
            kind: "lender",
            synthetic: true,
          },
        },
        {
          id: "m-2",
          member_role: "admin",
          created_at: "2026-11-19T09:00:00Z",
          organisations: {
            id: "o-2",
            slug: "khunou",
            name: "Khunou Ore Exports",
            kind: "exporter",
            synthetic: true,
          },
        },
      ],
      signer_links: [],
    };
    mocks.from.mockImplementation((table: string) => {
      const result = { data: rows[table] ?? [], error: null, status: 200 };
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        order: () => chain,
        // biome-ignore lint/suspicious/noThenProperty: the Supabase query builder is awaited
        then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return chain;
    });
    render(<AccountScreen />);
    const table = within(await screen.findByRole("region", { name: "Organisations" }));
    expect(await table.findByRole("link", { name: "Lender One Bank" })).toHaveAttribute(
      "href",
      "/lender-one/queue",
    );
    expect(table.getByRole("link", { name: "Khunou Ore Exports" })).toHaveAttribute(
      "href",
      "/khunou/queue",
    );
  });

  test("offers Work queue in the access top bar when signed in", async () => {
    signedIn();
    render(<TopBar />);
    expect(await screen.findByRole("link", { name: "Work queue" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});

describe("loading", () => {
  test("keeps the rail on screen while a live page loads, and adds nothing in reference mode", () => {
    vi.stubEnv("THETIS_DATA_SOURCE", "live");
    const live = render(
      <WorkspaceLoading>
        <p>Loading body</p>
      </WorkspaceLoading>,
    );
    const rail = live.container.querySelector(".side-rail");
    expect(rail).not.toBeNull();
    expect(rail).toHaveAttribute("aria-hidden", "true");
    expect(rail).toHaveTextContent(/^THETIS$/);
    expect(live.container.querySelector(".reference-banner")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.getByRole("main")).toHaveAttribute("id", "content");
    expect(screen.getByRole("main")).toHaveTextContent("Loading body");
    live.unmount();

    vi.stubEnv("THETIS_DATA_SOURCE", undefined);
    const reference = render(
      <WorkspaceLoading>
        <p>Loading body</p>
      </WorkspaceLoading>,
    );
    expect(reference.container.innerHTML).toBe("<p>Loading body</p>");
  });
});
