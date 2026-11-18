import type { Outcome, Role, Route } from "./relay";

export const roleCopy = {
  sender: "Sender · Kopano",
  receiver: "Receiver · Mosela",
} satisfies Record<Role, string>;

export const routeCopy = {
  message: "Sign as message",
  transaction: "Sign as transaction",
} satisfies Record<Route, string>;

export const routeCheckCopy = {
  message: "Message",
  transaction: "Transaction",
} satisfies Record<Route, string>;

export const outcomeCopy = {
  waiting: "waiting",
  submitted: "submitted",
  confirmed: "confirmed",
  failed: "failed",
  unknown: "Outcome unknown: check the explorer",
} satisfies Record<Outcome["state"], string>;

export const copy = {
  title: "Thetis signing spike",
  connect: "Connect wallet",
  connecting: "Connecting…",
  loadIntent: "Load intent",
  loading: "Loading intent…",
  signing: "Waiting for wallet…",
  checkingIntent: "Checking intent…",
  sending: "Sending signature to relay…",
  walletRefused: "Wallet refused",
  relayUnreachable: "Run adb reverse tcp:8787 tcp:8787 on the laptop",
  relayError: "Relay error",
  staleIntent: "Intent expired. Reload it.",
  batchComplete: "Ask the operator to run setup",
  walletMismatch: "The authorized address does not match this role.",
  outcome: "Outcome",
  awaitingOutcome: "Waiting for relay status",
  notChecked: "Not checked",
  expectedAddress: "Expected address",
  authorizedAddress: "Authorized address",
  fingerprint: "Authorization SHA-256",
  devnetSignature: "Devnet signature",
  size: (bytes: number) => `Size: ${bytes} bytes`,
  verified: (verified: boolean) => `Verified over exact bytes: ${verified ? "yes" : "no"}`,
};
