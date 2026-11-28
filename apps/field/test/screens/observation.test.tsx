// @vitest-environment jsdom
import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import * as ImagePicker from "expo-image-picker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api/client";
import type { CommandView } from "../../src/api/commands";
import type { FieldBatch } from "../../src/api/field";
import type { AppContextValue } from "../../src/context";
import type { ObservationDraft } from "../../src/drafts/store";
import { Observation } from "../../src/screens/Observation";
import {
  BATCH_ADDRESS,
  CAPTURED_AT,
  fieldBatch,
  MOSELA_CHAIN,
  MOSELA_ORG,
  NOW_UNIX,
  OBSERVATION_ID,
  OBSERVED_AT,
  observationDraft,
  observationText,
  observationView,
  PHOTO_SHA,
  PHOTO_VERSION_ID,
  photo,
  SIGN_BEFORE,
} from "../custody-fixtures";
import { PROTOCOL } from "../fixtures";
import { renderScreen, USER, WALLET } from "./app";
import { button, cannotPress, enabled, installWallet, phone, SIGNATURE } from "./custody-app";

vi.mock("react-native", async () => (await import("./native")).reactNative);
vi.mock("react-native-safe-area-context", async () => (await import("./native")).safeArea);
vi.mock("@solana-mobile/mobile-wallet-adapter-protocol", () => ({ transact: vi.fn() }));
vi.mock("../../src/supabase", () => ({ SupabaseTimeout: class extends Error {} }));
vi.mock("expo-crypto", async () => ({ randomUUID: (await import("node:crypto")).randomUUID }));
vi.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: vi.fn(),
  launchCameraAsync: vi.fn(),
}));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-file-system", () => {
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === "string" ? p : p.uri)).join("/");
    }
    get exists() {
      return true;
    }
    get size() {
      return 1_234;
    }
    copy() {}
    delete() {}
  }
  class Directory extends File {
    create() {}
  }
  return { File, Directory, Paths: { document: "file:///data" } };
});
const insertObject = vi.fn(async (_row: Record<string, unknown>) => {});
const insertVersion = vi.fn(async (_row: Record<string, unknown>) => {});
vi.mock("../../src/evidence/deps", () => ({
  uploadDeps: () => ({
    newId: () => crypto.randomUUID(),
    insertObject,
    insertVersion,
    selectVersion: vi.fn(async () => null),
    upload: vi.fn(async () => {}),
    finalize: vi.fn(async (versionId: string) => ({
      versionId,
      sha256: "b3a5c1d7".padEnd(64, "0"),
      sizeBytes: 1_234,
    })),
  }),
}));
vi.mock("../../src/data/reads", async (importOriginal) =>
  (await import("../custody-fixtures")).custodyReads(
    await importOriginal<typeof import("../../src/data/reads")>(),
  ),
);

let signMessages: ReturnType<typeof installWallet>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Number(NOW_UNIX) * 1_000);
  signMessages = installWallet();
  insertObject.mockClear();
  insertVersion.mockClear();
  vi.mocked(ImagePicker.requestCameraPermissionsAsync).mockReset();
  vi.mocked(ImagePicker.launchCameraAsync).mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const HELD = fieldBatch({ holder: MOSELA_CHAIN, holderName: "Mosela Haulage", stage: "InTransit" });
const PHOTO_WORDS = "Border photo";
const CONFIRMS =
  "Mosela Haulage reports that batch 1 of 1 of CR-0001 was at BORDER-1 at 11:11:05 SAST. It does not hand over custody or record the load's condition.";
const LOCATION_MESSAGE = "Use 1 to 16 capital letters, digits or hyphens, for example BORDER-1.";

async function openObservation(
  options: {
    draft?: ObservationDraft;
    /** What the relay answers when the screen reads the command the draft holds. */
    view?: CommandView;
    batches?: FieldBatch[];
    online?: boolean;
  } = {},
) {
  const app = phone("mosela", { online: options.online ?? true });
  vi.mocked(app.field.batches).mockResolvedValue(options.batches ?? [HELD]);
  if (options.view) vi.mocked(app.commands.get).mockResolvedValue(options.view);
  if (options.draft) await app.store.saveObservation(options.draft);
  const harness = await renderScreen(<Observation />, app);
  return { app, harness };
}

