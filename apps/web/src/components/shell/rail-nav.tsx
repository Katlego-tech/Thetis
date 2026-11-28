"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId } from "react";

/** The workspace sections, in rail order (navigation.md §3.1). */
export type RailSegment = "queue" | "lots" | "releases" | "exceptions";

export interface RailItem {
  key: string; // lot id, or release address
  label: string; // lot id
  detail: string | null; // releases: formatTonnes(quantityKg); lots: null
  href: string; // a path, no query
}

export interface RailSection {
  segment: RailSegment;
  label: "Work queue" | "Lots" | "Releases" | "Exceptions";
  count: number;
  href: string | null; // queue and exceptions: their page; lots and releases: null (a heading)
  items: RailItem[]; // lots and releases only; [] for queue and exceptions
  empty: "No lots yet" | "No releases yet" | null;
}

function decoded(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** The one href that is the current page: an exact pathname match, else the fallback, else null. */
export function activeHref(
  pathname: string,
  sections: RailSection[],
  fallback: string | null,
): string | null {
  const hrefs = sections.flatMap(({ href, items }) => [
    ...(href === null ? [] : [href]),
    ...items.map((item) => item.href),
  ]);
  const match = (path: string) => hrefs.find((href) => decoded(href) === decoded(path)) ?? null;
  return match(pathname) ?? (fallback === null ? null : match(fallback));
}

function Count({ count }: { count: number }) {
  return (
    <span className="rail-count">
      <span className="sr-only">,</span> {count}
    </span>
  );
}

export function RailNav({
  sections,
  fallback = null,
  label = "Workspace",
}: {
  sections: RailSection[];
  fallback?: string | null;
  label?: string;
}) {
  const pathname = usePathname() ?? "";
  const current = activeHref(pathname, sections, fallback);
  const id = useId();
  const currentProp = (href: string) => (href === current ? ("page" as const) : undefined);

  return (
    <nav className="rail-nav" aria-label={label}>
      {sections.map(({ segment, label, count, href, items, empty }) => {
        if (href !== null) {
          return (
            <Link key={segment} className="rail-link" href={href} aria-current={currentProp(href)}>
              {label}
              <Count count={count} />
            </Link>
          );
        }
        const headingId = `${id}-${segment}`;
        return (
          <div key={segment} className="rail-group">
            <h2 className="rail-heading" id={headingId}>
              {label}
              <Count count={count} />
            </h2>
            {items.length > 0 ? (
              <ul className="rail-list" aria-labelledby={headingId}>
                {items.map((item) => (
                  <li key={item.key}>
                    <Link
                      className="rail-link rail-sub"
                      href={item.href}
                      aria-current={currentProp(item.href)}
                    >
                      <span className="rail-sub-label">{item.label}</span>
                      {item.detail !== null && (
                        <span className="rail-sub-detail">
                          <span className="sr-only">,</span> {item.detail}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rail-empty">{empty}</p>
            )}
          </div>
        );
      })}
    </nav>
  );
}
