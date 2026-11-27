// Reconcile: the full-state pass. It reads every account of the protocol at the finalized
// commitment, checks that each projection row agrees with it, and only then promotes the rows.

import type { MaybeEncodedAccount } from "@solana/kit";
import { identifyThetisAccount, ThetisAccount } from "@thetis/contracts";
import { HaltError, type HaltReason } from "./errors.ts";
import {
  type AccountData,
  accountColumns,
  CurrencyError,
  type DecodeFailure,
  decodeAccountAs,
  decodeHalt,
  KIND_TABLE,
  type Kind,
  MissingDependency,
  type Resolver,
  UnknownEnumError,
  uuidFromBytes,
} from "./project.ts";
import type { ChainSource } from "./rpc.ts";
import {
  ACCOUNT_COLUMNS,
  EXTRA_COLUMNS,
  PROJECTION_TABLES,
  type ProjectionTable,
  type ReadModelStore,
  type Row,
  type Stream,
  type Upsert,
} from "./store.ts";

export type ReconcileContext = {
  chain: ChainSource;
  store: ReadModelStore;
  stream: Stream;
  signal: () => AbortSignal;
};

/** The kinds the protocol scan returns (memcmp offset 8 = protocol). */
const SCANNED_KINDS: readonly Kind[] = [
  "Authority",
  "ClassPolicy",
  "CustodianClass",
  "DocumentAttestation",
  "IntakeIdentity",
  "Lot",
  "Organisation",
  "Position",
  "Facility",
  "Valuation",
  "Loan",
  "LockAllocation",
  "PaymentAttestation",
  "ReleaseIntent",
  "SimulationPool",
  "Shipment",
  "ManifestBatch",
  "HandoverRecord",
];

/** A PoolShare's size: discriminator, pool, organisation, shares, lent_minor, bump. */
const POOL_SHARE_SIZE = 89;

const sortText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function reconcileHalt(reason: HaltReason, message: string, addresses: string[]): HaltError {
  return new HaltError(
    reason,
    `reconcile: ${message}: ${[...new Set(addresses)].sort(sortText).join(", ")}`,
    null,
  );
}

/**
 * Runs one reconcile pass at the given cursor. Returns "skipped" when the cursor has not reached
 * the finalized scan yet. Throws HaltError (step reconcile) when a rule fails; RPC and store
 * failures propagate for the caller to retry.
 */
