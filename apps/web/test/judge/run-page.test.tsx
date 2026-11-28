import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { RunPage } from "@/components/judge/run-page";
import type { ConfiguredJudgeView } from "@/data/judge/read";
import { loadedView, PROGRAM, PROTOCOL } from "./fixture";

afterEach(cleanup);

const main = () => {
  const element = document.querySelector("main");
  if (!element) throw new Error("no main");
  return element;
};
const BANNER = "Devnet. Synthetic organisations and quantities. No real goods, money or banks.";
const TITLE = "One Thetis run, as the chain recorded it";

test("loaded: header, state line, every step in order, parties, about and the refusals note", () => {
  render(<RunPage result={{ ok: true, view: loadedView() }} />);
  expect(main()).toHaveAttribute("data-state", "loaded");
  expect(main()).toHaveAttribute("data-step-count", "9");
  expect(main()).toHaveAttribute("data-refusal-count", "2");
  expect(screen.getByText(BANNER)).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(TITLE);
  expect(screen.getByText("Instance fiat-demo-run-07")).toBeInTheDocument();
  expect(
    document.querySelector(
      `a[href="https://explorer.solana.com/address/${PROGRAM}?cluster=devnet"]`,
    ),
  ).not.toBeNull();
  expect(
    document.querySelector(
      `a[href="https://explorer.solana.com/address/${PROTOCOL}?cluster=devnet"]`,
    ),
  ).not.toBeNull();
  expect(screen.getByText("Settlement").parentElement).toHaveTextContent(
    "Settlementtest bank confirmation",
  );
  expect(
    screen.getByText(
      "9 transactions and 2 refusals, all confirmed by the program. Indexed through slot 900.",
    ),
  ).toBeInTheDocument();

  const titles = [...document.querySelectorAll(".judge-step h3")].map((h) => h.textContent);
  expect(titles).toEqual([
    "Lot issued",
    "Units locked",
    "Refused: a second lender pledges the same units",
    "Advance recorded",
    "Refused: a driver with no authority signs the handover",
    "Handover at departure",
    "Border observation",
    "Loading recorded",
    "SetRestriction",
  ]);
  expect(screen.getByText("Before the run: 2 setup transactions")).toBeInTheDocument();
  const handover = document.querySelector('[data-kind="run"]:nth-of-type(7)');
  expect(handover).not.toBeNull();
  expect(
    screen.getByText("Signed by Kopano Stockyard Custody and Mosela Haulage"),
  ).toBeInTheDocument();
  const refusals = document.querySelectorAll('[data-kind="refusal"]');
  expect(refusals).toHaveLength(2);
  expect(within(refusals[0] as HTMLElement).getByText("Failed")).toBeInTheDocument();
  expect(
    within(refusals[0] as HTMLElement).getByText("Failed transaction on the explorer"),
  ).toBeInTheDocument();
  expect(screen.getAllByText(/^Transaction \w{4}…\w{4}$/).length).toBeGreaterThanOrEqual(9);
  expect(screen.getByText("Finalized")).toBeInTheDocument();

  const parties = screen.getByRole("heading", { name: "Parties in this run" })
    .parentElement as HTMLElement;
  expect(within(parties).getAllByRole("listitem")).toHaveLength(5);
  expect(within(parties).getByText("Exporter, synthetic")).toBeInTheDocument();
  expect(within(parties).getByText("Lender")).toBeInTheDocument();
  expect(screen.getByText("What this page is and is not")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "An intake can be issued only once" })).toHaveAttribute(
    "href",
    "https://github.com/Katlego-tech/Thetis/blob/main/programs/thetis/tests/issue.rs#L577",
  );
});

test("loaded with more transactions than the run recorded carries the note", () => {
  render(<RunPage result={{ ok: true, view: { ...loadedView(), expectedTransactions: 7 } }} />);
  expect(
    screen.getByText(/This instance has 9 transactions; the run recorded 7\.$/),
  ).toBeInTheDocument();
});

test("indexing: counts so far, and with no checkpoint no spine at all", () => {
  const view: ConfiguredJudgeView = {
    ...loadedView(),
    expectedTransactions: 14,
    expectedRefusals: 3,
  };
  render(<RunPage result={{ ok: true, view }} />);
  expect(main()).toHaveAttribute("data-state", "indexing");
  expect(screen.getByText("Indexing")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Indexing. 9 of 14 transactions and 2 of 3 refusals of this run are in this read model so far, through slot 900. Steps not yet indexed are not shown.",
    ),
  ).toBeInTheDocument();
  cleanup();
  render(
    <RunPage
      result={{
        ok: true,
        view: {
          ...loadedView(),
          checkpoint: null,
          transactions: [],
          refusals: [],
          organisations: [],
        },
      }}
    />,
  );
  expect(
    screen.getByText(
      "Indexing has not started. No steps are shown until the indexer confirms them.",
    ),
  ).toBeInTheDocument();
  expect(document.querySelector(".judge-spine")).toBeNull();
});

test("halted: the slot and reason, and the steps indexed so far", () => {
  const view = loadedView();
  render(
    <RunPage
      result={{
        ok: true,
        view: {
          ...view,
          checkpoint: {
            status: "halted",
            indexedThroughSlot: 550,
            lastSuccessAt: null,
            haltReason: "EVENT_GAP",
            haltedAt: "2026-11-28T00:10:00.000Z",
          },
        },
      }}
    />,
  );
  expect(main()).toHaveAttribute("data-state", "halted");
  expect(screen.getByText("Stopped")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Indexing stopped at slot 550 (EVENT_GAP). Steps after that slot are not shown until it resumes.",
    ),
  ).toBeInTheDocument();
  expect(document.querySelectorAll(".judge-step").length).toBe(9);
});

test("not configured: no config row, or the indexer reads another instance", () => {
  render(<RunPage result={{ ok: true, view: { configured: false } }} />);
  expect(main()).toHaveAttribute("data-state", "not_configured");
  expect(main()).toHaveAttribute("data-step-count", "0");
  expect(screen.getByRole("heading", { name: "No run is set for this page" })).toBeInTheDocument();
  expect(
    screen.getByText(
      "The page shows one judged run, chosen when the site is deployed. None is set yet, so there is nothing to show. Nothing on this page is a stand-in.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("What the program refuses")).toBeInTheDocument();
  expect(document.querySelector(".judge-step")).toBeNull();
  cleanup();
  render(<RunPage result={{ ok: true, view: { ...loadedView(), streamMatches: false } }} />);
  expect(main()).toHaveAttribute("data-state", "not_configured");
  expect(
    screen.getByText(
      "The indexer is reading a different instance from the one set for this page, so no steps are shown.",
    ),
  ).toBeInTheDocument();
  expect(document.querySelector(".judge-step")).toBeNull();
});

test("read error: the kind, or the configuration copy", () => {
  render(<RunPage result={{ ok: false, kind: "shape" }} />);
  expect(main()).toHaveAttribute("data-state", "read_error");
  expect(screen.getByRole("heading", { name: "The run could not be read" })).toBeInTheDocument();
  expect(
    screen.getByText(
      "The page asked its database for the run and did not get an answer it could use (shape). Nothing is shown rather than a partial record. Reload in a minute.",
    ),
  ).toBeInTheDocument();
  cleanup();
  render(<RunPage result={{ ok: false, kind: "config" }} />);
  expect(
    screen.getByText("This deployment is missing its database address or public key."),
  ).toBeInTheDocument();
});
