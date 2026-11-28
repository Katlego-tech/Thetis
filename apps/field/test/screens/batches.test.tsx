// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ApiTimeout } from "../../src/api/client";
import type { CommandView } from "../../src/api/commands";
import type { AppContextValue } from "../../src/context";
import { readOrganisationAt } from "../../src/data/reads";
import { Batches } from "../../src/screens/Batches";
import {
  BATCH_ADDRESS,
  fieldBatch,
  HANDOVER_ID,
  handoverView,
  KOPANO_ORG,
  MOSELA_CHAIN,
  MOSELA_ORG,
  PORT_CHAIN,
  PORT_ORG,
} from "../custody-fixtures";
import { PROTOCOL } from "../fixtures";
import { renderScreen } from "./app";
import { button, enabled, phone, rowText } from "./custody-app";
import { pressBack } from "./native";

vi.mock("react-native", async () => (await import("./native")).reactNative);
vi.mock("react-native-safe-area-context", async () => (await import("./native")).safeArea);
vi.mock("@solana-mobile/mobile-wallet-adapter-protocol", () => ({ transact: vi.fn() }));
vi.mock("../../src/supabase", () => ({ SupabaseTimeout: class extends Error {} }));
vi.mock("expo-crypto", async () => ({ randomUUID: (await import("node:crypto")).randomUUID }));
vi.mock("expo-image-picker", () => ({}));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-file-system", () => ({ File: class {}, Directory: class {}, Paths: {} }));
vi.mock("../../src/data/reads", async (importOriginal) =>
  (await import("../custody-fixtures")).custodyReads(
    await importOriginal<typeof import("../../src/data/reads")>(),
  ),
);

const NEXT = { orgId: MOSELA_ORG, displayName: "Mosela Haulage" };

beforeEach(() => {
  vi.mocked(readOrganisationAt).mockReset();
  vi.mocked(readOrganisationAt).mockResolvedValue(NEXT);
});

afterEach(cleanup);

/** Kopano's phone holding the demo batch, on the list. */
async function kopanoWithBatch(overrides: Partial<AppContextValue> = {}) {
  const app = phone("kopano", overrides);
  vi.mocked(app.field.batches).mockResolvedValue([fieldBatch()]);
  const harness = await renderScreen(<Batches />, app);
  await screen.findByText("Batch 1 of 1, 5,000.000 t");
  return { app, harness };
}

async function openDetail() {
  await act(async () => fireEvent.click(screen.getByText("CR-0001")));
  await screen.findByText("CR-0001, batch 1 of 1");
}

