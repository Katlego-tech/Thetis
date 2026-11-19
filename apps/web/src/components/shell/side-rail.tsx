import type { ThetisReader } from "@/data/reader";
import type { Context } from "@/data/types";
import { ContextSwitcher } from "./context-switcher";
import type { RailItem } from "./rail-nav";
import { ThemeToggle } from "./theme-toggle";

export function SideRail({ current, reader }: { current: Context; reader: ThetisReader }) {
  const { organisationId } = current;
  const base = `/${organisationId}`;
  const queue = reader.workQueue(organisationId);
  const lots = new Set(queue.map(({ lot }) => lot.id));
  const firstLot = queue[0]?.lot.id;
  const releasePrefix = `${base}/releases/`;
  const releaseLinks = new Set(
    queue.map(({ href }) => href).filter((href) => href.startsWith(releasePrefix)),
  );
  const [firstRelease] = releaseLinks;
  const items: RailItem[] = [
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

  return (
    <aside className="side-rail" aria-label="Thetis workspace">
      <div className="rail-wordmark">THETIS</div>
      <ContextSwitcher current={current} contexts={reader.contexts()} items={items} />
      <div className="rail-theme">
        <ThemeToggle />
      </div>
    </aside>
  );
}
