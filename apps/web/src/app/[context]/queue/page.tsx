import { getQueueData, WorkQueueScreen } from "@/components/queue/work-queue-screen";
import { getReader } from "@/data/get-reader";

export default async function WorkQueuePage({
  params,
  searchParams,
}: {
  params: Promise<{ context: string }>;
  searchParams: Promise<{ filter?: string | string[] }>;
}) {
  const [{ context }, { filter }] = await Promise.all([params, searchParams]);
  let data: ReturnType<typeof getQueueData> | null;
  try {
    data = getQueueData(getReader(), context);
  } catch (error) {
    console.error("Could not load the work queue", error);
    data = null;
  }

  return (
    <WorkQueueScreen
      organisationId={context}
      data={data}
      filter={typeof filter === "string" ? filter : undefined}
      now={Date.now()}
    />
  );
}
