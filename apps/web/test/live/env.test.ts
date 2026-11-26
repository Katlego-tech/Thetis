import { afterEach, expect, test, vi } from "vitest";
import { liveEnv } from "@/data/live/load";
import { dataSource } from "@/data/load-reader";
import { PROGRAM_ID, PROTOCOL } from "./snapshot";

const valid = {
  THETIS_NETWORK: "devnet",
  THETIS_PROGRAM_ID: PROGRAM_ID,
  THETIS_PROTOCOL: PROTOCOL,
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-anon-key",
} as const;
type Variable = keyof typeof valid;

function environment(changes: Partial<Record<Variable, string | undefined>> = {}) {
  for (const [name, value] of Object.entries({ ...valid, ...changes })) {
    vi.stubEnv(name, value);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

test("liveEnv refuses each wrong or missing variable, naming it", () => {
  environment();
  expect(liveEnv()).toEqual({ network: "devnet", programId: PROGRAM_ID, protocol: PROTOCOL });

  const refusals: [Variable, string | undefined][] = [
    ["THETIS_NETWORK", undefined],
    ["THETIS_NETWORK", "mainnet-beta"],
    ["THETIS_NETWORK", "Devnet"],
    ["THETIS_PROGRAM_ID", undefined],
    ["THETIS_PROGRAM_ID", "11111111111111111111111111111111"],
    ["THETIS_PROTOCOL", undefined],
    ["THETIS_PROTOCOL", ""],
    ["THETIS_PROTOCOL", "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"],
    ["THETIS_PROTOCOL", "2"],
    ["THETIS_PROTOCOL", `${PROTOCOL}1`],
    ["NEXT_PUBLIC_SUPABASE_URL", undefined],
    ["NEXT_PUBLIC_SUPABASE_URL", ""],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", undefined],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", ""],
  ];
  for (const [name, value] of refusals) {
    vi.unstubAllEnvs();
    environment({ [name]: value });
    expect(liveEnv, `${name}=${String(value)}`).toThrow(
      expect.objectContaining({ code: "CONFIG", path: name }),
    );
  }

  // Checked in the stated order: the first wrong variable is the one named.
  vi.unstubAllEnvs();
  environment({ THETIS_PROTOCOL: "x", NEXT_PUBLIC_SUPABASE_URL: "", THETIS_PROGRAM_ID: "y" });
  expect(liveEnv).toThrow(expect.objectContaining({ code: "CONFIG", path: "THETIS_PROGRAM_ID" }));
});

test("THETIS_DATA_SOURCE is reference when unset or empty, live when live, and refused otherwise", () => {
  vi.stubEnv("THETIS_DATA_SOURCE", undefined);
  expect(dataSource()).toBe("reference");
  vi.stubEnv("THETIS_DATA_SOURCE", "");
  expect(dataSource()).toBe("reference");
  vi.stubEnv("THETIS_DATA_SOURCE", "reference");
  expect(dataSource()).toBe("reference");
  vi.stubEnv("THETIS_DATA_SOURCE", "live");
  expect(dataSource()).toBe("live");
  for (const value of ["Live", "fixture", " live"]) {
    vi.stubEnv("THETIS_DATA_SOURCE", value);
    expect(dataSource).toThrow(
      expect.objectContaining({ code: "CONFIG", path: "THETIS_DATA_SOURCE" }),
    );
  }
});
