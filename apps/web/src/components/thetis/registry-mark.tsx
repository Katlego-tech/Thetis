import type { RegistryStatus } from "@/data/types";

export const registryMarks = {
  not_submitted: { label: "Not on chain", classes: "border-dashed border-(--ink-2) text-(--ink)" },
  draft: { label: "Draft", classes: "border-dashed border-(--ink-2) text-(--ink)" },
  awaiting_signatures: {
    label: "Awaiting signatures",
    classes: "border-dashed border-(--ink) text-(--ink)",
  },
  submitted: {
    label: "Submitted, unconfirmed",
    classes: "border-dashed border-(--ink) text-(--ink)",
  },
  confirmed: { label: "Confirmed", classes: "border-solid border-(--ink) text-(--ink)" },
  finalized: {
    label: "Finalized",
    classes: "border-solid border-(--ink) text-(--ink) font-semibold",
  },
  failed: { label: "Failed", classes: "border-solid border-(--refuse) text-(--refuse)" },
  outcome_unknown: {
    label: "Outcome unknown",
    classes: "border-dashed border-(--refuse) text-(--refuse)",
  },
} satisfies Record<RegistryStatus, { label: string; classes: string }>;

export function RegistryMark({ status }: { status: RegistryStatus }) {
  const { label, classes } = registryMarks[status];
  return <span className={`thetis-mark border ${classes}`}>{label}</span>;
}
