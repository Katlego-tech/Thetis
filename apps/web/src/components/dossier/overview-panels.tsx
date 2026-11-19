import Link from "next/link";
import { QuantityBar } from "@/components/thetis/quantity-bar";
import type { LotView, WorkItemView } from "@/data/types";
import { formatTonnes } from "@/lib/format";

export const overviewColumns =
  "grid items-start gap-6 min-[1200px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]";
const panel = "grid gap-3 rounded border border-(--rule) bg-(--sheet) p-4";
const panelHeading = "text-base leading-[1.2] font-semibold [font-variation-settings:'wdth'_110]";

export function QuantityPanel({ lot }: { lot: LotView }) {
  const pledged = lot.position.activeLockedQuantityKg;
  const pending = lot.releases.reduce((total, { payment, registry, soldLockedQuantityKg }) => {
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
  const lenders = Array.from(new Set(lot.locks.map(({ lender }) => lender.name)));
  const legend = [
    { label: lenders.length ? `Pledged to ${lenders.join(", ")}` : "Pledged", kg: pledged },
    { label: "Pending release within pledge", kg: pending },
    { label: "Available", kg: lot.position.availableKg },
    { label: "Discrepancy", kg: lot.discrepancyKg },
  ];
  const total = formatTonnes(lot.quantityKg);
  const barLabel = [
    "Quantity",
    `Total ${total}`,
    ...legend.map(({ label, kg }) => `${label} ${formatTonnes(kg)}`),
  ].join(". ");

  return (
    <section className={panel}>
      <h2 className={`${panelHeading} !mb-0`}>Quantity</h2>
      {pending <= pledged && pledged <= lot.quantityKg ? (
        // Use the reader's available quantity in the accessible figure, including reservations.
        <div role="img" aria-label={`${barLabel}.`}>
          <div aria-hidden="true">
            <QuantityBar
              totalKg={lot.quantityKg}
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
      <dl className="grid grid-cols-2 gap-3 text-xs leading-[1.45] sm:grid-cols-4">
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
            const tab =
              item.action === "Approve external hand-off"
                ? "custody"
                : item.action === "Renew valuation"
                  ? "financing"
                  : undefined;
            const href = tab ? `${item.href}?tab=${tab}` : item.href;
            const label = release
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
