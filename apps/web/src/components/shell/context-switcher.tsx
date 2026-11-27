"use client";

import { CaretDown } from "@phosphor-icons/react";
import Link from "next/link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Context } from "@/data/types";
import { type RailItem, RailNav, type RailSegment } from "./rail-nav";

export function ContextSwitcher({
  current,
  contexts,
  items,
  segment,
}: {
  current: Context;
  contexts: Context[];
  items: RailItem[];
  segment?: RailSegment | undefined;
}) {
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="context-switcher">
          <span className="context-description">
            <small className="context-prefix">Acting as</small>
            <strong>{current.organisation.name}</strong>
            <small className="context-role">
              <span className="capitalize">{current.role}</span> · synthetic
            </small>
          </span>
          <CaretDown aria-hidden="true" size={16} weight="regular" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {contexts.map((context) => (
            <DropdownMenuItem key={context.organisationId} asChild>
              <Link
                href={`/${context.organisationId}/queue`}
                aria-current={
                  context.organisationId === current.organisationId ? "true" : undefined
                }
              >
                {context.organisation.name}
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <RailNav items={items} segment={segment} />
    </>
  );
}
