import { RegistryMark, registryMarks } from "@/components/thetis/registry-mark";
import type { ConfiguredJudgeView, JudgeOrganisation, JudgeView } from "@/data/judge/read";
import { explorerAddressUrl, pageState, shorten, toSteps } from "@/data/judge/steps";
import { formatSlot } from "@/lib/format";
import { StepSpine } from "./step-spine";

export type RunResult =
  | { ok: true; view: JudgeView }
  | { ok: false; kind: "config" | "read" | "shape" };

const TESTS = "https://github.com/Katlego-tech/Thetis/blob/main/programs/thetis/tests";

export function DevnetBanner() {
  return (
    <div className="judge-banner">
      Devnet. Synthetic organisations and quantities. No real goods, money or banks.
    </div>
  );
}

function AddressLink({ address }: { address: string }) {
  return (
    <a href={explorerAddressUrl(address)} title={address} rel="noreferrer">
      <span className="judge-full">{address}</span>
      <span className="judge-short">{shorten(address)}</span>
    </a>
  );
}

export function RunHeader({ view }: { view: ConfiguredJudgeView | null }) {
  return (
    <section className="judge-head">
      <div>
        <h1>One Thetis run, as the chain recorded it</h1>
        <p>
          Thetis keeps the custody, locks and releases of a mineral lot on a Solana program, so an
          exporter, a custodian, a haulier, a port terminal and a lender all read the same record.
          This page lists every transaction of one rehearsal run on devnet, from the custodian
          issuing lot CR-0001 to the terminal loading it, in the order the chain confirmed them.
          Each step links to its transaction on the Solana explorer, where you can check who signed
          it.
        </p>
      </div>
      {view ? (
        <div className="judge-cert">
          <div>
            <b>Program</b>
            <AddressLink address={view.programId} />
          </div>
          <div>
            <b>Instance {view.instanceLabel}</b>
            <AddressLink address={view.protocol} />
          </div>
          <div>
            <b>Settlement</b>test bank confirmation
          </div>
        </div>
      ) : null}
    </section>
  );
}

function slotText(slot: number | null | undefined): string {
  return slot === null || slot === undefined ? "none" : formatSlot(BigInt(slot));
}

export function RunStateLine({ view }: { view: ConfiguredJudgeView }) {
  const state = pageState(view);
  const n = view.transactions.length;
  const r = view.refusals.length;
  const m = view.expectedTransactions;
  const through = slotText(view.checkpoint?.indexedThroughSlot);
  if (state === "loaded")
    return (
      <div className="judge-state">
        <RegistryMark status="confirmed" />
        <p>
          {n} transactions and {r} refusals, all confirmed by the program. Indexed through slot{" "}
          {through}.{n > m ? ` This instance has ${n} transactions; the run recorded ${m}.` : null}
        </p>
      </div>
    );
  if (state === "halted")
    return (
      <div className="judge-state">
        <span className={`thetis-mark border ${registryMarks.outcome_unknown.classes}`}>
          Stopped
        </span>
        <p>
          Indexing stopped at slot {through} ({view.checkpoint?.haltReason}). Steps after that slot
          are not shown until it resumes.
        </p>
      </div>
    );
  return (
    <div className="judge-state">
      <span className={`thetis-mark border ${registryMarks.submitted.classes}`}>Indexing</span>
      <p>
        {view.checkpoint === null
          ? "Indexing has not started. No steps are shown until the indexer confirms them."
          : `Indexing. ${n} of ${m} transactions and ${r} of ${view.expectedRefusals} refusals of this run are in this read model so far, through slot ${through}. Steps not yet indexed are not shown.`}
      </p>
    </div>
  );
}

