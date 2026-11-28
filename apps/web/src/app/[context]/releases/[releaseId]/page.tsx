import type { Metadata } from "next";
import { notFound, unstable_rethrow } from "next/navigation";
import { releaseCases } from "@/components/release/case-switch";
import { LiveReleaseReview } from "@/components/release/live-release-review";
import { ReleaseReview } from "@/components/release/release-review";
import { LiveFailurePage } from "@/components/shell/live-read-failed";
import { LiveShell } from "@/components/shell/live-shell";
import { getReader } from "@/data/get-reader";
import { LiveDataError, type ScreenReader } from "@/data/live/types";
import { dataSource, requireReader } from "@/data/load-reader";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Release review" };

export default async function ReleasePage({
  params,
  searchParams,
}: {
  params: Promise<{ context: string; releaseId: string }>;
  searchParams: Promise<{ case?: string | string[] }>;
}) {
  let source: "reference" | "live";
  try {
    source = dataSource();
  } catch (error) {
    if (error instanceof LiveDataError) return <LiveFailurePage error={error} />;
    throw error;
  }
  const [{ context, releaseId }, { case: query }] = await Promise.all([params, searchParams]);

  if (source === "live") {
    // live-lending.md §4.5.4: a visible intent, and no reference cases.
    if (query !== undefined) notFound();
    let reader: ScreenReader;
    try {
      reader = await requireReader(
        `/${encodeURIComponent(context)}/releases/${encodeURIComponent(releaseId)}`,
      );
    } catch (error) {
      unstable_rethrow(error);
      if (error instanceof LiveDataError) return <LiveFailurePage error={error} />;
      throw error;
    }
    if (reader.mode !== "live") notFound();
    const current = reader.context(context);
    if (!current) notFound();
    const release = reader.liveRelease(releaseId, context);
    if (!release) notFound();
    return (
      <LiveShell reader={reader} current={current} fallback={`/${context}/releases/${releaseId}`}>
        <LiveReleaseReview
          release={release}
          scenario={reader.scenario}
          context={context}
          organisationId={reader.orgIdOf(context)}
        />
      </LiveShell>
    );
  }

  const selectedCase = releaseCases.find((name) => name === query);
  if (query !== undefined && selectedCase === undefined) notFound();

  const reader = getReader();
  const release = reader.release(releaseId, selectedCase);
  if (!release) notFound();

  const cases = releaseCases.map((name) => {
    const option = selectedCase === name ? release : reader.release(releaseId, name);
    if (!option) notFound();
    return option;
  });

  return <ReleaseReview release={release} cases={cases} scenario={reader.scenario} />;
}
