"use client";

import { CaretDown } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Context } from "@/data/types";

/** Switching keeps the work queue or exceptions; ids belong to a context, so anything else opens the queue. */
export function switchHref(organisationId: string, pathname: string): string {
  const section = pathname.split("/")[2];
  const kept = section === "queue" || section === "exceptions" ? section : "queue";
  return `/${organisationId}/${kept}`;
}

function roleLine(role: string): string {
  return `${role.charAt(0).toUpperCase()}${role.slice(1)}, synthetic`;
}

export function ContextSwitcher({ current, contexts }: { current: Context; contexts: Context[] }) {
  const pathname = usePathname() ?? "";
  const name = current.organisation.name;
  const description = (
    <span className="context-description">
      <small className="context-prefix">Acting as</small>
      <strong>{name}</strong>
      <small className="context-role">{roleLine(current.role)}</small>
    </span>
  );

  if (contexts.length <= 1) {
    return <div className="context-switcher context-static">{description}</div>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="context-switcher"
        aria-label={`Acting as ${name}. Switch organisation`}
      >
        {description}
        <CaretDown aria-hidden="true" size={16} weight="regular" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="context-menu">
        {contexts.map((context) => (
          <DropdownMenuItem key={context.organisationId} asChild className="context-option">
            <Link
              href={switchHref(context.organisationId, pathname)}
              aria-current={context.organisationId === current.organisationId ? "true" : undefined}
            >
              {context.organisation.name}
              <small>{roleLine(context.role)}</small>
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
