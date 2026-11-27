import type { ReactNode } from "react";
import type { LiveReader } from "@/data/live/types";
import type { Context } from "@/data/types";
import { LiveBanner } from "./live-banner";
import { SideRail } from "./side-rail";
import { SkipLink } from "./skip-link";

/** The workspace shell of a live page: banner, rail and body all come from the page's own read. */
export function LiveShell({
  reader,
  current,
  fallback = null,
  children,
}: {
  reader: LiveReader;
  current: Context;
  fallback?: string | null;
  children: ReactNode;
}) {
  return (
    <>
      <SkipLink />
      <LiveBanner freshness={reader.freshness} />
      <div className="workspace-shell">
        <SideRail current={current} reader={reader} fallback={fallback} />
        <main id="content" tabIndex={-1} className="workspace-main">
          <div className="page-content">{children}</div>
        </main>
      </div>
    </>
  );
}
