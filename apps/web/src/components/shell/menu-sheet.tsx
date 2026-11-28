"use client";

import { List } from "@phosphor-icons/react";
import { usePathname } from "next/navigation";
import { type MouseEvent, useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { AccountBlock } from "./account-block";
import { RailNav, type RailSection } from "./rail-nav";
import { ThemeToggle } from "./theme-toggle";

/** Below 1024: the rail's contents in a sheet docked to the right (navigation.md §5.5). */
export function MenuSheet({
  sections,
  fallback = null,
}: {
  sections: RailSection[];
  fallback?: string | null;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [shownFor, setShownFor] = useState(pathname);
  if (shownFor !== pathname) {
    // The chosen page arrived: the sheet closes on a pathname change.
    setShownFor(pathname);
    setOpen(false);
  }

  function closeOnLink(event: MouseEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest("a[href]")) setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="menu-button">
        <List aria-hidden="true" size={16} weight="regular" />
        Menu
      </DialogTrigger>
      <DialogContent className="menu-sheet" onClick={closeOnLink}>
        <div className="menu-sheet-head">
          <DialogTitle className="menu-sheet-title">Menu</DialogTitle>
          <DialogClose className="menu-sheet-close">Close</DialogClose>
        </div>
        <RailNav sections={sections} fallback={fallback} label="Workspace" />
        <AccountBlock />
        <div className="rail-theme">
          <ThemeToggle />
        </div>
      </DialogContent>
    </Dialog>
  );
}
