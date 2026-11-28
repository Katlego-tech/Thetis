import { QueueTableSkeleton } from "@/components/queue/queue-table";
import { workQueueColumns, workQueueTitle } from "@/components/queue/work-queue-screen";
import { WorkspaceLoading } from "@/components/shell/workspace-loading";
import { PageHeader } from "@/components/thetis/page-header";

export default function WorkQueueLoading() {
  return (
    <WorkspaceLoading>
      <PageHeader
        title={workQueueTitle}
        aside={<div aria-hidden="true" className="h-8 w-52 max-w-full bg-(--hair)" />}
      />
      <div aria-hidden="true" className="flex flex-wrap gap-2">
        <div className="h-[31px] w-28 bg-(--hair)" />
        <div className="h-[31px] w-[70px] bg-(--hair)" />
        <div className="h-[31px] w-[67px] bg-(--hair)" />
        <div className="h-[31px] w-[75px] bg-(--hair)" />
      </div>
      <QueueTableSkeleton
        label="Loading work queue"
        workQueue
        columns={[...workQueueColumns]}
        widths={["w-28", "w-64", "ml-auto w-28", "ml-auto w-32", "w-24", "w-28"]}
      />
    </WorkspaceLoading>
  );
}