export function PartiesList({ organisations }: { organisations: JudgeOrganisation[] }) {
  return (
    <section className="judge-panel">
      <h2>Parties in this run</h2>
      <ul className="judge-parties">
        {organisations.map((o) => (
          <li key={o.address}>
            {o.displayName}
            <span>{o.synthetic === true ? `${o.role}, synthetic` : o.role}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AboutThisPage() {
  return (
    <section className="judge-panel">
      <h2>What this page is and is not</h2>
      <ul className="judge-plain">
        <li>It is read only. There is no sign-in and nothing here can change the record.</li>
        <li>
          It shows only what the indexer read from the program for this one instance. A step that is
          not on chain is not on this page.
        </li>
        <li>
          Signer wallets are on each transaction's explorer page; the page names the organisations
          the program requires to sign.
        </li>
        <li>It is not the product's working screens, which need a signed-in organisation.</li>
        <li>
          Error names are the ones the relay decoded when the transaction failed; the explorer shows
          the program log.
        </li>
      </ul>
    </section>
  );
}

export function ProgramRefusesNote() {
  return (
    <section className="judge-refuses">
      <h2>What the program refuses</h2>
      <p>These refusals are also proven by the program's own tests:</p>
      <ul>
        <li>
          <a href={`${TESTS}/pledge.rs#L1037`} rel="noreferrer">
            Units already locked cannot be pledged again
          </a>
        </li>
        <li>
          <a href={`${TESTS}/handover.rs#L1676`} rel="noreferrer">
            A wallet with no authority cannot take a handover
          </a>
        </li>
        <li>
          <a href={`${TESTS}/issue.rs#L577`} rel="noreferrer">
            An intake can be issued only once
          </a>
        </li>
      </ul>
    </section>
  );
}

export function NotConfiguredPanel({ otherInstance }: { otherInstance: boolean }) {
  return (
    <section className="judge-center">
      <h2>No run is set for this page</h2>
      <p>
        {otherInstance
          ? "The indexer is reading a different instance from the one set for this page, so no steps are shown."
          : "The page shows one judged run, chosen when the site is deployed. None is set yet, so there is nothing to show. Nothing on this page is a stand-in."}
      </p>
    </section>
  );
}

export function ReadErrorPanel({ kind }: { kind: "config" | "read" | "shape" }) {
  return (
    <section className="judge-center" data-tone="error" role="alert">
      <h2>The run could not be read</h2>
      <p>
        {kind === "config"
          ? "This deployment is missing its database address or public key."
          : `The page asked its database for the run and did not get an answer it could use (${kind}). Nothing is shown rather than a partial record. Reload in a minute.`}
      </p>
    </section>
  );
}

/** The whole page for one read result, in the five states of judge-page.md §5.1. */
export function RunPage({ result }: { result: RunResult }) {
  if (!result.ok)
    return (
      <>
        <DevnetBanner />
        <main
          className="judge-main"
          data-state="read_error"
          data-step-count="0"
          data-refusal-count="0"
        >
          <RunHeader view={null} />
          <ReadErrorPanel kind={result.kind} />
        </main>
      </>
    );
  const { view } = result;
  const state = pageState(view);
  if (!view.configured || state === "not_configured")
    return (
      <>
        <DevnetBanner />
        <main
          className="judge-main"
          data-state="not_configured"
          data-step-count="0"
          data-refusal-count="0"
        >
          <RunHeader view={view.configured ? view : null} />
          <NotConfiguredPanel otherInstance={view.configured && !view.streamMatches} />
          <ProgramRefusesNote />
        </main>
      </>
    );
  const steps = toSteps(view);
  return (
    <>
      <DevnetBanner />
      <main
        className="judge-main"
        data-state={state}
        data-step-count={view.transactions.length}
        data-refusal-count={view.refusals.length}
      >
        <RunHeader view={view} />
        <RunStateLine view={view} />
        <div className="judge-body">
          {view.checkpoint === null ? null : <StepSpine steps={steps} />}
          <aside className="judge-aside">
            <PartiesList organisations={view.organisations} />
            <AboutThisPage />
          </aside>
        </div>
        <ProgramRefusesNote />
      </main>
    </>
  );
}
