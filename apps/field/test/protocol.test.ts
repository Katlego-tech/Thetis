import { describe, expect, it } from "vitest";
import { instanceLabel, isSameProtocol, resolveProtocol } from "../src/protocol";
import { commandView, PROGRAM, PROTOCOL } from "./fixtures";

const checkpoint = {
  protocol: PROTOCOL,
  status: "live",
  indexed_through_slot: 526_890_200,
  last_success_at: "2026-11-27T08:02:00.000Z",
  halt_reason: null,
};
const protocolRow = {
  instance_id_hex: "666961742d64656d6f2d72756e2d3031",
  settlement_mode: "FiatAttestationTest",
};

describe("resolveProtocol", () => {
  it("zero checkpoint rows is No Thetis instance", () => {
    expect(resolveProtocol([], null)).toStrictEqual({ kind: "none" });
  });

  it("two checkpoint rows is No Thetis instance", () => {
    expect(
      resolveProtocol([checkpoint, { ...checkpoint, protocol: PROGRAM }], protocolRow),
    ).toStrictEqual({ kind: "none" });
  });

  it("one row with no chain_protocols row is No Thetis instance", () => {
    expect(resolveProtocol([checkpoint], null)).toStrictEqual({ kind: "none" });
  });

  it("one row fills the context and decodes the label", () => {
    expect(resolveProtocol([checkpoint], protocolRow)).toStrictEqual({
      kind: "ready",
      context: {
        protocol: PROTOCOL,
        instanceIdHex: "666961742d64656d6f2d72756e2d3031",
        instanceLabel: "fiat-demo-run-01",
        settlementMode: "FiatAttestationTest",
        indexStatus: "live",
        lastSuccessAt: "2026-11-27T08:02:00.000Z",
      },
    });
  });
});

describe("instanceLabel", () => {
  it("is the hex when a byte is not printable", () => {
    expect(instanceLabel("00112233445566778899aabbccddeeff")).toBe(
      "00112233445566778899aabbccddeeff",
    );
  });
});

describe("a command for another protocol", () => {
  it("is refused before the wallet opens", () => {
    const context = { protocol: PROTOCOL } as const;
    expect(isSameProtocol(commandView("awaiting_signatures"), context)).toBe(true);
    expect(isSameProtocol(commandView("awaiting_signatures", { protocol: PROGRAM }), context)).toBe(
      false,
    );
  });
});
