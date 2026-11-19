import type { Outcome, RefusalReason, Role, Route } from "./relay";

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

export const refusalCopy = {
  WRONG_ADDRESS: "The submitted address does not match this role.",
  BAD_SIGNATURE: "The relay could not verify the signature.",
  UNKNOWN_ROLE: "The relay did not recognize this role.",
  ALREADY_SUBMITTED: "The handover was already submitted.",
  INTENT_EXPIRED: "Intent expired. Reload it.",
  STALE_INTENT: "Intent changed. Reload it.",
  BATCH_COMPLETE: "Ask the operator to run setup",
  CHAIN_UNAVAILABLE: "The relay can't reach devnet right now. Try again.",
} satisfies Record<RefusalReason, string>;

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
  payloadMismatch: "Payload mismatch",
  receivedPayloadLength: (bytes: number | null) =>
    bytes === null ? "Received byte length unavailable." : `Received ${bytes} bytes.`,
  relayUnreachable: "Run adb reverse tcp:8787 tcp:8787 on the laptop",
  relayError: "Relay error",
  walletMismatch: "The authorized address does not match this role.",
  walletInvalidAddress: "Wallet returned an invalid account address.",
  walletNoAccount: "Wallet returned no authorized account.",
  outcome: "Outcome",
  awaitingOutcome: "Waiting for relay status",
  awaitingIntentOutcome: "Waiting for an outcome for the loaded intent",
  outcomeMismatch: "This outcome is for different bytes than the intent on this screen",
  notChecked: "Not checked",
  expectedAddress: "Expected address",
  authorizedAddress: "Authorized address",
  fingerprint: "Authorization SHA-256",
  devnetSignature: "Devnet signature",
  size: (bytes: number) => `Size: ${bytes} bytes`,
  verified: (verified: boolean) => `Verified over exact bytes: ${verified ? "yes" : "no"}`,
};
