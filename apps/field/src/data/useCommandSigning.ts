// The signing engine the custody screens share: one command's view, its polling, the wallet
// round trip and every relay answer mapped onto a phase or a problem. The text check, the role and
// the copy's variables come from the screen; nothing here knows which kind it is signing.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, ApiShapeError, ApiTimeout, ApiUnreachable } from "../api/client";
import type { CommandSigner, CommandView, CreateCommand, SignerRole } from "../api/commands";
import { useApp } from "../context";
import { REFETCH_CODES, type RelayCopyVars, type RelayPhase, relayErrorCopy } from "../copy";
import { formatTimeOfDay } from "../format";
import { isSameProtocol } from "../protocol";
import type { TextCheck } from "../text";
import { sessionConnection, signText, WalletAccountError, WalletRefused } from "../wallet";

/** A wallet signature held in memory with the SHA-256 of the exact text it was made over. */
export interface HeldSignature {
  signatureBase58: string;
  messageSha256: string;
}

export type Phase =
  | { kind: "loading" }
  | { kind: "checking" }
  | { kind: "preparing" }
  | { kind: "ready" }
  | { kind: "wallet" }
  | { kind: "sending" }
  | { kind: "not_sent"; held: HeldSignature }
  | { kind: "renewing" };

export type Problem =
  | { kind: "relay"; text: string }
  | { kind: "timeout" }
  | { kind: "offline_waiting" }
  | { kind: "signature_stale" }
  | { kind: "wallet_refused" }
  | { kind: "wrong_account" }
  | { kind: "text_changed" }
  | { kind: "payload"; bytes: number | null }
  | null;

export interface SigningOptions {
  /** This phone's role in the command; a function when the role depends on the view's signers. */
  role: SignerRole | ((view: CommandView) => SignerRole | null);
  /** The text check for a candidate view; null means it cannot be checked yet (missing data). */
  verify: (view: CommandView) => TextCheck | null;
  relayVars: (detail: string | null) => RelayCopyVars;
  /** A view that is not this screen's command (another kind, another intent) is never signable. */
  accepts?: (view: CommandView) => boolean;
  /** Called with every accepted view, for screens that keep the command on the phone. */
  onView?: (view: CommandView) => void;
  /** Called with the code of every relay refusal, before its copy is shown. */
  onRelayError?: (code: string, phase: RelayPhase) => void;
}

export interface CommandSigning {
  view: CommandView | null;
  phase: Phase;
  problem: Problem;
  check: TextCheck | null;
  /** The view is another command than this screen's: shown as an unexpected answer, never signed. */
  foreign: boolean;
  /** The view belongs to another Thetis instance than the one this phone reads. */
  otherInstance: boolean;
  signBefore: string;
  mySigner: CommandSigner | null;
  otherSigners: CommandSigner[];
  /** Every condition for opening the wallet holds on the view as drawn. */
  canSign: boolean;
  create(body: CreateCommand): Promise<CommandView | null>;
  open(id: string): Promise<CommandView | null>;
  sign(): Promise<void>;
  send(held: HeldSignature): Promise<void>;
  renew(): Promise<void>;
  /** Drops the view, for a screen that starts the command again after a failure. */
  forget(): void;
  clearProblem(): void;
}

const POLL_MS = 3_000;

function signBeforeOf(view: CommandView | null): string {
  return view?.text ? formatTimeOfDay(BigInt(view.text.validUntil) - 30n) : "";
}

