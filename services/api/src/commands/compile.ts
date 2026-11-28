// A command transaction's account split and its size (live-lending.md §4.4.2 and §6.5.6;
// field-app.md folds 9 and 25 and the PR #69 review folds). Pure: no RPC, no database.
import {
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";

/** Devnet's packet limit for one serialised transaction, signatures included. */
export const MAX_TRANSACTION_BYTES = 1_232;
export const COMPUTE_UNITS = 400_000;
/** A nominal compute price, set so a wallet leaves the fee alone (28 Nov: Solflare inserted its
 * own SetComputeUnitPrice into an issued transaction, which then no longer matched). Each issued
 * transaction carries it right after the limit when it still fits MAX_TRANSACTION_BYTES; the few
 * widest shapes compile without it, exactly as before. The sponsor caps it at the same value. */
export const COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 1n;
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111" as Address;
const ED25519 = "Ed25519SigVerify111111111111111111111111111" as Address;

/** Fixed program and sysvar addresses a Thetis instruction names as accounts (PR #69 review
 * folds, amending fold 25). They are constants, never chosen by a caller or derived from a
 * wallet, so they may enter the table whether or not the RPC returns an account for them: the
 * instructions sysvar never has one, so fold 9's existence rule alone kept it static. */
export const FIXED_TABLE_KEYS: ReadonlySet<Address> = new Set([
  "Sysvar1nstructions1111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
] as Address[]);

// Measuring needs a blockhash and a table address; neither changes the size.
const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111" as Blockhash;
const PLACEHOLDER_TABLE = "AddressLookupTab1e1111111111111111111111111" as Address;

/** [SetComputeUnitLimit, (Ed25519), Thetis] (§6.5.6). Compiling adds the compute price right
 * after the limit when the transaction fits with it. */
export function commandInstructions(thetis: Instruction, ed25519: Instruction | null) {
  return [
    getSetComputeUnitLimitInstruction({ units: COMPUTE_UNITS }),
    ...(ed25519 ? [ed25519] : []),
    thetis,
  ] as Instruction[];
}

/** The Thetis instruction's non-signer accounts that could be table entries: every one except
 * the protocol (static, so the sponsor can check it), the signing wallets, the sponsor and the
 * invoked programs. */
export function tableCandidates(
  thetis: Instruction,
  fixed: { protocol: Address; sponsor: Address; signers: Iterable<Address> },
): Address[] {
  const excluded = new Set<Address>([
    fixed.protocol,
    fixed.sponsor,
    ...fixed.signers,
    thetis.programAddress,
    COMPUTE_BUDGET,
    ED25519,
  ]);
  return [
    ...new Set(
      (thetis.accounts ?? [])
        .filter((meta) => meta.role < 2)
        .map((meta) => meta.address)
        .filter((key) => !excluded.has(key)),
    ),
  ];
}

/** The candidates that enter the table: those on chain now (fold 9), the kind's program-signer
 * PDAs from the plan (fold 25) and the fixed program and sysvar addresses. An account the
 * instruction creates and a wallet-derived account that does not exist stay static. */
export function admittedKeys(
  candidates: readonly Address[],
  exists: readonly boolean[],
  programSigners: ReadonlySet<Address>,
): Address[] {
  return candidates.filter(
    (key, index) => exists[index] === true || programSigners.has(key) || FIXED_TABLE_KEYS.has(key),
  );
}

function compileMessage(
  instructions: readonly Instruction[],
  sponsor: Address,
  lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint },
  table: { address: Address; keys: readonly Address[] },
) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(sponsor, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return compileTransaction(
    compressTransactionMessageUsingAddressLookupTables(message, {
      [table.address]: [...table.keys],
    }),
  );
}

/** [limit, price, (Ed25519), Thetis] when that fits; otherwise the instructions as given. The
 * Ed25519 instruction stays right before Thetis, where the program looks for it. */
function compile(
  instructions: readonly Instruction[],
  sponsor: Address,
  lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint },
  table: { address: Address; keys: readonly Address[] },
) {
  const [limit, ...rest] = instructions;
  if (limit?.programAddress === COMPUTE_BUDGET) {
    const price = getSetComputeUnitPriceInstruction({
      microLamports: COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
    });
    const priced = compileMessage([limit, price, ...rest], sponsor, lifetime, table);
    if (getTransactionEncoder().encode(priced).length <= MAX_TRANSACTION_BYTES) return priced;
  }
  return compileMessage(instructions, sponsor, lifetime, table);
}

/** The Thetis instruction's index in an issued transaction: always the last instruction, after
 * the limit, the price when it fitted and the Ed25519 instruction for a text kind. */
export function thetisInstructionIndex(wireBase64: string): number {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wireBase64));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes) as {
    instructions?: readonly unknown[];
  };
  return (message.instructions?.length ?? 0) - 1;
}

/** The serialised size, every signature slot included, with `tableKeys` in the table. A key the
 * live table holds beyond these only makes the real transaction smaller. */
export function measureCommand(
  instructions: readonly Instruction[],
  sponsor: Address,
  tableKeys: readonly Address[],
): number {
  const compiled = compile(
    instructions,
    sponsor,
    { blockhash: PLACEHOLDER_BLOCKHASH, lastValidBlockHeight: 0n },
    { address: PLACEHOLDER_TABLE, keys: tableKeys },
  );
  return getTransactionEncoder().encode(compiled).length;
}

/** The wire transaction against the instance's table, and its size. */
export function compileCommandWire(
  instructions: readonly Instruction[],
  sponsor: Address,
  lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint },
  table: { address: Address; keys: readonly Address[] },
) {
  const compiled = compile(instructions, sponsor, lifetime, table);
  return {
    wire: getBase64EncodedWireTransaction(compiled),
    bytes: getTransactionEncoder().encode(compiled).length,
  };
}
