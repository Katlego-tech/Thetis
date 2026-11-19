import Link from "next/link";
import type { ReactNode } from "react";
import { ResultTable } from "@/components/thetis/result-table";
import { Button } from "@/components/ui/button";

type TableProps = Parameters<typeof ResultTable>[0];

export const lotIdClass = "font-mono text-[13px] font-medium";

export function QueueTable({
  columns,
  rows,
  workQueue = false,
}: TableProps & { workQueue?: boolean }) {
  return (
    <div
      className={`[&_th:last-child]:text-transparent min-[768px]:max-[1100px]:[&_td]:px-2 min-[768px]:max-[1100px]:[&_th]:px-2 ${workQueue ? "min-[768px]:[&_td]:py-3.5" : ""}`}
    >
      <ResultTable columns={columns} rows={rows} />
    </div>
  );
}

export function QueueAction({
  href,
  primary,
  children,
}: {
  href: string;
  primary: boolean;
  children: ReactNode;
}) {
  const appearance = primary
    ? "bg-(--act) text-(--act-ink) hover:border-(--ink) hover:bg-(--act)"
    : "border-(--rule) bg-(--sheet) text-(--ink) hover:bg-(--paper)";

  return (
    <Button
      asChild
      variant={primary ? "default" : "outline"}
      className={`inline-block h-auto px-3 py-2 text-[13px] leading-[1.45] font-semibold whitespace-normal transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--act) focus-visible:ring-0 motion-reduce:active:not-aria-[haspopup]:translate-y-0 min-[768px]:whitespace-nowrap ${appearance}`}
    >
      <Link href={href}>{children}</Link>
    </Button>
  );
}

export function QueueTableSkeleton({
  columns,
  widths,
  workQueue = false,
  label,
}: {
  columns: TableProps["columns"];
  widths: string[];
  workQueue?: boolean;
  label: string;
}) {
  const row = Object.fromEntries(
    columns.map(({ key }, index) => [
      key,
      <div key={key} className="space-y-1.5" aria-hidden="true">
        <div
          className={`max-w-full bg-(--hair) ${key === "action" ? "h-9" : "h-4"} ${widths[index]}`}
        />
        {workQueue && ["lot", "task", "quantity", "amount"].includes(key) && (
          <div className={`h-3 max-w-full bg-(--hair) ${widths[index]}`} />
        )}
      </div>,
    ]),
  );

  return (
    <div>
      <span className="sr-only" role="status">
        {label}
      </span>
      <div aria-hidden="true">
        <QueueTable columns={columns} rows={[row, row, row]} workQueue={workQueue} />
      </div>
    </div>
  );
}
