import Link from "next/link";
import { PageHeader } from "@/components/thetis/page-header";
import { VoiceLine } from "@/components/voice/voice-panel";
import { dataSource } from "@/data/load-reader";

function referenceMode(): boolean {
  try {
    return dataSource() === "reference";
  } catch {
    return false;
  }
}

export default function ContextNotFound() {
  return (
    <section className="page-content">
      {/* Live pages draw their own rail, so not-found has none: keep voice's End on screen. */}
      {!referenceMode() && <VoiceLine />}
      <PageHeader title="Page not found" />
      <Link className="page-link" href="/">
        Return to the work queue
      </Link>
    </section>
  );
}
