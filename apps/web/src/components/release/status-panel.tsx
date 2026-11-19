import { RegistryMark } from "@/components/thetis/registry-mark";
import { StateMark } from "@/components/thetis/state-mark";
import type { PaymentStatus, ReleaseView } from "@/data/types";

const paymentLabels = {
  reported_by_buyer: "Reported by buyer",
  attested_by_lender: "Attested by lender",
  rejected: "Rejected",
} satisfies Record<PaymentStatus, string>;

export function StatusPanel({
  payment,
  lender,
  registry,
}: Pick<ReleaseView, "payment" | "lender" | "registry">) {
  return (
    <aside
      aria-labelledby="release-status"
      className="flex flex-col gap-3 rounded-md border border-(--rule) bg-(--sheet) p-4"
    >
      <h2 id="release-status">Status</h2>
      <div>
        <StateMark dimension="Payment" value={paymentLabels[payment]} />
        {payment === "reported_by_buyer" && (
          <p className="mt-1.5 text-[12px] text-(--ink-2)">Not yet attested by {lender.name}.</p>
        )}
      </div>
      <div>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="text-(--ink-2)">Release</span>
          <RegistryMark status={registry.status} />
        </div>
        <p className="mt-1.5 text-[12px] text-(--ink-2)">
          Recording needs the seller, the buyer and your attestation.
        </p>
      </div>
      <div className="flex flex-col gap-2 border-(--hair) border-t pt-3">
        <button
          type="button"
          disabled
          aria-describedby="attest-payment-reason"
          className="whitespace-nowrap rounded-md bg-(--hair) px-3 py-2 text-left font-semibold text-[13px] text-(--ink-2)"
        >
          Attest payment
        </button>
        <p id="attest-payment-reason" className="text-[12px] text-(--ink-2)">
          Signing is not available in the design reference. It arrives with wallet and login
          support.
        </p>
      </div>
    </aside>
  );
}
