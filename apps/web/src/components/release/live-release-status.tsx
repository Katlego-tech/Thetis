import Link from "next/link";
import { CommandForm } from "@/components/commands/command-form";
import { livePaymentLabels } from "@/components/dossier/lending-copy";
import { RegistryMark } from "@/components/thetis/registry-mark";
import { StateMark } from "@/components/thetis/state-mark";
import type { LiveReleaseView } from "@/data/live/types";
import { formatDateTime, formatMoney, formatTonnes, minorToInput } from "@/lib/format";

// The release's state as the chain holds it, and the one action this context may take
// (live-lending.md §6.9.3 LiveReleaseStatus, §6.9.5). The program decides; these are display rules.

export function LiveReleaseStatus({
  release,
  context,
  organisationId,
}: {
  release: LiveReleaseView;
  context: string;
  /** the context's organisation uuid; null renders no action */
  organisationId: string | null;
}) {
  const { intent, lender, sale } = release;
  const total = intent.priceMinor + intent.topUpMinor;
  const money = (minor: bigint) => formatMoney(minor, intent.currency, intent.currencyDecimals);
  const open = intent.status === "Open" && !intent.expired;
  const paymentLines = {
    none: `Not yet confirmed by ${lender.name}.`,
    confirmed: `Confirmed by ${lender.name} on chain.`,
    mismatch: `A payment is recorded, but not of ${money(total)}. The lender can correct it.`,
    consumed: "Applied by the sale.",
    voided: `Voided by ${lender.name}.`,
  } satisfies Record<typeof intent.payment, string>;
  const canConfirm =
    organisationId !== null &&
    lender.id === context &&
    open &&
    (intent.payment === "none" || intent.payment === "mismatch");
  const canAccept =
    organisationId !== null &&
    intent.buyer.id === context &&
    open &&
    intent.payment === "confirmed" &&
    sale.command === null;

  return (
    <aside aria-labelledby="release-status" className="work-panel">
      <h2 id="release-status">Status</h2>
      <div>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="text-(--ink-2)">Intent</span>
          <RegistryMark status={intent.registry.status} />
        </div>
        <p className="mt-1.5 text-[12px] text-(--ink-2)">
          {intent.expired && intent.status === "Open"
            ? `Expired ${formatDateTime(intent.expiresAt)}. It can no longer be executed.`
            : `Signed by ${intent.seller.name} and recorded on chain.`}
        </p>
      </div>
      <div>
        <StateMark dimension="Payment" value={livePaymentLabels[intent.payment]} />
        <p className="mt-1.5 text-[12px] text-(--ink-2)">{paymentLines[intent.payment]}</p>
      </div>
      <div>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="text-(--ink-2)">Release</span>
          <RegistryMark status={sale.registry.status} />
        </div>
        <p className="mt-1.5 text-[12px] text-(--ink-2)">
          {intent.status === "Executed"
            ? "Recorded on chain."
            : "Recording needs the buyer's signature after the payment is confirmed."}
        </p>
      </div>
      {sale.command && (
        <Link className="page-link text-[13px]" href={sale.command.href}>
          Open the signing page
        </Link>
      )}
      {organisationId !== null && (canConfirm || canAccept) && (
        <div className="act-row border-(--hair) border-t pt-3">
          {canConfirm && (
            <CommandForm
              action="Confirm payment"
              kind="confirm_payment"
              organisationId={organisationId}
              context={context}
              args={{ loan: intent.loan, purpose: "Release", intent: intent.address }}
              fields={[
                {
                  name: "amountMinor",
                  label: "Amount",
                  kind: "money",
                  currency: intent.currency,
                  digits: intent.currencyDecimals,
                  initial: minorToInput(total, intent.currencyDecimals),
                },
                { name: "bankReference", label: "Bank reference", kind: "text", half: true },
                { name: "observedAt", label: "Observed at", kind: "datetime", half: true },
              ]}
              upload={{
                label: "Bank confirmation",
                ownerOrganisationId: organisationId,
                lotId: intent.lotId,
              }}
              primary
            />
          )}
          {canAccept && (
            <CommandForm
              action="Accept and buy"
              kind="sell_pledged"
              organisationId={organisationId}
              context={context}
              args={{ intent: intent.address }}
              confirm={`Buy ${formatTonnes(intent.quantityKg)} of lot ${intent.lotId} from ${intent.seller.name} for ${money(total)}?`}
              primary
            />
          )}
        </div>
      )}
    </aside>
  );
}
