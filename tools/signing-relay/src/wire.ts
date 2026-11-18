import { createHash } from "node:crypto";
import {
  type AccountMeta,
  AccountRole,
  type Address,
  address,
  getAddressEncoder,
  getBase58Decoder,
  getCompiledTransactionMessageEncoder,
  getProgramDerivedAddress,
  type Instruction,
  type ReadonlyUint8Array,
} from "@solana/kit";

export const SIGNER = address("EdSigVfK1DkeMrjFNDMjwfQaJPhPTtX7jW8uPv3oKEgN");
export const EXECUTOR = address("ExecxgyHYsAXB4c5dZodV1zJZ9hqfsDCYkRDRATrpkFR");
export const NONCE = address("Noncediea1fH12usShuQAz28UhgAeuE5Maf32LsMUQB");
export const TRANSITION = address("EjCSGNbrrM7YJBwR9iqnrb87L1TYHfUtZ5L4gwQjWLFg");
export const SLOT_HASHES = address("SysvarS1otHashes111111111111111111111111111");
export const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
export const SYSTEM = address("11111111111111111111111111111111");
export const LOOKUP = address("AddressLookupTab1e1111111111111111111111111");
export const QUANTITY = 2_000_000n;
export const NONCE_SPACE = 72;

export type Role = "sender" | "receiver";
export interface Party {
  wallet: Address;
  party: Address;
  signer: Address;
}
export interface RelayState {
  program: Address;
  batchId: string;
  batch: Address;
  sender: Party;
  receiver: Party;
  nonce: Address;
  lookupTable: Address;
}

export const account = (address: Address, role = AccountRole.READONLY): AccountMeta => ({
  address,
  role,
});
export const keyBytes = (key: Address) => Buffer.from(getAddressEncoder().encode(key));
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
export const discriminator = (name: string) => sha256(Buffer.from(name)).subarray(0, 8);

export function u64(value: bigint) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

export function u32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

export async function derive(programAddress: Address, ...seeds: (string | Uint8Array)[]) {
  return getProgramDerivedAddress({ programAddress, seeds });
}

export async function deriveParty(program: Address, wallet: Address): Promise<Party> {
  const [[party], [signer]] = await Promise.all([
    derive(program, "party", keyBytes(wallet)),
    derive(SIGNER, "programmatic-signer", keyBytes(wallet)),
  ]);
  return { wallet, party, signer };
}

export function spikeInstruction(
  programAddress: Address,
  name: string,
  accounts: AccountMeta[],
  ...args: Uint8Array[]
): Instruction {
  return {
    programAddress,
    accounts,
    data: Buffer.concat([discriminator(`global:${name}`), ...args]),
  };
}

export function batchAddresses(state: Pick<RelayState, "sender" | "receiver" | "batch">) {
  const { sender, receiver, batch } = state;
  return [
    batch,
    sender.wallet,
    sender.party,
    sender.signer,
    receiver.wallet,
    receiver.party,
    receiver.signer,
  ];
}

