import type { Metadata } from "next";
import { notFound, unstable_rethrow } from "next/navigation";
import { LotDossier } from "@/components/dossier/lot-dossier";
import { LiveFailurePage } from "@/components/shell/live-read-failed";
import { LiveShell } from "@/components/shell/live-shell";
import { LiveDataError, type ScreenReader } from "@/data/live/types";
import { requireReader } from "@/data/load-reader";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ context: string; lotId: string }>;
}): Promise<Metadata> {
  const { lotId } = await params;
  return { title: `Lot ${lotId}` };
}

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
  // The dossier currency: the primary loan's facility, else the first facility, else none (§7 D).
  const lending = lot.lending;
  const primary = lending?.loans.find(({ address }) => address === lending.primaryLoan);
  const facility = primary?.facility ?? lending?.facilities[0] ?? null;
  const organisationId = reader.orgIdOf(context);
  const actions =
    organisationId === null
      ? null
      : {
          organisationId,
          buyers: reader.organisationsByRole("Buyer").flatMap((buyer) => {
            const id = reader.orgIdOf(buyer.id);
            return id === null ? [] : [{ value: id, label: buyer.name }];
          }),
        };
  return (
    <LiveShell
      reader={reader}
      current={current}
      fallback={`/${context}/lots/${encodeURIComponent(lotId)}`}
    >
      <LotDossier
        lot={lot}
        context={context}
        tab={selectedTab}
        workItems={reader.workQueue(context).filter((item) => item.lot.id === lot.id)}
        currency={facility?.currency ?? null}
        minorDigits={facility?.currencyDecimals ?? null}
        source="live"
        stale={reader.lotStale(lot.id)}
        role={current.role}
        actions={actions}
      />
    </LiveShell>
  );
}
