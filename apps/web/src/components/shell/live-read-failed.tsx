import { PageHeader } from "@/components/thetis/page-header";
import type { LiveDataError } from "@/data/live/types";

export function LiveReadFailed({ notSynthetic = false }: { notSynthetic?: boolean }) {
  return (
    <section className="page-content">
      <PageHeader title="The registry could not be read" />
      <p>
        {notSynthetic
          ? "This workspace includes an organisation that is not marked synthetic, so it is not shown in the test environment."
          : "Reload the page to try again. Nothing on chain changed because of this."}
      </p>
    </section>
  );
}

/** The whole page when the registry could not be read: failure banner, no rail. Logs the cause. */
export function LiveFailurePage({ error }: { error: LiveDataError }) {
  // The cause is for the server log only; it never reaches the page.
  console.error("Could not read the indexed registry", {
    code: error.code,
    path: error.path,
    cause: error.cause,
  });
  return (
    <>
      <div className="reference-banner">
        <span>Thetis could not read the indexed registry. Nothing here is current.</span>
      </div>
      <main className="workspace-main">
        <LiveReadFailed notSynthetic={error.code === "NOT_SYNTHETIC"} />
      </main>
    </>
  );
}
