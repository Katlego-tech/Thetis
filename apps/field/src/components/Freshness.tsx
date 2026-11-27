import { formatClock, unixOf } from "../format";
import { Txt } from "./Txt";

/** Every list from the index says how fresh it is, or that the index stopped. */
export function Freshness(props: { lastSuccessAt: string | null; halted: boolean }) {
  if (props.halted) {
    const at = props.lastSuccessAt ? ` at ${formatClock(unixOf(props.lastSuccessAt))}` : "";
    return (
      <Txt variant="small" tone="ink2">
        {`Index halted. This list stopped updating${at} and may be out of date. Issues you sign are still confirmed directly from devnet.`}
      </Txt>
    );
  }
  if (!props.lastSuccessAt) {
    return (
      <Txt variant="small" tone="ink2">
        From the Thetis index.
      </Txt>
    );
  }
  return (
    <Txt variant="small" tone="ink2">
      {`From the Thetis index, as of ${formatClock(unixOf(props.lastSuccessAt))}.`}
    </Txt>
  );
}