const storedDraft = (app: AppContextValue) => app.store.observation(USER, MOSELA_ORG);

const location = () => screen.getByRole("textbox", { name: "Location code" }) as HTMLInputElement;
const typeLocation = async (value: string) =>
  act(async () => fireEvent.change(location(), { target: { value } }));
const press = async (name: string) => act(async () => fireEvent.click(await enabled(name)));

describe("Border crossing: the batch", () => {
  it("no batches held: says there is nothing to record a crossing for", async () => {
    await openObservation({ batches: [] });
    await screen.findByText(
      "Mosela Haulage holds no batch right now, so there is nothing to record a crossing for.",
    );
    expect(button("Prepare text")?.disabled ?? true).toBe(true);
  });

  it("a batch held by someone else is not offered", async () => {
    await openObservation({ batches: [fieldBatch()] });
    await screen.findByText(/holds no batch right now/);
  });

  it("one held batch is preselected: the lot, which batch, the quantity and who holds it", async () => {
    const { app } = await openObservation();
    await screen.findByText("Border crossing");
    expect(await screen.findByText("CR-0001, batch 1 of 1")).toBeTruthy();
    expect(screen.getByText("5,000.000 t, held by Mosela Haulage")).toBeTruthy();
    expect(button("Batch: Choose")).toBeNull();
    expect(app.field.batches).toHaveBeenCalledWith(MOSELA_ORG);
  });

  it("several held batches are chosen from, with none preselected", async () => {
    await openObservation({
      batches: [HELD, fieldBatch({ ...HELD, batch: MOSELA_CHAIN, lotId: "CR-0002" })],
    });
    await screen.findByRole("button", { name: "Batch: Choose" });
    expect(screen.queryByText("CR-0001, batch 1 of 1")).toBeNull();
  });
});

describe("Border crossing: the location code", () => {
  it("states what the code is, and upper-cases what is typed", async () => {
    await openObservation();
    await screen.findByText("The code on the border post or your route sheet.");
    await typeLocation("border-1");
    expect(location().value).toBe("BORDER-1");
    expect(screen.queryByText(LOCATION_MESSAGE)).toBeNull();
  });

  it("location code not usable: says how to write it, and Prepare text waits", async () => {
    await openObservation({ draft: observationDraft(USER, PROTOCOL, { locationCode: "" }) });
    await screen.findByText("CR-0001, batch 1 of 1");
    await typeLocation("Border 1");
    await screen.findByText(LOCATION_MESSAGE);
    expect(location().value).toBe("BORDER 1");
    expect(cannotPress("Prepare text")).toBe(true);
    expect(screen.getByText("Fix Location code first.")).toBeTruthy();
  });

  it("a code of 17 characters is not usable either", async () => {
    await openObservation({ draft: observationDraft(USER, PROTOCOL, { locationCode: "" }) });
    await screen.findByText("CR-0001, batch 1 of 1");
    await typeLocation("A".repeat(17));
    await screen.findByText(LOCATION_MESSAGE);
    expect(cannotPress("Prepare text")).toBe(true);
  });

  it("the location is kept on the phone", async () => {
    const { app } = await openObservation();
    await screen.findByText("CR-0001, batch 1 of 1");
    await typeLocation("border-1");
    await waitFor(async () => expect((await storedDraft(app))?.locationCode).toBe("BORDER-1"));
    expect((await storedDraft(app))?.protocol).toBe(PROTOCOL);
  });

  it("a draft of another run is discarded, and a new one made", async () => {
    await openObservation({
      draft: observationDraft(USER, "11111111111111111111111111111111", {
        locationCode: "OLD-1",
        evidence: photo(),
      }),
    });
    await screen.findByText("CR-0001, batch 1 of 1");
    expect(location().value).toBe("");
    expect(screen.queryByText(/OLD-1/)).toBeNull();
    expect(screen.getByText("Required. Not taken.")).toBeTruthy();
  });
});

