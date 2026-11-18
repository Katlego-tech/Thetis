export function StateMark({
  dimension,
  value,
}: {
  dimension: "Custody" | "Finance" | "Restriction" | "Payment";
  value: string;
}) {
  return (
    <span className="thetis-mark border border-(--ink-2) border-dashed">
      <span className="text-(--ink-2)">{dimension}</span> {value}
    </span>
  );
}
