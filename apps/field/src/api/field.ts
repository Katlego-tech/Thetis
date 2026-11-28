// The two read routes the custody screens use: the batches a holder can act on and the loading
// intents open at a terminal. Parsed as strictly as the command routes: unknown or missing keys,
// numbers where a decimal string is promised, and addresses of the wrong shape are all refused.
import {
  ADDRESS,
  array,
  DECIMAL,
  HEX64,
  type Json,
  oneOf,
  record,
  ShapeError,
  string,
} from "../lib/shape";
import { type ApiClient, TIMEOUTS } from "./client";

export type BatchStage = "AtSource" | "InTransit" | "Arrived";
const STAGES = ["AtSource", "InTransit", "Arrived"] as const;

export interface FieldBatch {
  batch: string;
  shipment: string;
  lot: string;
  lotId: string;
  index: number;
  batchCount: number;
  quantityKg: string;
  stage: BatchStage;
  holder: string;
  holderName: string;
  carrier: string;
  carrierName: string;
  destinationCustodian: string;
  destinationName: string;
  observationCount: number;
  sequence: string;
}

export type AcceptanceState = "accepted" | "missing" | "stale";
const ACCEPTANCE_STATES = ["accepted", "missing", "stale"] as const;

export interface LoadingAcceptance {
  lender: string;
  lenderName: string;
  loan: string;
  lockKg: string;
  state: AcceptanceState;
}

export interface LoadingIntent {
  intent: string;
  lot: string;
  lotId: string;
  quantityKg: string;
  lockedKg: string;
  owner: string;
  ownerName: string;
  terminalName: string;
  documentSha256: string;
  nonce: string;
  expiresAt: string;
  acceptances: LoadingAcceptance[];
}

const LOT_ID = /^[A-Z0-9-]{1,16}$/;
const BATCH_KEYS = [
  "batch",
  "shipment",
  "lot",
  "lotId",
  "index",
  "batchCount",
  "quantityKg",
  "stage",
  "holder",
  "holderName",
  "carrier",
  "carrierName",
  "destinationCustodian",
  "destinationName",
  "observationCount",
  "sequence",
] as const;
const INTENT_KEYS = [
  "intent",
  "lot",
  "lotId",
  "quantityKg",
  "lockedKg",
  "owner",
  "ownerName",
  "terminalName",
  "documentSha256",
  "nonce",
  "expiresAt",
  "acceptances",
] as const;
const ACCEPTANCE_KEYS = ["lender", "lenderName", "loan", "lockKg", "state"] as const;

function whole(value: unknown, path: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new ShapeError(path, "not a whole number in range");
  }
  return value;
}

const name = (value: unknown, path: string) => string(value, path, /^.+$/s);

function readBatch(value: unknown, path: string): FieldBatch {
  const b: Json = record(value, path, BATCH_KEYS);
  const index = whole(b.index, `${path}.index`, 1);
  const batchCount = whole(b.batchCount, `${path}.batchCount`, 1);
  if (index > batchCount) throw new ShapeError(`${path}.index`, "above the batch count");
  return {
    batch: string(b.batch, `${path}.batch`, ADDRESS),
    shipment: string(b.shipment, `${path}.shipment`, ADDRESS),
    lot: string(b.lot, `${path}.lot`, ADDRESS),
    lotId: string(b.lotId, `${path}.lotId`, LOT_ID),
    index,
    batchCount,
    quantityKg: string(b.quantityKg, `${path}.quantityKg`, DECIMAL),
    stage: oneOf(b.stage, `${path}.stage`, STAGES),
    holder: string(b.holder, `${path}.holder`, ADDRESS),
    holderName: name(b.holderName, `${path}.holderName`),
    carrier: string(b.carrier, `${path}.carrier`, ADDRESS),
    carrierName: name(b.carrierName, `${path}.carrierName`),
    destinationCustodian: string(b.destinationCustodian, `${path}.destinationCustodian`, ADDRESS),
    destinationName: name(b.destinationName, `${path}.destinationName`),
    observationCount: whole(b.observationCount, `${path}.observationCount`, 0),
    sequence: string(b.sequence, `${path}.sequence`, DECIMAL),
  };
}

function readAcceptance(value: unknown, path: string): LoadingAcceptance {
  const a = record(value, path, ACCEPTANCE_KEYS);
  return {
    lender: string(a.lender, `${path}.lender`, ADDRESS),
    lenderName: name(a.lenderName, `${path}.lenderName`),
    loan: string(a.loan, `${path}.loan`, ADDRESS),
    lockKg: string(a.lockKg, `${path}.lockKg`, DECIMAL),
    state: oneOf(a.state, `${path}.state`, ACCEPTANCE_STATES),
  };
}

function readIntent(value: unknown, path: string): LoadingIntent {
  const i = record(value, path, INTENT_KEYS);
  return {
    intent: string(i.intent, `${path}.intent`, ADDRESS),
    lot: string(i.lot, `${path}.lot`, ADDRESS),
    lotId: string(i.lotId, `${path}.lotId`, LOT_ID),
    quantityKg: string(i.quantityKg, `${path}.quantityKg`, DECIMAL),
    lockedKg: string(i.lockedKg, `${path}.lockedKg`, DECIMAL),
    owner: string(i.owner, `${path}.owner`, ADDRESS),
    ownerName: name(i.ownerName, `${path}.ownerName`),
    terminalName: name(i.terminalName, `${path}.terminalName`),
    documentSha256: string(i.documentSha256, `${path}.documentSha256`, HEX64),
    nonce: string(i.nonce, `${path}.nonce`, DECIMAL),
    expiresAt: string(i.expiresAt, `${path}.expiresAt`, DECIMAL),
    acceptances: array(i.acceptances, `${path}.acceptances`, readAcceptance),
  };
}

export function parseBatches(value: unknown): FieldBatch[] {
  return array(value, "batches", readBatch);
}

export function parseLoadingIntents(value: unknown): LoadingIntent[] {
  return array(value, "loadingIntents", readIntent);
}

export function fieldApi(client: ApiClient) {
  const query = (organisationId: string) => `organisationId=${encodeURIComponent(organisationId)}`;
  return {
    batches: (organisationId: string) =>
      client.request("GET", `/v1/field/batches?${query(organisationId)}`, {
        timeoutMs: TIMEOUTS.fieldRead,
        parse: parseBatches,
      }),
    loadingIntents: (organisationId: string) =>
      client.request("GET", `/v1/field/loading-intents?${query(organisationId)}`, {
        timeoutMs: TIMEOUTS.fieldRead,
        parse: parseLoadingIntents,
      }),
  };
}

export type FieldApi = ReturnType<typeof fieldApi>;