describe("Border crossing: the photo", () => {
  it("no photo yet: Required, Take photo, and Prepare text says the photo is not uploaded", async () => {
    await openObservation({ draft: observationDraft(USER, PROTOCOL, { evidence: null }) });
    await screen.findByText("Required. Not taken.");
    expect(screen.getByText(PHOTO_WORDS)).toBeTruthy();
    expect(button("Take photo")).not.toBeNull();
    expect(button("Choose file")).toBeNull();
    expect(cannotPress("Prepare text")).toBe(true);
    expect(screen.getByText("Border photo not uploaded yet.")).toBeTruthy();
  });

  it("camera permission denied: says an observation needs a photo, and opens no camera", async () => {
    vi.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValue({
      granted: false,
    } as never);
    await openObservation({ draft: observationDraft(USER, PROTOCOL, { evidence: null }) });
    await act(async () => fireEvent.click(await enabled("Take photo")));
    await screen.findByText(
      "An observation needs a photo. Allow the camera in Android settings to record a border crossing.",
    );
    expect(ImagePicker.launchCameraAsync).not.toHaveBeenCalled();
    expect(cannotPress("Prepare text")).toBe(true);
  });

  it("takes the photo, uploads it for this batch as transport evidence, and shows its digest", async () => {
    vi.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValue({
      granted: true,
    } as never);
    vi.mocked(ImagePicker.launchCameraAsync).mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///cache/border.jpg", mimeType: "image/jpeg" }],
    } as never);
    await openObservation({ draft: observationDraft(USER, PROTOCOL, { evidence: null }) });
    await act(async () => fireEvent.click(await enabled("Take photo")));
    await screen.findByText("Taken 12:00:00 SAST. Uploaded. SHA-256 b3a5c1d7");
    expect(ImagePicker.launchCameraAsync).toHaveBeenCalledWith({
      mediaTypes: ["images"],
      quality: 0.8,
    });
    expect(insertObject).toHaveBeenCalledOnce();
    expect(insertObject.mock.calls[0]?.[0]).toMatchObject({
      owner_organisation_id: MOSELA_ORG,
      subject_kind: "batch",
      subject_ref: BATCH_ADDRESS,
      purpose: "transport",
      created_by: USER,
    });
    expect(button("Retake")).not.toBeNull();
    expect(button("Take photo")).toBeNull();
    expect((await enabled("Prepare text")).disabled).toBe(false);
  });

  it("a photo that was taken and uploaded shows when, and its digest", async () => {
    await openObservation({ draft: observationDraft(USER, PROTOCOL) });
    await screen.findByText("Taken 11:11:05 SAST. Uploaded. SHA-256 b3a5c1d7");
    expect(button("Retake")).not.toBeNull();
  });

  it("photo upload failed: says it is still on the phone, and Retry uploads it", async () => {
    await openObservation({
      draft: observationDraft(USER, PROTOCOL, {
        evidence: photo({ upload: "failed", sha256: null, error: "network" }),
      }),
    });
    await screen.findByText("Upload failed. Your photo is still on this phone.");
    expect(cannotPress("Prepare text")).toBe(true);
    expect(screen.getByText("Border photo not uploaded yet.")).toBeTruthy();
    await act(async () => fireEvent.click(await enabled("Retry")));
    await screen.findByText("Taken 11:11:05 SAST. Uploaded. SHA-256 b3a5c1d7");
    expect((await enabled("Prepare text")).disabled).toBe(false);
  });

  it("file rejected: says the stored file did not match, and Retry uploads a new version", async () => {
    await openObservation({
      draft: observationDraft(USER, PROTOCOL, {
        evidence: photo({ upload: "rejected", sha256: null }),
      }),
    });
    await screen.findByText(
      "The stored file did not match what was sent. Retry uploads a new version.",
    );
    expect(cannotPress("Prepare text")).toBe(true);
    await act(async () => fireEvent.click(await enabled("Retry")));
    await screen.findByText("Taken 11:11:05 SAST. Uploaded. SHA-256 b3a5c1d7");
    expect(insertVersion).toHaveBeenCalledOnce();
    expect(insertVersion.mock.calls[0]?.[0]).toMatchObject({
      object_id: photo().objectId,
      version: 2,
      supersedes_id: PHOTO_VERSION_ID,
    });
  });
});

