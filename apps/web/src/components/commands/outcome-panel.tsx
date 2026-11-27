import Link from "next/link";
import type { CommandView } from "@/lib/commands";
import { shortened } from "./status";

// The command's outcome (live-lending.md §6.9.4 OutcomePanel): the status line, the transaction and
// what to do next. A failed command's code and explanation sit in the status line only (decision 2).

const releaseKinds: readonly CommandView["kind"][] = ["create_release_intent", "sell_pledged"];

export function OutcomePanel({
  view,
  line,
  context,
  lotId,
  canRenew,
  renewing,
  onRenew,
  problem,
}: {
  view: CommandView;
  line: string;
  context: string;
  lotId: string | null;
  canRenew: boolean;
  renewing: boolean;
  onRenew: () => void;
  problem: string | null;
}) {
  const opensRelease =
    view.intent !== null &&
    (releaseKinds.includes(view.kind) ||
      (view.kind === "confirm_payment" && view.args.purpose === "Release"));
  return (
    <section className="work-panel" aria-labelledby="command-status">
      <h2 id="command-status">Status</h2>
      <p role="status" className="text-[14px]">
        {line}
      </p>
      {view.transaction && (
        <dl className="fact-list">
          <dt>Transaction</dt>
          <dd>
            <a
              className="font-mono text-[12.5px] text-(--act) underline"
              href={view.transaction.explorerUrl}
              target="_blank"
              rel="noreferrer"
            >
              {shortened(view.transaction.signature, 8)}
            </a>
          </dd>
        </dl>
      )}
      {problem && (
        <p className="form-alert" role="alert">
          {problem}
        </p>
      )}
      {(view.status === "expired" && canRenew) || view.status === "confirmed" ? (
        <div className="act-row">
          {view.status === "expired" && canRenew && (
            <button type="button" className="act-button" onClick={onRenew} disabled={renewing}>
              Prepare a new text
            </button>
          )}
          {view.status === "confirmed" &&
            (lotId ? (
              <Link
                className="act-button"
                href={`/${context}/lots/${encodeURIComponent(lotId)}?tab=financing`}
              >
                Open the lot
              </Link>
            ) : (
              <Link className="act-button" href={`/${context}/queue`}>
                Open the work queue
              </Link>
            ))}
          {view.status === "confirmed" && opensRelease && (
            <Link
              className="act-button"
              data-variant="outline"
              href={`/${context}/releases/${view.intent}`}
            >
              Open the release
            </Link>
          )}
        </div>
      ) : null}
    </section>
  );
}
