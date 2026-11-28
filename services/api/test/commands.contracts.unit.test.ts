// The relay's account filters come from @thetis/contracts' generated codecs, never from a
// hand-written layout. The literals are state.rs's (field-app.md T067r.3 fold 43 and the origin
// read); the generated encoders must agree with them.
import { type Address, getAddressDecoder } from "@solana/kit";
import {
  DocumentKind,
  getDocumentAttestationEncoder,
  getLockAllocationEncoder,
  LockControl,
} from "@thetis/contracts";
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_ATTESTATION_SIZE,
  DOCUMENT_SUBJECT_OFFSET,
  LOCK_POSITION_OFFSET,
} from "../src/commands/plan.ts";

const key = (fill: number) => getAddressDecoder().decode(new Uint8Array(32).fill(fill)) as Address;

describe("account filters from the generated codecs", () => {
  it("finds a lock's position at byte 72, as the program lays it out", () => {
    expect(LOCK_POSITION_OFFSET).toBe(72);
    const encoded = getLockAllocationEncoder().encode({
      protocol: key(1),
      loan: key(2),
      position: key(9),
      quantityKg: 5n,
      control: LockControl[Object.keys(LockControl)[0] as keyof typeof LockControl] as never,
      bump: 255,
    });
    expect([...encoded.subarray(LOCK_POSITION_OFFSET, LOCK_POSITION_OFFSET + 32)]).toStrictEqual(
      new Array(32).fill(9),
    );
  });

  it("finds a document's subject at byte 41, in an account of 159 bytes with a revocation", () => {
    expect(DOCUMENT_SUBJECT_OFFSET).toBe(41);
    expect(DOCUMENT_ATTESTATION_SIZE).toBe(159);
    const encoded = getDocumentAttestationEncoder().encode({
      protocol: key(1),
      kind: DocumentKind.Origin,
      subject: new Uint8Array(32).fill(7),
      version: 1,
      issuer: key(3),
      sha256: new Uint8Array(32).fill(4),
      validUntil: 1n,
      revokedAt: 2n,
      bump: 255,
    });
    expect(encoded.length).toBe(DOCUMENT_ATTESTATION_SIZE);
    expect([
      ...encoded.subarray(DOCUMENT_SUBJECT_OFFSET, DOCUMENT_SUBJECT_OFFSET + 32),
    ]).toStrictEqual(new Array(32).fill(7));
  });
});