describe("Prepare text", () => {
  it("what this signature confirms, and that custody does not change", async () => {
    await openObservation({ draft: observationDraft(USER, PROTOCOL) });
    await screen.findByText("What this signature confirms");
    expect(screen.getByText(CONFIRMS)).toBeTruthy();
    expect(
      screen.getByText(
        "This records where the load was. Mosela Haulage still holds it afterwards; no one else signs.",
      ),
    ).toBeTruthy();
  });

  it("prepares the observation from the photo's capture time, and keeps the command on the phone", async () => {
    const { app } = await openObservation({ draft: observationDraft(USER, PROTOCOL) });
    vi.mocked(app.commands.create).mockResolvedValue(observationView("awaiting_signatures"));
    await press("Prepare text");
    await waitFor(() => expect(app.commands.create).toHaveBeenCalledOnce());
    expect(app.commands.create).toHaveBeenCalledWith({
      kind: "record_observation",
      organisationId: MOSELA_ORG,
      args: {
        batch: BATCH_ADDRESS,
        kind: "Border",
        locationCode: "BORDER-1",
        evidenceVersionId: PHOTO_VERSION_ID,
        observedAt: String(OBSERVED_AT),
      },
    });
    expect(OBSERVED_AT).toBe(BigInt(Math.floor(Date.parse(CAPTURED_AT) / 1_000)));
    await enabled("Sign in your wallet");
    await waitFor(async () =>
      expect((await storedDraft(app))?.command?.commandId).toBe(OBSERVATION_ID),
    );
  });

  it("a typed location and a fresh photo prepare the same arguments", async () => {
    vi.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValue({
      granted: true,
    } as never);
    vi.mocked(ImagePicker.launchCameraAsync).mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///cache/border.jpg", mimeType: "image/jpeg" }],
    } as never);
    const { app } = await openObservation();
    vi.mocked(app.commands.create).mockResolvedValue(observationView("awaiting_signatures"));
    await screen.findByText("CR-0001, batch 1 of 1");
    await typeLocation("border-1");
    await act(async () => fireEvent.click(await enabled("Take photo")));
    await screen.findByText(/^Taken 12:00:00 SAST\. Uploaded\./);
    await press("Prepare text");
    await waitFor(() => expect(app.commands.create).toHaveBeenCalledOnce());
    expect(app.commands.create).toHaveBeenCalledWith({
      kind: "record_observation",
      organisationId: MOSELA_ORG,
      args: {
        batch: BATCH_ADDRESS,
        kind: "Border",
        locationCode: "BORDER-1",
        evidenceVersionId: expect.any(String),
        observedAt: String(NOW_UNIX),
      },
    });
  });

  it("phone clock ahead of devnet: says to set the clock to automatic and retake the photo", async () => {
    const { app } = await openObservation({ draft: observationDraft(USER, PROTOCOL) });
    vi.mocked(app.commands.create).mockRejectedValue(
      new ApiError(422, "VALIDATION", "", "observedAt"),
    );
    await press("Prepare text");
    await screen.findByText(
      "This phone's clock is ahead of devnet's. Set the phone's time to automatic, retake the photo, and try again.",
    );
    expect(button("Sign in your wallet")).toBeNull();
  });

  it("photo not usable: the relay refuses the evidence, so the photo is marked rejected", async () => {
    const { app } = await openObservation({ draft: observationDraft(USER, PROTOCOL) });
    vi.mocked(app.commands.create).mockRejectedValue(
      new ApiError(409, "EVIDENCE_INVALID", "", "transport photo of this batch"),
    );
    await press("Prepare text");
    await screen.findByText(
      "The photo must be of this batch, taken by your organisation. Retake it and try again. Nothing was sent.",
    );
    expect(
      screen.queryByText("One of the files is not stored for this record. Upload it again."),
    ).toBeNull();
    await screen.findByText(
      "The stored file did not match what was sent. Retry uploads a new version.",
    );
    expect(button("Retry")).not.toBeNull();
    expect(cannotPress("Prepare text")).toBe(true);
    expect(app.commands.create).toHaveBeenCalledOnce();
  });

  it("an organisation that cannot observe is told so", async () => {
    const { app } = await openObservation({ draft: observationDraft(USER, PROTOCOL) });
    vi.mocked(app.commands.create).mockRejectedValue(new ApiError(403, "NOT_AUTHORISED", "", null));
    await press("Prepare text");
    await screen.findByText(
      "Mosela Haulage can't record observations. Only a custodian, a transporter, a terminal or an inspector can. Nothing was sent.",
    );
  });

  it("a draft that holds a command opens it instead of preparing again", async () => {
    const draft = observationDraft(USER, PROTOCOL, {
      command: {
        commandId: OBSERVATION_ID,
        lastStatus: "awaiting_signatures",
        textVersion: 1,
        transactionSignature: null,
        lot: null,
        explorerUrl: null,
        commitment: null,
      },
    });
    const { app } = await openObservation({ draft, view: observationView("awaiting_signatures") });
    await enabled("Sign in your wallet");
    expect(app.commands.get).toHaveBeenCalledWith(OBSERVATION_ID);
    expect(app.commands.create).not.toHaveBeenCalled();
    expect(button("Prepare text")).toBeNull();
  });
});

