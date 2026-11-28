import { VoicePanel } from "@/components/voice/voice-panel";
import type { ScreenReader } from "@/data/live/types";
import type { Context } from "@/data/types";
import { formatTonnes } from "@/lib/format";
import { AccountBlock } from "./account-block";
import { ContextSwitcher } from "./context-switcher";
import { MenuSheet } from "./menu-sheet";
import { type RailItem, RailNav, type RailSection } from "./rail-nav";
import { ThemeToggle } from "./theme-toggle";

function lotItem(base: string, lotId: string): RailItem {
  return {
    key: lotId,
    label: lotId,
    detail: null,
    href: `${base}/lots/${encodeURIComponent(lotId)}`,
  };
}

/** The rail's sections for one context, from the page's own read (navigation.md §3.1, §5.2). */
export function railSections(reader: ScreenReader, organisationId: string): RailSection[] {
  const base = `/${organisationId}`;
  const queue = reader.workQueue(organisationId);
  let lots: RailItem[];
  let releases: RailItem[];
  if (reader.mode === "live") {
    lots = reader.lots(organisationId).map(({ id }) => lotItem(base, id));
    releases = reader.releases(organisationId).map((intent) => ({
      key: intent.address,
      label: intent.lotId,
      detail: formatTonnes(intent.quantityKg),
      href: `${base}/releases/${intent.address}`,
    }));
  } else {
    // Reference mode: the lots on the queue, and the queue's release links (as before T074a).
    lots = [...new Set(queue.map(({ lot }) => lot.id))].map((lotId) => lotItem(base, lotId));
    const releasePrefix = `${base}/releases/`;
    const byHref = new Map<string, RailItem>();
    for (const { href, lot, quantityKg } of queue) {
      const path = href.split("?")[0] ?? href;
      if (!path.startsWith(releasePrefix) || byHref.has(path)) continue;
      byHref.set(path, {
        key: path.slice(releasePrefix.length),
        label: lot.id,
        detail: quantityKg === null ? null : formatTonnes(quantityKg),
        href: path,
      });
    }
    releases = [...byHref.values()];
  }
  return [
    {
      segment: "queue",
      label: "Work queue",
      count: queue.length,
      href: `${base}/queue`,
      items: [],
      empty: null,
    },
    {
      segment: "lots",
      label: "Lots",
      count: lots.length,
      href: null,
      items: lots,
      empty: "No lots yet",
    },
    {
      segment: "releases",
      label: "Releases",
      count: releases.length,
      href: null,
      items: releases,
      empty: "No releases yet",
    },
    {
      segment: "exceptions",
      label: "Exceptions",
      count: reader.exceptions(organisationId).length,
      href: `${base}/exceptions`,
      items: [],
      empty: null,
    },
  ];
}

export function SideRail({
  current,
  reader,
  fallback = null,
}: {
  current: Context;
  reader: ScreenReader;
  fallback?: string | null;
}) {
  const sections = railSections(reader, current.organisationId);
  return (
    <div className="side-rail">
      <div className="rail-wordmark">THETIS</div>
      <ContextSwitcher current={current} contexts={reader.contexts()} />
      <RailNav sections={sections} fallback={fallback} />
      <VoicePanel organisationId={current.organisationId} sections={sections} />
      <AccountBlock />
      <div className="rail-theme">
        <ThemeToggle />
      </div>
      <MenuSheet sections={sections} fallback={fallback} />
    </div>
  );
}
