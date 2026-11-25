/**
 * Written by scripts/generate.mjs, not by Codama. Do not edit.
 */

import {
  assertAccountExists,
  assertAccountsExist,
  fetchEncodedAccount,
  fetchEncodedAccounts,
  type Account,
  type Address,
  type ClientWithRpc,
  type Codec,
  type FetchAccountConfig,
  type FetchAccountsConfig,
  type GetAccountInfoApi,
  type GetMultipleAccountsApi,
  type MaybeAccount,
  type MaybeEncodedAccount,
  type ReadonlyUint8Array,
} from '@solana/kit';
import type { SelfFetchFunctions } from '@solana/program-client-core';
import { identifyThetisAccount, THETIS_PROGRAM_ADDRESS, ThetisAccount } from '../programs/thetis.ts';

/** Why an account was refused: another program owns it, or its 8-byte discriminator is wrong. */
export class ThetisAccountError extends Error {
  readonly reason: 'OWNER' | 'DISCRIMINATOR';
  readonly address: string;

  constructor(reason: 'OWNER' | 'DISCRIMINATOR', address: string, kind: ThetisAccount) {
    const name = ThetisAccount[kind];
    super(
      reason === 'OWNER'
        ? `account ${address} is not owned by the thetis program, so it is not a ${name} account`
        : `account ${address} does not carry the ${name} discriminator`,
    );
    this.name = 'ThetisAccountError';
    this.reason = reason;
    this.address = address;
  }
}

/**
 * Returns `account` unchanged when the thetis program owns it and its discriminator is `kind`'s.
 * Throws {@link ThetisAccountError} otherwise.
 */
export function assertThetisAccount<
  T extends { programAddress: Address; data: ReadonlyUint8Array; address: Address },
>(account: T, kind: ThetisAccount): T {
  if (account.programAddress !== THETIS_PROGRAM_ADDRESS) {
    throw new ThetisAccountError('OWNER', account.address, kind);
  }
  let identified: ThetisAccount | undefined;
  try {
    identified = identifyThetisAccount(account);
  } catch {
    identified = undefined;
  }
  if (identified !== kind) throw new ThetisAccountError('DISCRIMINATOR', account.address, kind);
  return account;
}

type AnyObjectCodec = Codec<any, object>;
type InferTFrom<T> = T extends Codec<infer TFrom, any> ? TFrom : never;
type InferTTo<T> = T extends Codec<any, infer TTo> ? TTo : never;

/**
 * Same shape as addSelfFetchFunctions from @solana/program-client-core, but every account goes
 * through `decode` (the guarded decode<Name>) instead of the bare codec.
 */
export function addGuardedSelfFetchFunctions<TCodec extends AnyObjectCodec>(
  client: ClientWithRpc<GetAccountInfoApi & GetMultipleAccountsApi>,
  codec: TCodec,
  decode: (account: MaybeEncodedAccount) => MaybeAccount<InferTTo<TCodec>>,
): SelfFetchFunctions<InferTFrom<TCodec>, InferTTo<TCodec>> & TCodec {
  const fetchMaybe = async (address: Address, config?: FetchAccountConfig) =>
    decode(await fetchEncodedAccount(client.rpc, address, config));
  const fetchAllMaybe = async (addresses: Address[], config?: FetchAccountsConfig) =>
    (await fetchEncodedAccounts(client.rpc, addresses, config)).map((account) => decode(account));
  const fetch = async (address: Address, config?: FetchAccountConfig) => {
    const account = await fetchMaybe(address, config);
    assertAccountExists(account);
    return account as Account<InferTTo<TCodec>>;
  };
  const fetchAll = async (addresses: Address[], config?: FetchAccountsConfig) => {
    const accounts = await fetchAllMaybe(addresses, config);
    assertAccountsExist(accounts);
    return accounts as Account<InferTTo<TCodec>>[];
  };
  return Object.freeze({ ...codec, fetch, fetchAll, fetchAllMaybe, fetchMaybe }) as unknown as
    SelfFetchFunctions<InferTFrom<TCodec>, InferTTo<TCodec>> & TCodec;
}
