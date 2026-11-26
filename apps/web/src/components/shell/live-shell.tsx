import type { ReactNode } from "react";
import type { LiveReader } from "@/data/live/types";
import type { Context } from "@/data/types";
import { LiveBanner } from "./live-banner";
import { SideRail } from "./side-rail";

/** The workspace shell of a live page: banner, rail and body all come from the page's own read. */
export function LiveShell({
  reader,
  current,
  segment,
  children,
}: {
  reader: LiveReader;
  current: Context;
  segment: "queue" | "exceptions" | "lots";
  children: ReactNode;
}) {
  return (
    <>
      <LiveBanner freshness={reader.freshness} />
      <div className="workspace-shell">
        <SideRail current={current} reader={reader} segment={segment} />
        <main className="workspace-main">
          <div className="page-content">{children}</div>
        </main>
      </div>
    </>
  );
}
