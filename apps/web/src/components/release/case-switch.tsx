import type { ReleaseCase, ReleaseView } from "@/data/types";
import { formatMoney } from "@/lib/format";

export const releaseCases = [
  "sale-2000t-400k",
  "sale-2000t-210k-refused",
  "sale-2000t-210k-topup-30k",
] as const satisfies readonly ReleaseCase[];

export function CaseSwitch({
  cases,
  activeCase,
  minorDigits,
}: {
  cases: ReleaseView[];
  activeCase: ReleaseCase;
  minorDigits: number;
}) {
  return (
    <nav
      aria-label="Release cases"
      className="flex flex-col overflow-hidden rounded-md border border-(--rule) bg-(--sheet) sm:flex-row"
    >
      {cases.map(({ case: releaseCase, currency, inputs }) => {
        const buyer = formatMoney(inputs.buyerAmount, currency, minorDigits);
        const topUp = formatMoney(inputs.sellerTopUp, currency, minorDigits);
        const labels = {
          "sale-2000t-400k": `As requested: ${buyer}`,
          "sale-2000t-210k-refused": `${buyer}, refused`,
          "sale-2000t-210k-topup-30k": `${buyer} plus ${topUp} top-up`,
        } satisfies Record<ReleaseCase, string>;

        return (
          <a
            key={releaseCase}
            href={`?case=${releaseCase}`}
            aria-current={releaseCase === activeCase ? "page" : undefined}
            className="border-(--rule) border-b px-3 py-[7px] text-[13px] last:border-b-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--act) aria-[current=page]:bg-(--ink) aria-[current=page]:font-semibold aria-[current=page]:text-(--sheet) sm:border-r sm:border-b-0 sm:last:border-r-0"
          >
            {labels[releaseCase]}
          </a>
        );
      })}
    </nav>
  );
}
