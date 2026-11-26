import { notFound, unstable_rethrow } from "next/navigation";
import { LotDossier } from "@/components/dossier/lot-dossier";
import { LiveFailurePage } from "@/components/shell/live-read-failed";
import { LiveShell } from "@/components/shell/live-shell";
import { LiveDataError, type ScreenReader } from "@/data/live/types";
import { requireReader } from "@/data/load-reader";

export const dynamic = "force-dynamic";

export default async function LotPage({
  params,
  searchParams,
}: {
  params: Promise<{ context: string; lotId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const [{ context, lotId }, { tab }] = await Promise.all([params, searchParams]);
  const query = typeof tab === "string" ? `?${new URLSearchParams({ tab })}` : "";
  let reader: ScreenReader;
  try {
    reader = await requireReader(
      `/${encodeURIComponent(context)}/lots/${encodeURIComponent(lotId)}${query}`,
    );
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof LiveDataError) return <LiveFailurePage error={error} />;
    throw error;
  }
  const selectedTab = typeof tab === "string" ? tab : undefined;

  if (reader.mode === "reference") {
    const lot = reader.lot(lotId);
    if (!lot) notFound();
    return (
      <LotDossier
        lot={lot}
        context={context}
        tab={selectedTab}
        workItems={reader.workQueue(context).filter((item) => item.lot.id === lot.id)}
        currency={reader.scenario.facilityCurrency}
        minorDigits={reader.scenario.currencyMinorDigits}
      />
    );
  }

  const current = reader.context(context);
  if (!current) notFound();
  const lot = reader.lot(lotId, context);
  if (!lot) notFound();
  return (
    <LiveShell reader={reader} current={current} segment="lots">
      <LotDossier
        lot={lot}
        context={context}
        tab={selectedTab}
        workItems={reader.workQueue(context).filter((item) => item.lot.id === lot.id)}
        currency={reader.scenario.facilityCurrency}
        minorDigits={reader.scenario.currencyMinorDigits}
        source="live"
        stale={reader.lotStale(lot.id)}
      />
    </LiveShell>
  );
}
