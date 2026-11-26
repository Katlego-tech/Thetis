import { List } from "@phosphor-icons/react";
import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeMenu } from "./theme-toggle";

export interface RailItem {
  segment: string;
  label: string;
  count: number;
  href: string | null;
}

export function RailNav({ items, segment }: { items: RailItem[]; segment?: string | undefined }) {
  // A page passes its own segment: the layout segment is not visible from inside a page.
  const layoutSegment = useSelectedLayoutSegment();
  const activeSegment = segment ?? layoutSegment;

  return (
    <>
      <nav className="rail-nav" aria-label="Workspace">
        {items.map(({ segment, label, count, href }) => {
          const content = (
            <>
              {label}
              <span className="rail-count">{count}</span>
            </>
          );
          return href ? (
            <Link
              key={segment}
              className="rail-link"
              href={href}
              aria-current={activeSegment === segment ? "page" : undefined}
            >
              {content}
            </Link>
          ) : (
            <span key={segment} className="rail-link" aria-disabled="true">
              {content}
            </span>
          );
        })}
      </nav>
      <div className="rail-mobile-nav">
        <DropdownMenu>
          <DropdownMenuTrigger className="rail-menu-trigger" aria-label="Workspace menu">
            <List aria-hidden="true" size={20} weight="regular" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="rail-mobile-menu">
            {items.map(({ segment, label, count, href }) => {
              const content = (
                <>
                  {label}
                  <span className="rail-menu-count">{count}</span>
                </>
              );
              return href ? (
                <DropdownMenuItem key={segment} asChild>
                  <Link href={href} aria-current={activeSegment === segment ? "page" : undefined}>
                    {content}
                  </Link>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem key={segment} disabled>
                  {content}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <ThemeMenu />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}