describe("Batches you hold", () => {
  it("lists a held batch: the lot, which batch, the quantity, the carrier and where it is", async () => {
    const { app } = await kopanoWithBatch();
    expect(screen.getByText("Batches you hold")).toBeTruthy();
    expect(screen.getByText("CR-0001")).toBeTruthy();
    expect(screen.getByText("Batch 1 of 1, 5,000.000 t")).toBeTruthy();
    expect(screen.getByText("Carrier on the manifest: Mosela Haulage")).toBeTruthy();
    expect(screen.getByText("At source")).toBeTruthy();
    expect(app.field.batches).toHaveBeenCalledWith(KOPANO_ORG);
  });

  it("shows only the batches this organisation holds, not those arriving at a terminal", async () => {
    const app = phone("port");
    vi.mocked(app.field.batches).mockResolvedValue([
      fieldBatch({ holder: MOSELA_CHAIN, holderName: "Mosela Haulage", stage: "InTransit" }),
      fieldBatch({
        batch: PORT_CHAIN,
        lotId: "CR-0002",
        holder: PORT_CHAIN,
        holderName: "Port Terminal T1",
        stage: "Arrived",
      }),
    ]);
    await renderScreen(<Batches />, app);
    await screen.findByText("CR-0002");
    expect(screen.queryByText("CR-0001")).toBeNull();
    expect(screen.getByText("Arrived")).toBeTruthy();
    expect(app.field.batches).toHaveBeenCalledWith(PORT_ORG);
  });

  it("shows the stage as In transit when the carrier holds it", async () => {
    const app = phone("mosela");
    vi.mocked(app.field.batches).mockResolvedValue([
      fieldBatch({ holder: MOSELA_CHAIN, holderName: "Mosela Haulage", stage: "InTransit" }),
    ]);
    await renderScreen(<Batches />, app);
    await screen.findByText("In transit");
    expect(screen.getByText("CR-0001")).toBeTruthy();
  });

  it("no batches held: says so and that the owner prepares shipments on the web", async () => {
    const app = phone("kopano");
    vi.mocked(app.field.batches).mockResolvedValue([
      fieldBatch({ holder: MOSELA_CHAIN, holderName: "Mosela Haulage" }),
    ]);
    await renderScreen(<Batches />, app);
    await screen.findByText(
      "Kopano Stockyard Custody holds no registered batches right now. Shipments are prepared by the owner on the web.",
    );
    expect(screen.queryByText("CR-0001")).toBeNull();
  });

  it("batches failed to load: says nothing changed, and Retry reads again", async () => {
    const app = phone("kopano");
    vi.mocked(app.field.batches).mockRejectedValueOnce(new ApiTimeout());
    vi.mocked(app.field.batches).mockResolvedValue([fieldBatch()]);
    await renderScreen(<Batches />, app);
    await screen.findByText("Thetis could not load your batches. Nothing changed.");
    expect(screen.queryByText("CR-0001")).toBeNull();
    await act(async () => fireEvent.click(await enabled("Retry")));
    await screen.findByText("Batch 1 of 1, 5,000.000 t");
    expect(app.field.batches).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Thetis could not load your batches. Nothing changed.")).toBeNull();
  });

  it("batches failed to load: a server refusal is the same failure", async () => {
    const app = phone("kopano");
    vi.mocked(app.field.batches).mockRejectedValue(
      new ApiError(503, "CHAIN_UNAVAILABLE", "", null),
    );
    await renderScreen(<Batches />, app);
    await screen.findByText("Thetis could not load your batches. Nothing changed.");
    expect(button("Retry")).not.toBeNull();
  });
});

describe("Batch detail", () => {
  it("shows the lot, the quantity, who it is handed to and why, and the destination", async () => {
    await kopanoWithBatch();
    await openDetail();
    expect(rowText("Quantity")).toContain("5,000.000 t");
    const handTo = rowText("Hand over to");
    expect(handTo).toContain("Mosela Haulage");
    expect(handTo).toContain("The carrier on the manifest");
    expect(rowText("Destination")).toContain("Port Terminal T1");
    expect(button("Start handover")).not.toBeNull();
  });

  it("in transit the next holder is the destination custodian", async () => {
    const app = phone("mosela");
    vi.mocked(app.field.batches).mockResolvedValue([
      fieldBatch({ holder: MOSELA_CHAIN, holderName: "Mosela Haulage", stage: "InTransit" }),
    ]);
    await renderScreen(<Batches />, app);
    await act(async () => fireEvent.click(await screen.findByText("CR-0001")));
    await screen.findByText("CR-0001, batch 1 of 1");
    const handTo = rowText("Hand over to");
    expect(handTo).toContain("Port Terminal T1");
    expect(handTo).toContain("The destination custodian");
  });

  it("an arrived batch has no next holder and no Start handover", async () => {
    const app = phone("port");
    vi.mocked(app.field.batches).mockResolvedValue([
      fieldBatch({ holder: PORT_CHAIN, holderName: "Port Terminal T1", stage: "Arrived" }),
    ]);
    await renderScreen(<Batches />, app);
    await act(async () => fireEvent.click(await screen.findByText("CR-0001")));
    await screen.findByText("CR-0001, batch 1 of 1");
    expect(screen.queryByText("Hand over to")).toBeNull();
    expect(button("Start handover")).toBeNull();
    expect(rowText("Destination")).toContain("Port Terminal T1");
  });

  it("Back returns to the list, which is the Batches tab root with the tab bar and no Back", async () => {
    const { app } = await kopanoWithBatch();
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    await openDetail();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Back" })));
    await screen.findByText("Batch 1 of 1, 5,000.000 t");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(app.back).not.toHaveBeenCalled();
  });

  it("Android Back on a batch returns to the list, and on the list is left to the tabs", async () => {
    await kopanoWithBatch();
    await openDetail();
    let handled = false;
    await act(async () => {
      handled = pressBack();
    });
    expect(handled).toBe(true);
    await screen.findByText("Batch 1 of 1, 5,000.000 t");
    await act(async () => {
      handled = pressBack();
    });
    expect(handled).toBe(false);
  });
});

