import { notFound } from "next/navigation";
import { LotDossier } from "@/components/dossier/lot-dossier";
import { getReader } from "@/data/get-reader";

export default async function LotPage({
  params,
  searchParams,
}: {
  params: Promise<{ context: string; lotId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const [{ context, lotId }, { tab }] = await Promise.all([params, searchParams]);
  const reader = getReader();
  const lot = reader.lot(lotId);
  if (!lot) notFound();

  return (
    <LotDossier
      lot={lot}
      context={context}
      tab={typeof tab === "string" ? tab : undefined}
      workItems={reader.workQueue(context).filter((item) => item.lot.id === lot.id)}
      currency={reader.scenario.facilityCurrency}
      minorDigits={reader.scenario.currencyMinorDigits}
    />
  );
}
