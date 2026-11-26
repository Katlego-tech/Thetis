import { notFound, unstable_rethrow } from "next/navigation";
import { ExceptionsScreen } from "@/components/queue/exceptions-screen";
import { LiveFailurePage } from "@/components/shell/live-read-failed";
import { LiveShell } from "@/components/shell/live-shell";
import { LiveDataError, type LiveReader } from "@/data/live/types";
import { requireReader } from "@/data/load-reader";
import type { Context, ExceptionView } from "@/data/types";

export const dynamic = "force-dynamic";

export default async function ExceptionsPage({ params }: { params: Promise<{ context: string }> }) {
  const { context } = await params;
  let cases: ExceptionView[] | null;
  let live: { reader: LiveReader; current: Context } | null = null;
  try {
    const reader = await requireReader(`/${encodeURIComponent(context)}/exceptions`);
    if (reader.mode === "live") {
      const current = reader.context(context);
      if (!current) notFound();
      live = { reader, current };
    }
    cases = reader.exceptions(context);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof LiveDataError) return <LiveFailurePage error={error} />;
    console.error("Could not load the exception queue", error);
    cases = null;
  }

  const screen = <ExceptionsScreen organisationId={context} cases={cases} />;
  if (!live) return screen;
  return (
    <LiveShell reader={live.reader} current={live.current} segment="exceptions">
      {screen}
    </LiveShell>
  );
}
