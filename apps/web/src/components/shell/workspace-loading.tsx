import type { ReactNode } from "react";
import { VoiceLine } from "@/components/voice/voice-panel";
import { LiveDataError } from "@/data/live/types";
import { dataSource } from "@/data/load-reader";

const rows = ["80%", "60%", "70%", "50%"];

/**
 * A live page's loading screen inside the live shell's structure (navigation.md §5.7). The skeleton
 * carries no names and no counts. In reference mode the layout already draws the rail.
 */
export function WorkspaceLoading({ children }: { children: ReactNode }) {
  let source: "reference" | "live" | null;
  try {
    source = dataSource();
  } catch (error) {
    if (!(error instanceof LiveDataError)) throw error;
    source = null;
  }
  if (source !== "live") return children;

  return (
    <>
      <div className="reference-banner" aria-hidden="true" />
      <div className="workspace-shell">
        <div className="side-rail" aria-hidden="true">
          <div className="rail-wordmark">THETIS</div>
          <span className="rail-skeleton rail-skeleton-switcher" />
          {rows.map((width) => (
            <span key={width} className="rail-skeleton rail-skeleton-row" style={{ width }} />
          ))}
        </div>
        <main id="content" tabIndex={-1} className="workspace-main">
          <VoiceLine />
          <div className="page-content">{children}</div>
        </main>
      </div>
    </>
  );
}
