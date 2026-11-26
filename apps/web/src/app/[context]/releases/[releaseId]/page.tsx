import { notFound } from "next/navigation";
import { releaseCases } from "@/components/release/case-switch";
import { ReleaseReview } from "@/components/release/release-review";
import { LiveFailurePage } from "@/components/shell/live-read-failed";
import { getReader } from "@/data/get-reader";
import { LiveDataError } from "@/data/live/types";
import { dataSource } from "@/data/load-reader";

export const dynamic = "force-dynamic";

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
  // Live mode has no release screen, so fixture data never appears under a live banner.
  if (source === "live") notFound();

  const [{ releaseId }, { case: query }] = await Promise.all([params, searchParams]);
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
