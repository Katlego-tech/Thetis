// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newDraft } from "../../src/drafts/store";
import { Intake } from "../../src/screens/Intake";
import { KOPANO_ORG, PROTOCOL } from "../fixtures";
import { fakeApp, renderScreen, USER } from "./app";

vi.mock("react-native", async () => (await import("./native")).reactNative);
vi.mock("react-native-safe-area-context", async () => (await import("./native")).safeArea);
vi.mock("@solana-mobile/mobile-wallet-adapter-protocol", () => ({ transact: vi.fn() }));
vi.mock("../../src/supabase", () => ({ SupabaseTimeout: class extends Error {} }));
vi.mock("expo-crypto", async () => ({ randomUUID: (await import("node:crypto")).randomUUID }));
vi.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: vi.fn(async () => ({ granted: false })),
  launchCameraAsync: vi.fn(),
}));
vi.mock("expo-document-picker", () => ({
  getDocumentAsync: vi.fn(async () => ({
    canceled: false,
    assets: [{ uri: "file:///cache/ticket.jpg", mimeType: "image/jpeg", size: 1_234 }],
  })),
}));
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
const insertObject = vi.fn(async (_row: { subject_ref: string }) => {});
vi.mock("../../src/evidence/deps", () => ({
  uploadDeps: () => ({
    newId: () => crypto.randomUUID(),
    insertObject,
    insertVersion: vi.fn(async () => {}),
    selectVersion: vi.fn(async () => null),
    upload: vi.fn(async () => {}),
    finalize: vi.fn(async (versionId: string) => ({
      versionId,
      sha256: "7e8533c2".padEnd(64, "0"),
      sizeBytes: 1_234,
    })),
  }),
}));
vi.mock("../../src/data/reads", async (importOriginal) => {
  const { chainOrganisation, owner, site } = await import("./app");
  return {
    ...(await importOriginal<typeof import("../../src/data/reads")>()),
    readSites: vi.fn(async () => [site]),
    readOwners: vi.fn(async () => [owner]),
    readChainOrganisation: vi.fn(async () => chainOrganisation),
    readSignerLinks: vi.fn(async () => []),
    readAuthority: vi.fn(async () => null),
    readIssuedIntake: vi.fn(async () => null),
    readLotIdUsed: vi.fn(async () => false),
  };
});

afterEach(cleanup);

describe("the lot id is committed before any upload (F4)", () => {
  it("registers subject_ref CR-0001 once, for a file attached before the id was typed", async () => {
    const app = fakeApp();
    const now = "2026-11-27T08:04:30.000Z";
    await app.store.save(
      newDraft({ id: "d-1", userId: USER, organisationId: KOPANO_ORG, protocol: PROTOCOL, now }),
    );
    await renderScreen(<Intake draftId="d-1" />, app);

    const choose = await screen.findAllByRole("button", { name: "Choose file" });
    await act(async () => fireEvent.click(choose[0] as HTMLElement));
    await screen.findAllByRole("button", { name: "Choose file" });

    const lotId = screen.getByRole("textbox", { name: "Lot ID" });
    let typed = "";
    for (const character of "CR-0001") {
      typed += character;
      await act(async () => fireEvent.change(lotId, { target: { value: typed } }));
    }
    expect(insertObject).not.toHaveBeenCalled();

    await act(async () => fireEvent.blur(lotId));
    await waitFor(() => expect(insertObject).toHaveBeenCalledTimes(1));
    expect(insertObject.mock.calls[0]?.[0].subject_ref).toBe("CR-0001");
  });
});
