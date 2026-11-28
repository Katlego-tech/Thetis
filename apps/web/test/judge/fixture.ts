import type { ConfiguredJudgeView, JudgeTransaction } from "@/data/judge/read";

// SYNTHETIC: every address, signature, slot and time below is made up for these tests; only the
// program id is the real devnet program. Names, quantities and amounts are demo.md's synthetic cast.

export const PROGRAM = "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3";
export const PROTOCOL = "6QWeT6FpJrm8AF1btu6WH2k2Xhq6t5vbheKVfQavmenJ";
export const ORG = {
  khunou: "6URwbPipuA4MJLG7LCRRZuWnms3JZ9cRG3z9indXWz6z",
  kopano: "6YMEjhBqVTMaSRWcmVkLrnHZ22FWEDJEpTeonAg8GKRg",
  mosela: "6cGXszer5keoaWm8Co5G9f4KGBThuGz4NsKTqYij1ekN",
  port: "6gBq2J7rg3x2ic1de6QBSXq5WLfuaLfswGz7tvmKkz54",
  lender1: "6k78AbasGMFFrhG95Pj6jQbqkVt7FQMhVgemxJovWKPk",
} as const;
const UNNAMED = "G9GNDdbYKQY14xv1xgNw1D6EY8SFnZxgHrDBdEbHsoo3";
export const LOAN = "7VDNjuhymdWkPh1isgKCw36ESFCKf6uieAyzbVJWiywL";
export const LOCK = "7Z8ftDAzMvoyXnGEJye8DurzgQQXLAbYCaeeesM7UKG2";
export const INTAKE = "71nJjoSudYSAR4GApb2mtugtj8iuwf6yjKKQBpzKVegW";

export function sig(n: number): string {
  return `${n}`.padStart(2, "1").replace(/0/g, "z") + "5".repeat(84);
}

function tx(
  n: number,
  slot: number,
  events: [string, string, Record<string, unknown>][],
  commitment: "confirmed" | "finalized" = "confirmed",
): JudgeTransaction {
  return {
    signature: sig(n),
    slot,
    blockTime: new Date(Date.UTC(2026, 10, 28) + slot * 1000).toISOString(),
    commitment,
    events: events.map(([instruction, event, data], index) => ({
      index,
      instruction,
      event,
      data,
    })),
  };
}

export function loadedView(): ConfiguredJudgeView {
  return {
    configured: true,
    streamMatches: true,
    network: "devnet",
    programId: PROGRAM,
    protocol: PROTOCOL,
    instanceLabel: "fiat-demo-run-07",
    expectedTransactions: 9,
    expectedRefusals: 2,
    checkpoint: {
      status: "live",
      indexedThroughSlot: 900,
      lastSuccessAt: "2026-11-28T00:15:00.000Z",
      haltReason: null,
      haltedAt: null,
    },
    organisations: [
      { address: ORG.khunou, displayName: "Khunou Ore Exports", role: "Exporter", synthetic: true },
      {
        address: ORG.kopano,
        displayName: "Kopano Stockyard Custody",
        role: "Custodian",
        synthetic: true,
      },
      { address: ORG.mosela, displayName: "Mosela Haulage", role: "Transporter", synthetic: true },
      { address: ORG.port, displayName: "Port Terminal T1", role: "Terminal", synthetic: true },
      { address: ORG.lender1, displayName: "Lender One Bank", role: "Lender", synthetic: null },
    ],
    // Out of order on purpose: steps sort by (slot, signature).
    transactions: [
      tx(5, 500, [
        [
          "Handover",
          "CustodyHandedOver",
          {
            from: ORG.kopano,
            to: ORG.mosela,
            quantityKg: "5000000",
            stage: "Departure",
            lotState: "InTransit",
          },
        ],
      ]),
      tx(1, 100, [
        [
          "AccreditOrganisation",
          "OrganisationAccredited",
          { organisation: ORG.khunou, role: "Exporter" },
        ],
      ]),
      tx(2, 110, [
        [
          "OpenFacility",
          "FacilityOpened",
          {
            lender: ORG.lender1,
            borrower: ORG.khunou,
            currency: "555344",
            currencyDecimals: 2,
            rateBps: 1200,
            maxLtvBps: 6000,
          },
        ],
      ]),
      tx(3, 200, [
        ["IssueLot", "LotIssued", { owner: ORG.khunou, quantityKg: "5000000", intake: INTAKE }],
      ]),
      tx(4, 300, [["Pledge", "Pledged", { loan: LOAN, lock: LOCK, quantityKg: "5000000" }]]),
      tx(6, 310, [
        ["RecordAdvance", "AdvanceRecorded", { amount: "60000000", principal: "60000000" }],
      ]),
      tx(
        7,
        600,
        [
          [
            "RecordObservation",
            "ObservationRecorded",
            { observer: ORG.mosela, holder: ORG.mosela, kind: "Border", locationCode: "BORDER-1" },
          ],
        ],
        "finalized",
      ),
      tx(8, 800, [
        [
          "RecordLoading",
          "LoadingRecorded",
          { owner: ORG.khunou, terminal: ORG.port, quantityKg: "3000500", lotLoaded: true },
        ],
        ["RecordLoading", "LoanHandedOff", { externalHandoff: true, principal: "20000000" }],
      ]),
      tx(9, 850, [
        ["SetRestriction", "RestrictionSet", { from: "Normal", to: "Frozen", owner: UNNAMED }],
      ]),
    ],
    refusals: [
      {
        beat: "refused_driver",
        signature: sig(12),
        slot: 500,
        blockTime: "2026-11-28T00:08:20.000Z",
        commitment: "confirmed",
        errorName: "Anchor3012",
      },
      {
        beat: "second_lender",
        signature: sig(11),
        slot: 305,
        blockTime: "2026-11-28T00:05:05.000Z",
        commitment: "confirmed",
        errorName: "InsufficientAvailable",
      },
    ],
  };
}
