import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";
import { getBase58Encoder } from "@solana/kit";
import { bottomUpTransformerVisitor, createFromRoot } from "codama";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const idl = JSON.parse(readFileSync(resolve(packageDir, "idl/thetis.json"), "utf8"));
const outDir = resolve(process.argv[2] ?? resolve(packageDir, "src/generated"));

const codama = createFromRoot(rootNodeFromAnchor(idl));

// Two rules the program's account layouts need, applied to the node tree before rendering.
//
// 1. One authority PDA. Every instruction derives its signer's Authority from the same seeds,
//    ["authority", protocol, wallet], but the IDL names the third seed after each instruction's
//    own signer account (lender, signer, wallet), and the converter then renames the colliding
//    PDAs per instruction. Collapse them into the single `authority` PDA with seeds
//    { protocol, wallet }, and point every default at it.
// 2. No defaults on optional accounts. An omitted optional account must stay absent, which the
//    program encodes as its own address, so a default (a PDA, or the SPL Token program) would
//    silently fill a slot the caller left out.
const AUTHORITY_SEED = "authority";
const isAuthorityPda = (pda) => {
  const [constant, protocol, signer] = pda.seeds;
  return (
    pda.seeds.length === 3 &&
    constant?.kind === "constantPdaSeedNode" &&
    constant.value.kind === "bytesValueNode" &&
    constant.value.encoding === "base58" &&
    new TextDecoder().decode(getBase58Encoder().encode(constant.value.data)) === AUTHORITY_SEED &&
    protocol?.kind === "variablePdaSeedNode" &&
    protocol.name === "protocol" &&
    signer?.kind === "variablePdaSeedNode"
  );
};
const rewriteAuthority = bottomUpTransformerVisitor([
  {
    select: "[programNode]",
    transform: (program) => {
      const authorityPdas = program.pdas.filter(isAuthorityPda);
      if (authorityPdas.length === 0) throw new Error("no authority PDA found in the IDL");
      const names = new Set(authorityPdas.map((pda) => pda.name));
      if (!names.has("authority")) throw new Error("expected a PDA named authority");
      const [first] = authorityPdas;
      const canonical = {
        ...first,
        name: "authority",
        seeds: first.seeds.map((seed, index) => (index === 2 ? { ...seed, name: "wallet" } : seed)),
      };
      for (const pda of authorityPdas) {
        if (JSON.stringify(pda.seeds.slice(0, 2)) !== JSON.stringify(canonical.seeds.slice(0, 2)))
          throw new Error(`${pda.name}: authority PDAs must share their first two seeds`);
        if (JSON.stringify(pda.seeds[2].type) !== JSON.stringify(canonical.seeds[2].type))
          throw new Error(`${pda.name}: authority PDAs must share their wallet seed type`);
      }
      let repointed = 0;
      const instructions = program.instructions.map((instruction) => ({
        ...instruction,
        accounts: instruction.accounts.map((account) => {
          const value = account.defaultValue;
          if (account.isOptional && value !== undefined) {
            const { defaultValue: _dropped, ...rest } = account;
            return rest;
          }
          if (value?.kind === "pdaValueNode" && names.has(value.pda.name)) {
            const seeds = value.seeds.map((seed, index) =>
              index === 1 ? { ...seed, name: "wallet" } : seed,
            );
            if (seeds.length !== 2 || seeds[0].name !== "protocol")
              throw new Error(`${instruction.name}.${account.name}: unexpected authority seeds`);
            repointed += 1;
            return {
              ...account,
              defaultValue: { ...value, pda: { ...value.pda, name: "authority" }, seeds },
            };
          }
          return account;
        }),
      }));
      if (repointed === 0) throw new Error("no authority default was repointed");
      const others = program.pdas.filter((pda) => !names.has(pda.name));
      return { ...program, pdas: [canonical, ...others], instructions };
    },
  },
]);
codama.update(rewriteAuthority);

// 3. Stable PDA names. The converter names a PDA after the account that holds it and renames
//    a collision after its instruction, so a new instruction with an account of the same name
//    can take over an existing PDA's name. The release intent's PDA (["release", loan, nonce])
//    keeps `intent`, and the loading intent's (["loading", position, nonce]) is `loadingIntent`.
const PDA_NAMES = { release: "intent", loading: "loadingIntent" };
const constantSeed = (pda) => {
  const [constant] = pda.seeds;
  if (constant?.kind !== "constantPdaSeedNode" || constant.value.kind !== "bytesValueNode")
    return undefined;
  if (constant.value.encoding !== "base58") return undefined;
  return new TextDecoder().decode(getBase58Encoder().encode(constant.value.data));
};
const renamePdas = bottomUpTransformerVisitor([
  {
    select: "[programNode]",
    transform: (program) => {
      const renames = new Map();
      for (const pda of program.pdas) {
        const name = PDA_NAMES[constantSeed(pda)];
        if (name !== undefined) renames.set(pda.name, name);
      }
      if (renames.size !== Object.keys(PDA_NAMES).length)
        throw new Error("expected one release and one loading intent PDA");
      const pdas = program.pdas.map((pda) =>
        renames.has(pda.name) ? { ...pda, name: renames.get(pda.name) } : pda,
      );
      const instructions = program.instructions.map((instruction) => ({
        ...instruction,
        accounts: instruction.accounts.map((account) => {
          const value = account.defaultValue;
          if (value?.kind !== "pdaValueNode" || !renames.has(value.pda.name)) return account;
          return {
            ...account,
            defaultValue: { ...value, pda: { ...value.pda, name: renames.get(value.pda.name) } },
          };
        }),
      }));
      return { ...program, pdas, instructions };
    },
  },
]);
codama.update(renamePdas);
{
  const { program } = codama.getRoot();
  const optional = program.instructions.flatMap((i) => i.accounts).filter((a) => a.isOptional);
  if (optional.length === 0) throw new Error("expected optional accounts in the IDL");
  if (optional.some((a) => a.defaultValue !== undefined))
    throw new Error("an optional account kept a default value");
  const authorityPdas = program.pdas.filter(isAuthorityPda);
  if (authorityPdas.length !== 1 || authorityPdas[0].name !== "authority")
    throw new Error("expected exactly one authority PDA, named authority");
}

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

// The parsers read an omitted optional account as the program's own address. Compare with the
// instruction's own programAddress (which a caller may override), not the default program.
const OPTIONAL_DEFAULT =
  "accountMeta.address === THETIS_PROGRAM_ADDRESS ? undefined : accountMeta;";
const OPTIONAL_OWN =
  "accountMeta.address === instruction.programAddress ? undefined : accountMeta;";
const withOptional = idl.instructions.filter((instruction) =>
  instruction.accounts.some((account) => account.optional),
).length;
let optionalParsers = 0;
for (const name of readdirSync(instructionsDir)) {
  if (name === "index.ts") continue;
  const file = join(instructionsDir, name);
  const source = readFileSync(file, "utf8");
  const count = source.split(OPTIONAL_DEFAULT).length - 1;
  if (source.includes("THETIS_PROGRAM_ADDRESS ? undefined")) {
    if (count !== 1) throw new Error(`${name}: expected exactly one optional-account comparison`);
    writeFileSync(file, source.replace(OPTIONAL_DEFAULT, OPTIONAL_OWN));
    optionalParsers += 1;
  }
}
if (optionalParsers !== withOptional)
  throw new Error(
    `rewrote ${optionalParsers} optional-account parsers, the IDL has ${withOptional}`,
  );
