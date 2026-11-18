import { notFound } from "next/navigation";
import { releaseCases } from "@/components/release/case-switch";
import { ReleaseReview } from "@/components/release/release-review";
import { getReader } from "@/data/get-reader";

export default async function ReleasePage({
  params,
  searchParams,
}: {
  params: Promise<{ context: string; releaseId: string }>;
  searchParams: Promise<{ case?: string | string[] }>;
}) {
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
