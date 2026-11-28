import type { Metadata } from "next";
import { notFound, unstable_rethrow } from "next/navigation";
import { FacilitiesPanel } from "@/components/queue/facilities-panel";
import { getQueueData, WorkQueueScreen } from "@/components/queue/work-queue-screen";
import { LiveFailurePage } from "@/components/shell/live-read-failed";
import { LiveShell } from "@/components/shell/live-shell";
import { LiveDataError, type LiveReader } from "@/data/live/types";
import { requireReader } from "@/data/load-reader";
import type { Context } from "@/data/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Work queue" };

export default async function WorkQueuePage({
  params,
  searchParams,
}: {
  params: Promise<{ context: string }>;
  searchParams: Promise<{ filter?: string | string[] }>;
}) {
  const [{ context }, { filter }] = await Promise.all([params, searchParams]);
  const query = typeof filter === "string" ? `?${new URLSearchParams({ filter })}` : "";
  let data: ReturnType<typeof getQueueData> | null;
  let live: { reader: LiveReader; current: Context } | null = null;
  try {
    const reader = await requireReader(`/${encodeURIComponent(context)}/queue${query}`);
    if (reader.mode === "live") {
      const current = reader.context(context);
      if (!current) notFound();
      live = { reader, current };
    }
    data = getQueueData(reader, context);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof LiveDataError) return <LiveFailurePage error={error} />;
    console.error("Could not load the work queue", error);
    data = null;
  }

  const screen = (
    <WorkQueueScreen
      organisationId={context}
      data={data}
      filter={typeof filter === "string" ? filter : undefined}
      now={Date.now()}
      panel={
        live && live.current.role === "lender" ? (
          <FacilitiesPanel
            facilities={live.reader.facilities(context)}
            context={context}
            organisationId={live.reader.orgIdOf(context)}
            borrowers={live.reader.organisationsByRole("Exporter").flatMap((exporter) => {
              const id = live?.reader.orgIdOf(exporter.id) ?? null;
              return id === null ? [] : [{ value: id, label: exporter.name }];
            })}
          />
        ) : null
      }
    />
  );
  if (!live) return screen;
  return (
    <LiveShell reader={live.reader} current={live.current} fallback={`/${context}/queue`}>
      {screen}
    </LiveShell>
  );
}
