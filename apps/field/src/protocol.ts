// Which Thetis instance this phone works in: read from the index after sign-in, never built in.

export interface ProtocolContext {
  protocol: string;
  instanceIdHex: string;
  instanceLabel: string;
  settlementMode: string;
  indexStatus: string;
  lastSuccessAt: string | null;
}

export interface CheckpointRow {
  protocol: string;
  status: string;
  indexed_through_slot: number | string | null;
  last_success_at: string | null;
  halt_reason: string | null;
}

export interface ProtocolRow {
  instance_id_hex: string;
  settlement_mode: string;
}

export type ProtocolResult = { kind: "ready"; context: ProtocolContext } | { kind: "none" };

/** The instance id as ASCII when every byte is printable ("fiat-demo-run-01"), else the hex. */
export function instanceLabel(hex: string): string {
  const bytes = hex.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [];
  if (bytes.length === 0 || bytes.some((b) => b < 0x21 || b > 0x7e)) return hex;
  return String.fromCharCode(...bytes);
}

export function resolveProtocol(
  checkpoints: readonly CheckpointRow[],
  protocolRow: ProtocolRow | null,
): ProtocolResult {
  const [only, ...others] = checkpoints;
  if (!only || others.length > 0 || !protocolRow) return { kind: "none" };
  return {
    kind: "ready",
    context: {
      protocol: only.protocol,
      instanceIdHex: protocolRow.instance_id_hex,
      instanceLabel: instanceLabel(protocolRow.instance_id_hex),
      settlementMode: protocolRow.settlement_mode,
      indexStatus: only.status,
      lastSuccessAt: only.last_success_at,
    },
  };
}

/** A command is only shown for signing when it belongs to the instance this phone reads. */
export function isSameProtocol(
  command: { protocol: string },
  context: Pick<ProtocolContext, "protocol">,
): boolean {
  return command.protocol === context.protocol;
}

export const OTHER_INSTANCE =
  "This command is for another Thetis instance than the one this phone is reading.";