// Solana v1's Rust compiler sorts raw public key bytes inside each signer/writable group.
// Keep the fee payer first, and include the authority keys without passing them to Execute.
function compileV1(
  payer: Address,
  program: Address,
  accounts: AccountMeta[],
  data: Uint8Array,
  lifetime: Uint8Array,
  authorities: Address[] = [],
) {
  const roles = new Map<Address, AccountRole>([[program, AccountRole.READONLY]]);
  for (const { address, role } of accounts) {
    roles.set(address, (roles.get(address) ?? AccountRole.READONLY) | role);
  }
  for (const key of authorities) {
    roles.set(key, (roles.get(key) ?? AccountRole.READONLY) | AccountRole.READONLY_SIGNER);
  }
  roles.delete(payer);
  const group = (role: AccountRole) =>
    [...roles.entries()]
      .filter(([, value]) => value === role)
      .map(([key]) => key)
      .sort((left, right) => Buffer.compare(keyBytes(left), keyBytes(right)));
  const writableSigners = group(AccountRole.WRITABLE_SIGNER);
  const readonlySigners = group(AccountRole.READONLY_SIGNER);
  const writable = group(AccountRole.WRITABLE);
  const readonly = group(AccountRole.READONLY);
  const signerKeys = [payer, ...writableSigners, ...readonlySigners];
  const staticAccounts = [...signerKeys, ...writable, ...readonly];
  const messageAccounts = [
    account(payer, AccountRole.WRITABLE_SIGNER),
    ...writableSigners.map((key) => account(key, AccountRole.WRITABLE_SIGNER)),
    ...readonlySigners.map((key) => account(key, AccountRole.READONLY_SIGNER)),
    ...writable.map((key) => account(key, AccountRole.WRITABLE)),
    ...readonly.map((key) => account(key)),
  ];
  const bytes = getCompiledTransactionMessageEncoder().encode({
    version: 1,
    header: {
      numSignerAccounts: signerKeys.length,
      numReadonlySignerAccounts: readonlySigners.length,
      numReadonlyNonSignerAccounts: readonly.length,
    },
    configMask: 0,
    configValues: [],
    lifetimeToken: getBase58Decoder().decode(lifetime),
    numInstructions: 1,
    numStaticAccounts: staticAccounts.length,
    staticAccounts,
    instructionHeaders: [
      {
        programAccountIndex: staticAccounts.indexOf(program),
        numInstructionAccounts: accounts.length,
        numInstructionDataBytes: data.length,
      },
    ],
    instructionPayloads: [
      {
        instructionAccountIndices: accounts.map(({ address }) => staticAccounts.indexOf(address)),
        instructionData: data,
      },
    ],
  });
  return { bytes: Buffer.from(bytes), accounts: messageAccounts, signerKeys };
}

export type Authorization = ReturnType<typeof compileV1>;

export function authorize(
  sponsor: Address,
  state: RelayState,
  nonceValue: Uint8Array,
  expiry: bigint,
  sequence: bigint,
  overrides: { authorities?: Address[]; handoverSigners?: [AccountMeta, AccountMeta] } = {},
) {
  const { program, batch, batchId, sender, receiver, nonce } = state;
  const authorities = overrides.authorities ?? [sender.wallet, receiver.wallet];
  const handoverSigners = overrides.handoverSigners ?? [
    account(sender.signer, AccountRole.READONLY_SIGNER),
    account(receiver.signer, AccountRole.READONLY_SIGNER),
  ];
  const handover = spikeInstruction(
    program,
    "handover",
    [
      account(batch, AccountRole.WRITABLE),
      account(sender.party),
      account(receiver.party),
      ...handoverSigners,
    ],
    Buffer.from(batchId, "hex"),
    u64(QUANTITY),
    u64(expiry),
    u64(sequence),
  );
  if (!handover.accounts || !handover.data) throw new Error("Incomplete handover instruction");
  const execution = compileV1(
    handoverSigners[0].address,
    program,
    [...handover.accounts],
    Buffer.from(handover.data),
    nonceValue,
  );

  const executeData = Buffer.concat([Buffer.of(0), execution.bytes]);
  const executeAccounts = [
    account(sponsor, AccountRole.READONLY_SIGNER),
    account(nonce, AccountRole.WRITABLE),
    account(NONCE),
    account(TRANSITION),
    ...execution.accounts.map(({ address, role }) => account(address, role & AccountRole.WRITABLE)),
  ];
  return compileV1(sponsor, EXECUTOR, executeAccounts, executeData, Buffer.alloc(32), authorities);
}

export function submitInstruction(
  authorization: Authorization,
  signatures: ReadonlyMap<Address, ReadonlyUint8Array>,
): Instruction {
  const [sponsor, ...authorities] = authorization.signerKeys;
  if (!sponsor) throw new Error("Authorization is missing the sponsor");
  const signatureParts = authorities.map((authority) => {
    const signature = signatures.get(authority);
    if (signature?.length !== 64) throw new Error(`Missing signature for ${authority}`);
    return Buffer.concat([Buffer.of(1), Buffer.from(signature)]);
  });
  return {
    programAddress: SIGNER,
    accounts: authorization.accounts.map(({ address, role }) =>
      account(address, role & AccountRole.WRITABLE),
    ),
    // Submit tag, u8 vector length, sponsor's None, then each authority's Some(signature).
    data: Buffer.concat([
      Buffer.of(0, authorization.signerKeys.length, 0),
      ...signatureParts,
      authorization.bytes,
    ]),
  };
}
