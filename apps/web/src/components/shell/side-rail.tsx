import type { ScreenReader } from "@/data/live/types";
import type { ThetisReader } from "@/data/reader";
import type { Context } from "@/data/types";
import { ContextSwitcher } from "./context-switcher";
import type { RailItem } from "./rail-nav";
import { ThemeToggle } from "./theme-toggle";

function referenceItems(reader: ThetisReader, organisationId: string): RailItem[] {
  const base = `/${organisationId}`;
  const queue = reader.workQueue(organisationId);
  const lots = new Set(queue.map(({ lot }) => lot.id));
  const firstLot = queue[0]?.lot.id;
  const releasePrefix = `${base}/releases/`;
  const releaseLinks = new Set(
    queue.map(({ href }) => href).filter((href) => href.startsWith(releasePrefix)),
  );
  const [firstRelease] = releaseLinks;
  return [
    { segment: "queue", label: "Work queue", count: queue.length, href: `${base}/queue` },
    {
      segment: "lots",
      label: "Lots",
      count: lots.size,
      href: firstLot ? `${base}/lots/${firstLot}` : null,
    },
    {
      segment: "releases",
      label: "Releases",
      count: releaseLinks.size,
      href: firstRelease ?? null,
    },
    {
      segment: "exceptions",
      label: "Exceptions",
      count: reader.exceptions(organisationId).length,
      href: `${base}/exceptions`,
    },
  ];
}

export function SideRail({
  current,
  reader,
  segment,
}: {
  current: Context;
  reader: ScreenReader;
  segment?: string;
}) {
  const { organisationId } = current;
  const base = `/${organisationId}`;
  let items: RailItem[];
  if (reader.mode === "live") {
    const [firstLot] = reader.lots(organisationId);
    items = [
      {
        segment: "queue",
        label: "Work queue",
        count: reader.workQueue(organisationId).length,
        href: `${base}/queue`,
      },
      {
        segment: "lots",
        label: "Lots",
        count: reader.lots(organisationId).length,
        href: firstLot ? `${base}/lots/${encodeURIComponent(firstLot.id)}` : null,
      },
      { segment: "releases", label: "Releases", count: 0, href: null },
      {
        segment: "exceptions",
        label: "Exceptions",
        count: reader.exceptions(organisationId).length,
        href: `${base}/exceptions`,
      },
    ];
  } else {
    items = referenceItems(reader, organisationId);
  }

  return (
    <aside className="side-rail" aria-label="Thetis workspace">
      <div className="rail-wordmark">THETIS</div>
      <ContextSwitcher
        current={current}
        contexts={reader.contexts()}
        items={items}
        segment={segment}
      />
      <div className="rail-theme">
        <ThemeToggle />
      </div>
    </aside>
  );
}