describe("Sign and record", () => {
  async function prepared(view = observationView("awaiting_signatures")) {
    const opened = await openObservation({ draft: observationDraft(USER, PROTOCOL) });
    vi.mocked(opened.app.commands.create).mockResolvedValue(view);
    vi.mocked(opened.app.commands.get).mockResolvedValue(view);
    await press("Prepare text");
    await waitFor(() => expect(button("Prepare text")).toBeNull());
    return opened;
  }

  it("shows the exact text and that it matches what was entered", async () => {
    const view = observationView("awaiting_signatures");
    await prepared(view);
    await enabled("Sign in your wallet");
    expect(document.body.textContent).toContain("Action: Record observation");
    expect(document.body.textContent).toContain("Location: BORDER-1");
    expect(screen.getByText("Matches what you entered: yes")).toBeTruthy();
    const bytes = Buffer.from(view.text?.messageBase64 ?? "", "base64").length;
    const sha = view.text?.messageSha256.slice(0, 8);
    expect(
      screen.getByText(`${bytes} bytes, UTF-8. SHA-256 ${sha}. Sign before ${SIGN_BEFORE}.`),
    ).toBeTruthy();
  });

  it("signs as observer with the exact SHA-256", async () => {
    const view = observationView("awaiting_signatures");
    const { app } = await prepared(view);
    vi.mocked(app.commands.sign).mockResolvedValue(observationView("submitted"));
    await press("Sign in your wallet");
    await waitFor(() => expect(app.commands.sign).toHaveBeenCalledOnce());
    expect(app.commands.sign).toHaveBeenCalledWith(OBSERVATION_ID, {
      role: "observer",
      wallet: WALLET,
      messageSha256: view.text?.messageSha256,
      signature: SIGNATURE,
    });
    expect(signMessages).toHaveBeenCalledOnce();
    await screen.findByText("Thetis sent the observation to devnet. Waiting for confirmation.");
  });

  it.each([
    ["Location", "BORDER-2", "Line 12, Location"],
    ["Evidence", "78".repeat(32), "Line 13, Evidence"],
    ["Holder", "Someone Else", "Line 9, Holder"],
  ])("a text whose %s differs never opens the wallet", async (label, value, line) => {
    const { app } = await prepared(
      observationView("awaiting_signatures", { text: observationText({ [label]: value }) }),
    );
    await screen.findByText(line);
    expect(screen.getByText(`Received ${value}`)).toBeTruthy();
    expect(cannotPress("Sign in your wallet")).toBe(true);
    expect(transact).not.toHaveBeenCalled();
    expect(app.commands.sign).not.toHaveBeenCalled();
  });

  it("Recorded: the border crossing, and who still holds the batch", async () => {
    const { app } = await prepared();
    vi.mocked(app.commands.sign).mockResolvedValue(observationView("confirmed"));
    await press("Sign in your wallet");
    await screen.findByText("Border crossing recorded");
    expect(
      screen.getByText(
        "Border crossing recorded for batch 1 of 1. Mosela Haulage still holds it. Confirmed on devnet in slot 526,890,114.",
      ),
    ).toBeTruthy();
    expect(screen.getAllByText("Confirmed").length).toBeGreaterThan(0);
    await act(async () => fireEvent.click(await enabled("Back to home")));
    expect(app.navigate).toHaveBeenCalledWith({ name: "home" });
    await waitFor(async () => expect(await storedDraft(app)).toBeNull());
  });

  it("another observation landed first: Edit details clears the command and keeps location and photo", async () => {
    const { app } = await prepared();
    vi.mocked(app.commands.sign).mockResolvedValue(
      observationView("failed", { error: { code: "StaleRevision", detail: null } }),
    );
    await press("Sign in your wallet");
    await screen.findByText(
      "Another observation of this batch was recorded first. Prepare the text again.",
    );
    expect(screen.getByText("Refused by the Thetis program: StaleRevision")).toBeTruthy();
    await act(async () => fireEvent.click(await enabled("Edit details")));
    await enabled("Prepare text");
    expect(location().value).toBe("BORDER-1");
    expect(screen.getByText("Taken 11:11:05 SAST. Uploaded. SHA-256 b3a5c1d7")).toBeTruthy();
    const kept = await storedDraft(app);
    expect(kept?.command).toBeNull();
    expect(kept?.locationCode).toBe("BORDER-1");
    expect(kept?.evidence?.sha256).toBe(PHOTO_SHA);
  });

  it("expired before signing: the observer may prepare a new text", async () => {
    const draft = observationDraft(USER, PROTOCOL, {
      command: {
        commandId: OBSERVATION_ID,
        lastStatus: "awaiting_signatures",
        textVersion: 1,
        transactionSignature: null,
        lot: null,
        explorerUrl: null,
        commitment: null,
      },
    });
    const { app } = await openObservation({ draft, view: observationView("expired") });
    await screen.findByText(`This text expired at ${SIGN_BEFORE}. Nothing was sent.`);
    vi.mocked(app.commands.renew).mockResolvedValue(observationView("awaiting_signatures"));
    await press("Prepare a new text");
    await waitFor(() => expect(app.commands.renew).toHaveBeenCalledWith(OBSERVATION_ID));
    await enabled("Sign in your wallet");
    expect(app.commands.create).not.toHaveBeenCalled();
  });
});

describe("Offline", () => {
  it("says the photo is saved on the phone and nothing is recorded until online, and keeps the draft", async () => {
    const { app, harness } = await openObservation({
      draft: observationDraft(USER, PROTOCOL),
    });
    await screen.findByText("CR-0001, batch 1 of 1");
    harness.setOnline(false);
    await screen.findByText(
      "Offline. Your photo is saved on this phone. Nothing is recorded until you sign online.",
    );
    expect(cannotPress("Prepare text")).toBe(true);
    expect(screen.getByText("Needs a connection.")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Prepare text" })));
    expect(app.commands.create).not.toHaveBeenCalled();
    expect(location().value).toBe("BORDER-1");
    expect((await storedDraft(app))?.locationCode).toBe("BORDER-1");

    harness.setOnline(true);
    expect((await enabled("Prepare text")).disabled).toBe(false);
  });
});
