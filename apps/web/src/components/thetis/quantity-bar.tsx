import { formatBpsPercent, formatTonnes } from "@/lib/format";

export function QuantityBar({
  totalKg,
  pledgedKg,
  pendingKg,
  label,
}: {
  totalKg: bigint;
  pledgedKg: bigint;
  pendingKg: bigint;
  label: string;
}) {
  const pledgedBps = totalKg > 0n ? (pledgedKg * 10000n) / totalKg : 0n;
  const pendingBps = totalKg > 0n ? (pendingKg * 10000n) / totalKg : 0n;
  const accessibleLabel = [
    label,
    `Total ${formatTonnes(totalKg)}`,
    `Pledged ${formatTonnes(pledgedKg)}`,
    `Pending release within pledge ${formatTonnes(pendingKg)}`,
    `Available ${formatTonnes(totalKg - pledgedKg)}`,
  ].join(". ");

  return (
    <div className="quantity-bar" role="img" aria-label={`${accessibleLabel}.`}>
      {pledgedBps > 0n && (
        <div
          data-segment="pledged"
          className="quantity-pledged"
          style={{ width: formatBpsPercent(pledgedBps) }}
        />
      )}
      {pendingBps > 0n && (
        <div
          data-segment="pending"
          className="quantity-pending"
          style={{ width: formatBpsPercent(pendingBps) }}
        />
      )}
    </div>
  );
}
