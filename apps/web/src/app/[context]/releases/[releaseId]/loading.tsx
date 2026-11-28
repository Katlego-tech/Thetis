import { waterfallColumns } from "@/components/release/waterfall-table";
import { WorkspaceLoading } from "@/components/shell/workspace-loading";
import { ResultTable } from "@/components/thetis/result-table";

export default function LoadingRelease() {
  const rows = Array.from({ length: 9 }, () => ({
    line: <div className="h-[20px] w-3/4 rounded-md bg-(--hair)" />,
    amount: <div className="ml-auto h-[20px] w-24 rounded-md bg-(--hair)" />,
    basis: <div className="h-[20px] w-full rounded-md bg-(--hair)" />,
  }));

  return (
    <WorkspaceLoading>
      <p role="status" className="sr-only">
        Loading release review
      </p>
      <div aria-hidden="true" className="flex flex-col gap-5">
        <div className="border-(--ink) border-b-2 pb-3.5">
          <div className="h-8 w-3/5 rounded-md bg-(--hair)" />
          <div className="mt-1.5 h-5 w-1/2 rounded-md bg-(--hair)" />
        </div>
        <div className="h-[35px] rounded-md border border-(--rule) bg-(--sheet)" />
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <ResultTable columns={waterfallColumns} rows={rows} totalRowIndexes={[3, 7]} />
          <div className="flex flex-col gap-3 rounded-md border border-(--rule) bg-(--sheet) p-4">
            <div className="h-5 w-16 rounded-md bg-(--hair)" />
            <div className="h-12 w-2/3 rounded-md bg-(--hair)" />
            <div className="h-12 w-3/4 rounded-md bg-(--hair)" />
            <div className="border-(--hair) border-t pt-3">
              <div className="h-9 rounded-md bg-(--hair)" />
            </div>
          </div>
        </div>
      </div>
    </WorkspaceLoading>
  );
}