export function useCommandSigning(options: SigningOptions): CommandSigning {
  const app = useApp();
  const latest = useRef(options);
  latest.current = options;
  const [view, setView] = useState<CommandView | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });
  const [problem, setProblem] = useState<Problem>(null);
  const viewRef = useRef<CommandView | null>(null);

  const roleOf = useCallback((candidate: CommandView): SignerRole | null => {
    const { role } = latest.current;
    return typeof role === "function" ? role(candidate) : role;
  }, []);

  const foreignView = useCallback(
    (candidate: CommandView) => latest.current.accepts?.(candidate) === false,
    [],
  );

  const vars = useCallback(
    (detail: string | null = null): RelayCopyVars => ({
      ...latest.current.relayVars(detail),
      detail,
      signBefore: signBeforeOf(viewRef.current),
    }),
    [],
  );

  const show = useCallback(
    async (next: CommandView) => {
      viewRef.current = next;
      setView(next);
      if (foreignView(next)) {
        setProblem({
          kind: "relay",
          text: relayErrorCopy("UNEXPECTED_ANSWER", "get", vars()) ?? "",
        });
        return;
      }
      latest.current.onView?.(next);
    },
    [foreignView, vars],
  );

  /** Every relay error goes through here: re-fetch codes map the status; others show copy. */
  const relayFailed = useCallback(
    async (error: unknown, phaseName: RelayPhase): Promise<void> => {
      if (error instanceof ApiTimeout) return setProblem({ kind: "timeout" });
      if (error instanceof ApiUnreachable) {
        return setProblem(viewRef.current ? { kind: "offline_waiting" } : { kind: "timeout" });
      }
      if (error instanceof ApiError) {
        if (error.code === "NOT_AUTHENTICATED") return app.sessionExpired();
        latest.current.onRelayError?.(error.code, phaseName);
        if (REFETCH_CODES.has(error.code) || error.code === "TEXT_EXPIRED") {
          const id = viewRef.current?.id;
          if (id) {
            try {
              await show(await app.commands.get(id));
              setProblem(
                error.code === "TEXT_EXPIRED"
                  ? { kind: "relay", text: relayErrorCopy("TEXT_EXPIRED", phaseName, vars()) ?? "" }
                  : null,
              );
            } catch (again) {
              await relayFailed(again, "get");
            }
          }
          return;
        }
        return setProblem({
          kind: "relay",
          text: relayErrorCopy(error.code, phaseName, vars(error.detail)) ?? "",
        });
      }
      const code = error instanceof ApiShapeError ? "UNEXPECTED_ANSWER" : "INTERNAL";
      setProblem({ kind: "relay", text: relayErrorCopy(code, phaseName, vars()) ?? "" });
    },
    [app, show, vars],
  );

  async function create(body: CreateCommand): Promise<CommandView | null> {
    setProblem(null);
    setPhase({ kind: "preparing" });
    try {
      const created = await app.commands.create(body);
      await show(created);
      setPhase({ kind: "ready" });
      return created;
    } catch (error) {
      await relayFailed(error, "create");
      setPhase({ kind: "ready" });
      return null;
    }
  }

  async function open(id: string): Promise<CommandView | null> {
    setProblem(null);
    setPhase({ kind: "loading" });
    try {
      const found = await app.commands.get(id);
      await show(found);
      setPhase({ kind: "ready" });
      return found;
    } catch (error) {
      await relayFailed(error, "get");
      setPhase({ kind: "ready" });
      return null;
    }
  }

  // Poll 3 s after the last answer while the relay has not settled it.
  const status = view?.status;
  const foreign = view !== null && foreignView(view);
  useEffect(() => {
    if (
      !view ||
      foreign ||
      (status !== "awaiting_signatures" && status !== "submitted" && status !== "outcome_unknown")
    )
      return;
    if (phase.kind === "wallet" || phase.kind === "sending") return;
    let live = true;
    const timer = setTimeout(() => {
      app.commands
        .get(view.id)
        .then((next) => {
          if (!live) return;
          if (problem?.kind === "offline_waiting") setProblem(null);
          show(next).catch((error: unknown) => relayFailed(error, "get"));
        })
        .catch((error: unknown) => {
          if (!live) return;
          if (error instanceof ApiUnreachable || error instanceof ApiTimeout)
            setProblem({ kind: "offline_waiting" });
          else if (error instanceof ApiError && error.code === "NOT_AUTHENTICATED")
            app.sessionExpired();
          else {
            void relayFailed(error, "get");
            setView({ ...view });
          }
        });
    }, POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [view, foreign, status, phase.kind, app, show, problem?.kind, relayFailed]);

  /**
   * Every check that decides whether a view may be signed, run on the view itself rather than on
   * what was last rendered: this instance, this screen's command, and the text check.
   */
  function signable(candidate: CommandView): boolean {
    if (!candidate.text || foreignView(candidate)) return false;
    if (!isSameProtocol(candidate, app.protocol)) return false;
    try {
      return latest.current.verify(candidate)?.ok === true;
    } catch {
      return false;
    }
  }

  async function stillSame(): Promise<boolean> {
    const current = viewRef.current;
    if (!current?.text) return false;
    try {
      const fresh = await app.commands.get(current.id);
      const same =
        fresh.id === current.id &&
        fresh.status === "awaiting_signatures" &&
        fresh.text?.messageSha256 === current.text.messageSha256 &&
        signable(fresh);
      if (!same) await show(fresh);
      return same;
    } catch {
      return false;
    }
  }

  async function sign() {
    const current = viewRef.current;
    if (!current?.text || !app.wallet) return;
    const role = roleOf(current);
    const mine = role ? current.signers.find((s) => s.role === role) : undefined;
    if (!role || !mine || mine.signed) return;
    setProblem(null);
    if (!signable(current)) {
      // The view changed after the screen drew it: draw it again, with its mismatch, and stop.
      setView({ ...current });
      return;
    }
    const text = current.text;
    setPhase({ kind: "wallet" });
    let result: Awaited<ReturnType<typeof signText>>;
    try {
      result = await signText(
        sessionConnection(app.wallet, app.connection),
        { expectedAddress: app.wallet.address, messageBase64: text.messageBase64 },
        app.setConnection,
        stillSame,
      );
    } catch (error) {
      setPhase({ kind: "ready" });
      if (error instanceof WalletAccountError) return setProblem({ kind: "wrong_account" });
      if (error instanceof WalletRefused) return setProblem({ kind: "wallet_refused" });
      return setProblem({
        kind: "relay",
        text: relayErrorCopy("INTERNAL", "signatures", vars()) ?? "",
      });
    }
    if (result.kind === "not_asked") {
      setPhase({ kind: "ready" });
      setProblem({ kind: "text_changed" });
      return;
    }
    if (result.kind === "payload_mismatch") {
      setPhase({ kind: "ready" });
      setProblem({ kind: "payload", bytes: result.receivedBytes });
      return;
    }
    await send({ signatureBase58: result.signatureBase58, messageSha256: text.messageSha256 });
  }

  async function send(held: HeldSignature) {
    const current = viewRef.current;
    if (!current?.text || !app.wallet) return;
    const role = roleOf(current);
    if (!role) return;
    setProblem(null);
    if (current.text.messageSha256 !== held.messageSha256 || !signable(current)) {
      // An old signature never matches a new text: it is dropped, not sent.
      setPhase({ kind: "ready" });
      setProblem({ kind: "signature_stale" });
      return;
    }
    setPhase({ kind: "sending" });
    try {
      const answer = await app.commands.sign(current.id, {
        role,
        wallet: app.wallet.address,
        messageSha256: held.messageSha256,
        signature: held.signatureBase58,
      });
      await show(answer);
      setPhase({ kind: "ready" });
    } catch (error) {
      if (error instanceof ApiTimeout || error instanceof ApiUnreachable) {
        // The signature may have landed: read before offering to send it again.
        try {
          const fresh = await app.commands.get(current.id);
          const unsigned =
            fresh.status === "awaiting_signatures" &&
            !fresh.signers.find((s) => s.role === role)?.signed;
          await show(fresh);
          setPhase(unsigned ? { kind: "not_sent", held } : { kind: "ready" });
        } catch {
          setPhase({ kind: "not_sent", held });
        }
        return;
      }
      setPhase({ kind: "ready" });
      await relayFailed(error, "signatures");
    }
  }

  async function renew() {
    const current = viewRef.current;
    if (!current) return;
    setProblem(null);
    setPhase({ kind: "renewing" });
    try {
      await show(await app.commands.renew(current.id));
    } catch (error) {
      await relayFailed(error, "renew");
    }
    setPhase({ kind: "ready" });
  }

  function forget() {
    viewRef.current = null;
    setView(null);
    setProblem(null);
    setPhase({ kind: "ready" });
  }

  const role = view ? roleOf(view) : null;
  const mySigner = view && role ? (view.signers.find((s) => s.role === role) ?? null) : null;
  const otherSigners = view ? view.signers.filter((s) => s !== mySigner) : [];
  const otherInstance = view !== null && !isSameProtocol(view, app.protocol);
  const check = view && !foreign && !otherInstance ? options.verify(view) : null;
  const canSign =
    view !== null &&
    view.status === "awaiting_signatures" &&
    !foreign &&
    !otherInstance &&
    check?.ok === true &&
    mySigner !== null &&
    mySigner.signed === null &&
    app.wallet !== null &&
    app.online;

  return {
    view,
    phase,
    problem,
    check,
    foreign,
    otherInstance,
    signBefore: signBeforeOf(view),
    mySigner,
    otherSigners,
    canSign,
    create,
    open,
    sign,
    send,
    renew,
    forget,
    clearProblem: () => setProblem(null),
  };
}
