import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";
import { createFromRoot } from "codama";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const idl = JSON.parse(readFileSync(resolve(packageDir, "idl/thetis.json"), "utf8"));
const outDir = resolve(process.argv[2] ?? resolve(packageDir, "src/generated"));

const codama = createFromRoot(rootNodeFromAnchor(idl));
await codama.accept(
  renderVisitor(outDir, {
    deleteFolderBeforeRendering: true,
    formatCode: false,
    generatedFolder: ".",
    syncPackageJson: false,
    importExtension: "ts",
    erasableSyntax: true,
  }),
);

// The renderer's builders pass `programAddress` through as `X | undefined`, which TypeScript
// rejects under exactOptionalPropertyTypes (the repository default). Consumers compile this
// package's TypeScript with their own settings, so widen the builders' option type to accept it.
const OPTION =
  "config?: { programAddress?: TProgramAddress | { readonly address: TProgramAddress } }";
const WIDENED =
  "config?: { programAddress?: TProgramAddress | { readonly address: TProgramAddress } | undefined }";
const instructionsDir = join(outDir, "instructions");
let widened = 0;
for (const name of readdirSync(instructionsDir)) {
  if (name === "index.ts") continue;
  const file = join(instructionsDir, name);
  const source = readFileSync(file, "utf8");
  const count = source.split(OPTION).length - 1;
  if (count === 0) throw new Error(`${name}: expected the builder config type to rewrite`);
  writeFileSync(file, source.replaceAll(OPTION, WIDENED));
  widened += count;
}
if (widened === 0) throw new Error("no builder config types were rewritten");

// The account guards live inside the generated tree, so the output stands alone in any directory.
// src/checks.ts re-exports the public names from here.
const SHARED_CHECKS = `/**
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
        ? \`account \${address} is not owned by the thetis program, so it is not a \${name} account\`
        : \`account \${address} does not carry the \${name} discriminator\`,
    );
    this.name = 'ThetisAccountError';
    this.reason = reason;
    this.address = address;
  }
}

/**
 * Returns \`account\` unchanged when the thetis program owns it and its discriminator is \`kind\`'s.
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
 * through \`decode\` (the guarded decode<Name>) instead of the bare codec.
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
`;
mkdirSync(join(outDir, "shared"), { recursive: true });
writeFileSync(join(outDir, "shared/checks.ts"), SHARED_CHECKS);

// Account decoders must refuse bytes that are not a thetis account. The renderer's decode<Name>
// checks neither the owner nor the discriminator, so route every existing account through
// assertThetisAccount first. A non-existent account passes through unchanged.
// fetch<Name>, fetchMaybe<Name>, fetchAll<Name> and fetchAllMaybe<Name> all call decode<Name>.
const accountsDir = join(outDir, "accounts");
const IMPORT_ANCHOR = "import { ";
const IMPORT_CHECKS =
  "import { assertThetisAccount } from '../shared/checks.ts';\nimport { ThetisAccount } from '../programs/thetis.ts';\n";
let guarded = 0;
for (const account of idl.accounts) {
  const file = join(
    accountsDir,
    `${account.name.charAt(0).toLowerCase()}${account.name.slice(1)}.ts`,
  );
  const source = readFileSync(file, "utf8");
  const original = `  return decodeAccount(encodedAccount as MaybeEncodedAccount<TAddress>, get${account.name}Decoder());`;
  const guardedText = [
    "  const maybeAccount = encodedAccount as MaybeEncodedAccount<TAddress>;",
    `  if (!('exists' in maybeAccount) || maybeAccount.exists) assertThetisAccount(encodedAccount as EncodedAccount<TAddress>, ThetisAccount.${account.name});`,
    `  return decodeAccount(maybeAccount, get${account.name}Decoder());`,
  ].join("\n");
  if (source.split(original).length - 1 !== 1)
    throw new Error(`${account.name}: expected exactly one decode statement to rewrite`);
  if (!source.startsWith("/**") || source.split(`\n${IMPORT_ANCHOR}`).length < 2)
    throw new Error(`${account.name}: expected an import line to anchor the checks import`);
  const withImport = source.replace(`\n${IMPORT_ANCHOR}`, `\n${IMPORT_CHECKS}${IMPORT_ANCHOR}`);
  writeFileSync(file, withImport.replace(original, guardedText));
  guarded += 1;
}
if (guarded !== idl.accounts.length)
  throw new Error(`guarded ${guarded} account decoders, the IDL has ${idl.accounts.length}`);

// The program plugin (client.thetis.accounts.<name>.fetch...) builds its fetch functions from the
// bare codec with addSelfFetchFunctions, which skips the guard. Build them from the guarded
// decode<Name> instead.
const programFile = join(outDir, "programs/thetis.ts");
let program = readFileSync(programFile, "utf8");
const FETCH_IMPORT =
  "import { addSelfFetchFunctions, addSelfPlanAndSendFunctions, type SelfFetchFunctions, type SelfPlanAndSendFunctions } from '@solana/program-client-core';";
const GUARDED_IMPORT =
  "import { addSelfPlanAndSendFunctions, type SelfFetchFunctions, type SelfPlanAndSendFunctions } from '@solana/program-client-core';\nimport { addGuardedSelfFetchFunctions } from '../shared/checks.ts';";
if (program.split(FETCH_IMPORT).length - 1 !== 1)
  throw new Error("programs/thetis.ts: expected exactly one program-client-core import to rewrite");
program = program.replace(FETCH_IMPORT, GUARDED_IMPORT);
const ACCOUNTS_IMPORT = "from '../accounts/index.ts';";
if (program.split(ACCOUNTS_IMPORT).length - 1 !== 1)
  throw new Error("programs/thetis.ts: expected exactly one accounts import to extend");
program = program.replace(
  ACCOUNTS_IMPORT,
  `${ACCOUNTS_IMPORT}\nimport { ${idl.accounts.map((a) => `decode${a.name}`).join(", ")} } from '../accounts/index.ts';`,
);
let pluginGuarded = 0;
for (const account of idl.accounts) {
  const key = `${account.name.charAt(0).toLowerCase()}${account.name.slice(1)}`;
  const original = `${key}: addSelfFetchFunctions(client, get${account.name}Codec())`;
  const replacement = `${key}: addGuardedSelfFetchFunctions(client, get${account.name}Codec(), decode${account.name})`;
  if (program.split(original).length - 1 !== 1)
    throw new Error(`${account.name}: expected exactly one plugin fetch builder to rewrite`);
  program = program.replace(original, replacement);
  pluginGuarded += 1;
}
if (pluginGuarded !== idl.accounts.length || program.includes("addSelfFetchFunctions("))
  throw new Error("not every plugin fetch builder was rewritten");
writeFileSync(programFile, program);

// 64-bit inputs: the renderer types u64/i64 arguments as "number | bigint", and a number above
// 2^53 - 1 has already lost precision before it reaches the encoder. Accept bigint only.
const WIDE = "number | bigint";
let narrowed = 0;
for (const entry of readdirSync(outDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
  const file = join(entry.parentPath, entry.name);
  const source = readFileSync(file, "utf8");
  const count = source.split(WIDE).length - 1;
  if (count === 0) continue;
  writeFileSync(file, source.replaceAll(WIDE, "bigint"));
  narrowed += count;
}
if (narrowed === 0) throw new Error("no 64-bit input types were narrowed to bigint");