describe("Record border crossing", () => {
  it("a transporter starts a border crossing from its batches", async () => {
    const app = phone("mosela");
    vi.mocked(app.field.batches).mockResolvedValue([
      fieldBatch({ holder: MOSELA_CHAIN, holderName: "Mosela Haulage", stage: "InTransit" }),
    ]);
    await renderScreen(<Batches />, app);
    await screen.findByText("In transit");
    await act(async () => fireEvent.click(await enabled("Record border crossing")));
    expect(app.navigate).toHaveBeenCalledWith({ name: "observation" });
  });

  it("a custodian is not offered one", async () => {
    await kopanoWithBatch();
    expect(button("Record border crossing")).toBeNull();
  });
});

describe("Start handover", () => {
  it("prepares the handover to the carrier's organisation and opens it", async () => {
    const { app } = await kopanoWithBatch();
    vi.mocked(app.commands.create).mockResolvedValue(handoverView("awaiting_signatures"));
    await openDetail();
    await act(async () => fireEvent.click(await enabled("Start handover")));
    await waitFor(() =>
      expect(app.navigate).toHaveBeenCalledWith({ name: "handover", commandId: HANDOVER_ID }),
    );
    expect(readOrganisationAt).toHaveBeenCalledWith(app.db, PROTOCOL, MOSELA_CHAIN);
    expect(app.commands.create).toHaveBeenCalledOnce();
    expect(app.commands.create).toHaveBeenCalledWith({
      kind: "handover",
      organisationId: KOPANO_ORG,
      args: { batch: BATCH_ADDRESS, to: MOSELA_ORG },
    });
  });

  it("in transit it hands to the destination custodian's organisation", async () => {
    const app = phone("mosela");
    vi.mocked(app.field.batches).mockResolvedValue([
      fieldBatch({ holder: MOSELA_CHAIN, holderName: "Mosela Haulage", stage: "InTransit" }),
    ]);
    vi.mocked(readOrganisationAt).mockResolvedValue({
      orgId: PORT_ORG,
      displayName: "Port Terminal T1",
    });
    vi.mocked(app.commands.create).mockResolvedValue(
      handoverView("awaiting_signatures", { holderOrg: MOSELA_ORG, nextOrg: PORT_ORG }),
    );
    await renderScreen(<Batches />, app);
    await act(async () => fireEvent.click(await screen.findByText("CR-0001")));
    await act(async () => fireEvent.click(await enabled("Start handover")));
    await waitFor(() => expect(app.commands.create).toHaveBeenCalledOnce());
    expect(readOrganisationAt).toHaveBeenCalledWith(app.db, PROTOCOL, PORT_CHAIN);
    expect(app.commands.create).toHaveBeenCalledWith({
      kind: "handover",
      organisationId: MOSELA_ORG,
      args: { batch: BATCH_ADDRESS, to: PORT_ORG },
    });
  });

  it("shows Preparing text, disabled, until the relay answers", async () => {
    const { app } = await kopanoWithBatch();
    let answer: (view: CommandView) => void = () => {};
    vi.mocked(app.commands.create).mockReturnValue(
      new Promise<CommandView>((resolve) => {
        answer = resolve;
      }),
    );
    await openDetail();
    await act(async () => fireEvent.click(await enabled("Start handover")));
    const preparing = await screen.findByRole("button", { name: "Preparing text" });
    expect((preparing as HTMLButtonElement).disabled).toBe(true);
    expect(button("Start handover")).toBeNull();
    expect(app.navigate).not.toHaveBeenCalled();
    await act(async () => answer(handoverView("awaiting_signatures")));
    await waitFor(() => expect(app.navigate).toHaveBeenCalled());
  });

  it("a second tap while the first is in flight sends nothing", async () => {
    const { app } = await kopanoWithBatch();
    let answer: (view: CommandView) => void = () => {};
    vi.mocked(app.commands.create).mockReturnValue(
      new Promise<CommandView>((resolve) => {
        answer = resolve;
      }),
    );
    await openDetail();
    const start = await enabled("Start handover");
    await act(async () => {
      fireEvent.click(start);
      fireEvent.click(start);
    });
    await waitFor(() => expect(app.commands.create).toHaveBeenCalledOnce());
    expect(readOrganisationAt).toHaveBeenCalledOnce();
    await act(async () => answer(handoverView("awaiting_signatures")));
    await waitFor(() => expect(app.navigate).toHaveBeenCalledOnce());
    expect(app.commands.create).toHaveBeenCalledOnce();
  });

  it("marks the relay call as in flight, so the tabs and Back wait", async () => {
    const { app } = await kopanoWithBatch();
    vi.mocked(app.commands.create).mockReturnValue(new Promise<CommandView>(() => {}));
    await openDetail();
    await act(async () => fireEvent.click(await enabled("Start handover")));
    await waitFor(() => expect(app.setBusy).toHaveBeenCalledWith(true));
    const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
  });

  it("an organisation that is not set up: says so and sends nothing", async () => {
    const { app } = await kopanoWithBatch();
    vi.mocked(readOrganisationAt).mockResolvedValue(null);
    await openDetail();
    await act(async () => fireEvent.click(await enabled("Start handover")));
    await screen.findByText(
      "Mosela Haulage is not set up as an organisation on this Thetis instance. Nothing was sent.",
    );
    expect(app.commands.create).not.toHaveBeenCalled();
    expect(app.navigate).not.toHaveBeenCalled();
    expect((await enabled("Start handover")).disabled).toBe(false);
  });

  it("a relay refusal shows its copy, and stays on the batch", async () => {
    const { app } = await kopanoWithBatch();
    vi.mocked(app.commands.create).mockRejectedValue(
      new ApiError(409, "ACCOUNT_MISSING", "", `batch: ${BATCH_ADDRESS}`),
    );
    await openDetail();
    await act(async () => fireEvent.click(await enabled("Start handover")));
    await screen.findByText("This batch is not set up on this Thetis instance. Nothing was sent.");
    expect(app.navigate).not.toHaveBeenCalled();
    expect(screen.getByText("CR-0001, batch 1 of 1")).toBeTruthy();
  });

  it("a relay that does not answer in time says nothing changed", async () => {
    const { app } = await kopanoWithBatch();
    vi.mocked(app.commands.create).mockRejectedValue(new ApiTimeout());
    await openDetail();
    await act(async () => fireEvent.click(await enabled("Start handover")));
    await screen.findByText(
      "Thetis did not answer in time. Nothing changed on this phone. Try again.",
    );
    expect(app.navigate).not.toHaveBeenCalled();
  });
});

describe("Offline", () => {
  it("says a handover needs both phones online, disables Start handover and keeps the batch", async () => {
    const { app, harness } = await kopanoWithBatch();
    await openDetail();
    harness.setOnline(false);
    await screen.findByText(
      "Offline. A handover needs both phones online at the moment you sign. Nothing was recorded.",
    );
    expect(button("Start handover")?.disabled).toBe(true);
    expect(screen.getByText("Needs a connection.")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start handover" })));
    expect(app.commands.create).not.toHaveBeenCalled();
    expect(screen.getByText("CR-0001, batch 1 of 1")).toBeTruthy();

    harness.setOnline(true);
    expect((await enabled("Start handover")).disabled).toBe(false);
    expect(screen.queryByText(/^Offline\./)).toBeNull();
    expect(screen.getByText("CR-0001, batch 1 of 1")).toBeTruthy();
  });
});