export async function reconcile(
  context: ReconcileContext,
  cursor: number | null,
): Promise<"done" | "skipped"> {
  const { chain, store, stream } = context;
  const scan = await chain.getProgramAccounts(
    { offset8: stream.protocol, dataSize: null },
    context.signal(),
  );
  const direct = await chain.getMultipleAccounts(
    [stream.protocol],
    "finalized",
    null,
    context.signal(),
  );
  if (direct.accounts.length !== 1) {
    throw new Error(
      `getMultipleAccounts answered ${direct.accounts.length} accounts for the protocol`,
    );
  }
  const scanSlot = scan.slot;
  const protocolSlot = direct.slot;

  // Rule 1: decode.
  const decoded = new Map<string, AccountData>();
  const failures: DecodeFailure[] = [];
  for (const account of scan.accounts) {
    const address = account.address as string;
    let kind: string;
    try {
      kind = ThetisAccount[identifyThetisAccount(account)];
    } catch {
      failures.push({
        address,
        enumError: false,
        message: "account kind not handled: unidentified",
      });
      continue;
    }
    if (kind === "OrganisationName") continue;
    if (!(SCANNED_KINDS as readonly string[]).includes(kind)) {
      failures.push({ address, enumError: false, message: `account kind not handled: ${kind}` });
      continue;
    }
    const result = decodeAccountAs(
      kind as Kind,
      { ...account, exists: true } as MaybeEncodedAccount,
      stream.protocol,
    );
    if ("failure" in result) failures.push(result.failure);
    else decoded.set(address, result.ok);
  }
  const protocolAccount = direct.accounts[0];
  if (protocolAccount?.exists) {
    const result = decodeAccountAs("Protocol", protocolAccount, stream.protocol);
    if ("failure" in result) failures.push(result.failure);
    else decoded.set(stream.protocol, result.ok);
  }
  if (failures.length > 0) throw decodeHalt("reconcile", failures);

  // The pool-share scan: one per SimulationPool of the protocol scan (offset 8 = pool).
  const shareScans = new Map<string, number>();
  const pools = [...decoded]
    .filter(([, account]) => account.kind === "SimulationPool")
    .map(([address]) => address)
    .sort(sortText);
  for (const pool of pools) {
    const shares = await chain.getProgramAccounts(
      { offset8: pool, dataSize: POOL_SHARE_SIZE },
      context.signal(),
    );
    shareScans.set(pool, shares.slot);
    for (const account of shares.accounts) {
      const address = account.address as string;
      let kind: string;
      try {
        kind = ThetisAccount[identifyThetisAccount(account)];
      } catch {
        kind = "unidentified";
      }
      if (kind !== "PoolShare") {
        failures.push({
          address,
          enumError: false,
          message: `the pool-share scan of ${pool} returned ${kind}`,
        });
        continue;
      }
      const result = decodeAccountAs(
        "PoolShare",
        { ...account, exists: true } as MaybeEncodedAccount,
        stream.protocol,
      );
      if ("failure" in result) failures.push(result.failure);
      else decoded.set(address, result.ok);
    }
  }
  if (failures.length > 0) throw decodeHalt("reconcile", failures);
  if (cursor === null || cursor < Math.max(scanSlot, protocolSlot, ...shareScans.values())) {
    return "skipped";
  }

  const projections = await store.projections(stream);

  // Which scan reads which row: a pool share's is its pool's scan; a share whose pool the
  // protocol scan did not return is read by none (null).
  const scanOf = (table: ProjectionTable, row: Row): number | null => {
    if (table === "chain_protocols") return protocolSlot;
    if (table === "chain_pool_shares") return shareScans.get(row.pool as string) ?? null;
    return scanSlot;
  };
  const stored = (table: ProjectionTable) => projections[table];

  // Rule 2: an account with no projection row.
  const noRow: string[] = [];
  for (const [address, account] of decoded) {
    if (!stored(KIND_TABLE[account.kind]).has(address)) noRow.push(address);
  }
  if (noRow.length > 0) throw reconcileHalt("EVENT_GAP", "accounts with no projection row", noRow);

  // Rule 3: a row older than the scan whose account was not returned.
  const vanished: string[] = [];
  for (const table of PROJECTION_TABLES) {
    for (const [address, row] of stored(table)) {
      const limit = scanOf(table, row) ?? scanSlot;
      if ((row.slot as number) <= limit && !decoded.has(address)) vanished.push(address);
    }
  }
  if (vanished.length > 0)
    throw reconcileHalt("ACCOUNT_VANISHED", "rows whose account is gone", vanished);

  // Rule 4: the account columns, and for a lot, loan, pool or valuation its revision against
  // the event history.
  const organisations = new Map<string, string>();
  const classes = new Map<string, string>();
  const facilities = new Map<string, { lender: string; currencyDecimals: number }>();
  const loans = new Map<string, string>();
  const knownPools = new Set<string>();
  for (const [address, account] of decoded) {
    if (account.kind === "Organisation")
      organisations.set(address, uuidFromBytes(account.data.orgId));
    if (account.kind === "CustodianClass") classes.set(address, account.data.custodian);
    if (account.kind === "Facility") {
      facilities.set(address, {
        lender: account.data.lender,
        currencyDecimals: account.data.currencyDecimals,
      });
    }
    if (account.kind === "Loan") loans.set(address, account.data.facility);
    if (account.kind === "SimulationPool") knownPools.add(address);
  }
  for (const [address, row] of stored("chain_organisations")) {
    if (!organisations.has(address)) organisations.set(address, row.org_id as string);
  }
  for (const [address, row] of stored("chain_custodian_classes")) {
    if (!classes.has(address)) classes.set(address, row.custodian as string);
  }
  for (const [address, row] of stored("chain_facilities")) {
    if (!facilities.has(address)) {
      facilities.set(address, {
        lender: row.lender as string,
        currencyDecimals: row.currency_decimals as number,
      });
    }
  }
  for (const [address, row] of stored("chain_loans")) {
    if (!loans.has(address)) loans.set(address, row.facility as string);
  }
  for (const [address] of stored("chain_pools")) knownPools.add(address);
  const resolver: Resolver = {
    organisationId(address) {
      const known = organisations.get(address);
      if (known === undefined) throw new MissingDependency("chain_organisations", address);
      return known;
    },
    custodianOf(classAddress) {
      const known = classes.get(classAddress);
      if (known === undefined) throw new MissingDependency("chain_custodian_classes", classAddress);
      return known;
    },
    facility(address) {
      const known = facilities.get(address);
      if (known === undefined) throw new MissingDependency("chain_facilities", address);
      return known;
    },
    loanFacility(address) {
      const known = loans.get(address);
      if (known === undefined) throw new MissingDependency("chain_loans", address);
      return known;
    },
    pool(address) {
      if (!knownPools.has(address)) throw new MissingDependency("chain_pools", address);
    },
  };
  const inStep = (account: AccountData, row: Row): boolean => {
    switch (account.kind) {
      case "Lot":
      case "Loan":
      case "SimulationPool":
        return account.data.revision === BigInt(row.event_revision as string);
      case "Valuation":
        return account.data.version === row.event_version;
      case "Shipment":
        return (
          account.data.revision === BigInt(row.event_revision as string) &&
          account.data.registeredCount === row.event_registered
        );
      case "ManifestBatch":
        return (
          account.data.sequence === BigInt(row.event_sequence as string) &&
          account.data.observationCount === row.event_observations
        );
      default:
        return true;
    }
  };

  const changed: string[] = [];
  const upserts: Upsert[] = [];
  for (const table of PROJECTION_TABLES) {
    for (const [address, row] of stored(table)) {
      const limit = scanOf(table, row);
      if (limit === null || (row.slot as number) > limit) continue;
      const account = decoded.get(address) as AccountData;
      let built: Row;
      try {
        built = accountColumns(account, resolver);
      } catch (error) {
        if (error instanceof MissingDependency || error instanceof UnknownEnumError) {
          changed.push(address);
          continue;
        }
        if (error instanceof CurrencyError) {
          throw new HaltError(
            "ACCOUNT_DECODE_FAILED",
            `reconcile: ${address}: ${error.message}`,
            null,
          );
        }
        throw error;
      }
      const same = ACCOUNT_COLUMNS[table].every(
        (column) => JSON.stringify(built[column]) === JSON.stringify(row[column]),
      );
      if (!same || !inStep(account, row)) {
        changed.push(address);
        continue;
      }
      const extras: Row = {};
      for (const column of EXTRA_COLUMNS[table]) extras[column] = row[column] as Row[string];
      upserts.push({
        table,
        row: {
          network: stream.network,
          address,
          protocol: stream.protocol,
          slot: limit,
          commitment: "finalized",
          last_signature: null,
          ...built,
          ...extras,
        },
      });
    }
  }
  if (changed.length > 0)
    throw reconcileHalt("EVENT_GAP", "rows that differ from the account", changed);

  // Slugs and the synthetic flag come from Supabase, for every organisation row.
  const organisationRows = [...stored("chain_organisations")];
  const found = await store.organisationSlugs(
    organisationRows.map(([, row]) => row.org_id as string),
  );
  const entries = organisationRows.map(([address, row]) => {
    const party = found.get(row.org_id as string);
    return { address, slug: party?.slug ?? null, synthetic: party?.synthetic ?? null };
  });
  await store.reconcile(stream, cursor, upserts, entries);
  return "done";
}
