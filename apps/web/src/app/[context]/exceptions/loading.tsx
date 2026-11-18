import {
  exceptionsColumns,
  exceptionsSubtitle,
  exceptionsTitle,
} from "@/components/queue/exceptions-screen";
import { QueueTableSkeleton } from "@/components/queue/queue-table";
import { PageHeader } from "@/components/thetis/page-header";

export default function ExceptionsLoading() {
  return (
    <>
      <PageHeader title={exceptionsTitle} sub={exceptionsSubtitle} />
      <QueueTableSkeleton
        label="Loading exception queue"
        columns={exceptionsColumns}
        widths={["w-28", "w-16", "w-28", "w-64", "w-24", "w-44"]}
      />
    </>
  );
}
