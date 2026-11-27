import Link from "next/link";
import { QuantityBar } from "@/components/thetis/quantity-bar";
import type { LiveLotView } from "@/data/live/types";
import type { WorkItemView } from "@/data/types";
import { formatTonnes } from "@/lib/format";

export const overviewColumns =
  "grid items-start gap-6 min-[1200px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]";
const panel = "grid gap-3 rounded border border-(--rule) bg-(--sheet) p-4";
const panelHeading = "text-base leading-[1.2] font-semibold [font-variation-settings:'wdth'_110]";

export function QuantityPanel({
  lot,
  source = "reference",
}: {
  lot: LiveLotView;
  source?: "reference" | "live";
}) {
  // Live, the bar is the shown position, so the bar and the legend share one basis.
  const totalKg = source === "live" ? lot.position.positionQuantityKg : lot.quantityKg;
  const pledged = lot.position.activeLockedQuantityKg;
  // Live, a release is pending while its intent is open and unexpired (an executed one left the pledge).
  const pending = lot.lending
    ? lot.lending.intents
        .filter(({ status, expired }) => status === "Open" && !expired)
        .reduce((total, { quantityKg }) => total + quantityKg, 0n)
    : lot.releases.reduce((total, { payment, registry, soldLockedQuantityKg }) => {
        if (
          payment === "rejected" ||
          registry.status === "confirmed" ||
          registry.status === "finalized" ||
          registry.status === "failed"
        ) {
          return total;
        }
        return total + soldLockedQuantityKg;
      }, 0n);
  const hidden = lot.lending?.hiddenLockedKg ?? 0n;
  const lenders = Array.from(new Set(lot.locks.map(({ lender }) => lender.name)));
  const legend = [
    {
      label: lenders.length ? `Pledged to ${lenders.join(", ")}` : "Pledged",
      kg: pledged - hidden,
    },
    ...(hidden > 0n ? [{ label: "Pledged to lenders you can't see", kg: hidden }] : []),
    { label: "Pending release within pledge", kg: pending },
    { label: "Available", kg: lot.position.availableKg },
    { label: "Discrepancy", kg: lot.discrepancyKg },
  ];
  const total = formatTonnes(totalKg);
  const holding =
    source === "live" && totalKg > 0n && totalKg !== lot.quantityKg
      ? `${lot.owner.name} holds ${total} of this lot's ${formatTonnes(lot.quantityKg)}.`
      : null;
  const showBar = source === "reference" || totalKg > 0n;
  const barLabel = [
    "Quantity",
    `Total ${total}`,
    ...legend.map(({ label, kg }) => `${label} ${formatTonnes(kg)}`),
  ].join(". ");

  return (
    <section className={panel}>
      <h2 className={`${panelHeading} !mb-0`}>Quantity</h2>
      {holding && <p className="text-[13px]">{holding}</p>}
      {!showBar ? null : pending <= pledged && pledged <= totalKg ? (
        // Use the reader's available quantity in the accessible figure, including reservations.
        <div role="img" aria-label={`${barLabel}.`}>
          <div aria-hidden="true">
            <QuantityBar
              totalKg={totalKg}
              pledgedKg={pledged}
              pendingKg={pending}
              label="Quantity"
            />
          </div>
        </div>
      ) : (
        <p role="alert" className="text-(--refuse)">
          The recorded quantities cannot be shown as a single lot.
        </p>
      )}
      <dl
        className={`grid grid-cols-2 gap-3 text-xs leading-[1.45] ${legend.length > 4 ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}
      >
        {legend.map(({ label, kg }) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="text-[15px] font-semibold tabular-nums">{formatTonnes(kg)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs leading-[1.45] text-(--ink-2)">
        The pending release sits inside the pledged quantity. It is not extra ore.
      </p>
    </section>
  );
}

export function NextPanel({ items, context }: { items: WorkItemView[]; context: string }) {
  return (
    <aside aria-labelledby="dossier-next" className={panel}>
      <h2 id="dossier-next" className={panelHeading}>
        Next
      </h2>
      {items.length === 0 ? (
        <p className="text-(--ink-2)">No work items for this lot.</p>
      ) : (
        <ul className="grid gap-3">
          {items.map((item, index) => {
            const release = item.href.startsWith(`/${context}/releases/`);
            const command = item.href.startsWith(`/${context}/commands/`);
            const tab = item.href.endsWith("?tab=financing")
              ? "financing"
              : item.action === "Approve external hand-off"
                ? "custody"
                : item.action === "Renew valuation"
                  ? "financing"
                  : undefined;
            const href = tab && !item.href.includes("?") ? `${item.href}?tab=${tab}` : item.href;
            const label = command
              ? "Open signing page"
              : release
                ? "Open release sheet"
                : tab === "custody"
                  ? "View custody"
                  : tab === "financing"
                    ? "View financing"
                    : "Open dossier";
            return (
              <li key={item.id} className="border-(--hair) [&+li]:border-t [&+li]:pt-3">
                <p className="font-semibold">{item.action}</p>
                <p className="text-xs leading-[1.45] text-(--ink-2)">{item.blocker}</p>
                <Link
                  className={`mt-3 inline-block self-start rounded border px-3 py-2 text-[13px] font-semibold whitespace-nowrap hover:underline ${
                    index === 0
                      ? "border-(--act) bg-(--act) text-(--act-ink)"
                      : "border-(--rule) bg-(--sheet) text-(--ink)"
                  }`}
                  href={href}
                >
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
