// Tests for scripts/seed-demo.ts and scripts/deploy-devnet.sh. They live here because
// scripts/ is not a workspace package, so this is the only place `pnpm test` runs vitest for them.
// Nothing here touches a network: the deploy script runs against fake solana/anchor binaries.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountRole, type Address, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import { afterAll, describe, expect, it } from "vitest";
import {
  type AccountReader,
  assertDevnetOnly,
  assertKeysDirOutsideRepo,
  assertNoPending,
  buildAccreditOrganisation,
  buildCreateTestMint,
  buildInitializeProtocol,
  buildOpenPool,
  buildRegisterClass,
  DEFAULT_INSTANCE,
  decideOpenPool,
  decideSimulationSteps,
  decideTestMint,
  derivePoolAddresses,
  diffClass,
  diffMint,
  diffOrganisation,
  diffPool,
  diffProtocol,
  enumName,
  explorerUrl,
  findAssociatedTokenAddress,
  findClassPolicyPda,
  findOrganisationNamePda,
  INSTANCES,
  type InstanceLog,
  instanceByName,
  instanceIdBytes,
  type LoggedTransaction,
  loadOrCreateKey,
  MINT_ACCOUNT_SIZE,
  main,
  mergeSeedLog,
  ownTransactions,
  parseInstance,
  parseSeedOrganisations,
  readSeedLog,
  reconcilePending,
  renderSeedLog,
  SEED,
  SeedError,
  SIMULATION,
  SIMULATION_INSTANCE,
  submitLogged,
  TOKEN_PROGRAM_ADDRESS,
  uuidToBytes,
  wantedClass,
} from "../../../scripts/seed-demo.ts";
import {
  findOrganisationPda,
  findPoolPda,
  findProtocolPda,
  getAccreditOrganisationInstructionDataDecoder,
  getInitializeProtocolInstructionDataDecoder,
  getOpenPoolInstructionDataDecoder,
  getRegisterClassInstructionDataDecoder,
  getSimulationPoolEncoder,
  Role,
  SettlementMode,
  THETIS_PROGRAM_ADDRESS,
} from "../src/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const seedSql = readFileSync(join(repoRoot, "supabase/seed.sql"), "utf8");
const deployScript = join(repoRoot, "scripts/deploy-devnet.sh");
const PROGRAM_ID = "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "thetis-seed-test-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const EXPECTED_ORGS = [
  ["khunou", "Khunou Ore Exports", "exporter", "Exporter"],
  ["kopano", "Kopano Stockyard Custody", "custodian", "Custodian"],
  ["mosela", "Mosela Haulage", "transporter", "Transporter"],
  ["port-t1", "Port Terminal T1", "terminal", "Terminal"],
  ["lender-one", "Lender One Bank", "lender", "Lender"],
  ["lender-two", "Lender Two Bank", "lender", "Lender"],
  ["buyer-smelter", "Buyer Smelter Co", "buyer", "Buyer"],
] as const;

describe("seed.sql parsing", () => {
  const organisations = parseSeedOrganisations(seedSql);

  it("returns the seven organisations with their fixed ids, names and roles", () => {
    expect(organisations).toHaveLength(7);
    organisations.forEach((organisation, index) => {
      const [slug, name, kind, role] = EXPECTED_ORGS[index] as (typeof EXPECTED_ORGS)[number];
      expect(organisation).toMatchObject({
        id: `11000000-0000-4000-8000-00000000000${index + 1}`,
        slug,
        name,
        kind,
        role,
      });
      expect(organisation.orgId).toHaveLength(16);
    });
  });

  it("turns a UUID into its 16 bytes", () => {
    expect(Array.from(uuidToBytes("11000000-0000-4000-8000-000000000007"))).toEqual([
      0x11, 0, 0, 0, 0, 0, 0x40, 0, 0x80, 0, 0, 0, 0, 0, 0, 7,
    ]);
    expect(() => uuidToBytes("not-a-uuid")).toThrow(SeedError);
  });

  it("handles quotes inside names and refuses unknown kinds and missing ids", () => {
    const sql = (row: string, columns = "id, slug, name, kind, synthetic") =>
      `insert into public.organisations (${columns}) values\n  ${row}\non conflict (slug) do nothing;`;
    const id = "11000000-0000-4000-8000-000000000001";
    expect(
      parseSeedOrganisations(sql(`('${id}', 'a', 'O''Neil Ore', 'buyer', true)`))[0]?.name,
    ).toBe("O'Neil Ore");
    expect(() => parseSeedOrganisations(sql(`('${id}', 'a', 'X', 'bank', true)`))).toThrow(
      /no on-chain role/,
    );
    expect(() =>
      parseSeedOrganisations(sql("('a', 'X', 'buyer', true)", "slug, name, kind, synthetic")),
    ).toThrow(/no id column/);
    expect(() => parseSeedOrganisations("select 1;")).toThrow(/no insert/);
  });
});

describe("seed values", () => {
  it("uses an instance id of exactly 16 ASCII bytes", () => {
    const bytes = instanceIdBytes();
    expect(bytes).toHaveLength(16);
    expect(new TextDecoder().decode(bytes)).toBe("fiat-attestation");
  });

  it("round-trips initialize_protocol through the generated decoder", async () => {
    const [deployer, admin, accreditor] = await Promise.all([
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    const instruction = await buildInitializeProtocol({ deployer, admin, accreditor });
    const data = getInitializeProtocolInstructionDataDecoder().decode(
      instruction.data as Uint8Array,
    );
    expect(new TextDecoder().decode(Uint8Array.from(data.instanceId))).toBe("fiat-attestation");
    expect(enumName(SettlementMode, data.settlementMode)).toBe("FiatAttestationTest");
    expect(data.admin).toBe(admin.address);
    expect(data.accreditor).toBe(accreditor.address);
    expect(instruction.programAddress).toBe(THETIS_PROGRAM_ADDRESS);
    const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes() });
    expect(instruction.accounts?.map((account) => account.address)).toContain(protocol);
  });

  it("round-trips register_class CHROME v1 through the generated decoder", async () => {
    const [deployer, admin, accreditor] = await Promise.all([
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    const instruction = await buildRegisterClass({ deployer, admin, accreditor });
    const data = getRegisterClassInstructionDataDecoder().decode(instruction.data as Uint8Array);
    expect(data).toMatchObject({
      classCode: "CHROME",
      version: 1,
      grades: ["G1"],
      originRequired: false,
      lotValiditySecs: 7_776_000n,
      splitInheritsExpiry: true,
    });
    const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes() });
    const classAddress = await findClassPolicyPda(protocol, "CHROME", 1);
    expect(instruction.accounts?.map((account) => account.address)).toContain(classAddress);
  });

  it("round-trips accredit_organisation for each of the seven organisations", async () => {
    const [deployer, accreditor] = await Promise.all([
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes() });
    for (const organisation of parseSeedOrganisations(seedSql)) {
      const orgAdmin = (await generateKeyPairSigner()).address;
      const instruction = await buildAccreditOrganisation(
        { deployer, accreditor },
        organisation,
        orgAdmin,
      );
      const data = getAccreditOrganisationInstructionDataDecoder().decode(
        instruction.data as Uint8Array,
      );
      expect(Array.from(data.orgId)).toEqual(Array.from(organisation.orgId));
      expect(enumName(Role, data.role)).toBe(organisation.role);
      expect(data.displayName).toBe(organisation.name);
      expect(data.admin).toBe(orgAdmin);
      const [organisationAddress] = await findOrganisationPda({
        protocol,
        orgId: organisation.orgId,
      });
      const addresses = instruction.accounts?.map((account) => account.address);
      expect(addresses).toContain(organisationAddress);
      expect(addresses).toContain(await findOrganisationNamePda(protocol, organisation.name));
    }
  });

  it("derives the organisation-name marker from the lowercased display name", async () => {
    const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes() });
    expect(await findOrganisationNamePda(protocol, "Khunou Ore Exports")).toBe(
      await findOrganisationNamePda(protocol, "khunou ore exports"),
    );
    expect(await findOrganisationNamePda(protocol, "Khunou Ore Exports")).not.toBe(
      await findOrganisationNamePda(protocol, "Kopano Stockyard Custody"),
    );
  });
});

describe("skip or stop decisions", () => {
  it("finds no difference when an account already holds the wanted values", () => {
    const protocol = {
      instanceId: instanceIdBytes(),
      settlementMode: SEED.settlementMode,
      admin: "A",
      accreditor: "B",
    };
    expect(diffProtocol(protocol, { ...protocol })).toEqual([]);
    expect(diffClass(wantedClass(), wantedClass())).toEqual([]);
    const organisation = {
      orgId: uuidToBytes("11000000-0000-4000-8000-000000000001"),
      role: "Exporter",
      displayName: "X",
      admin: "C",
    };
    expect(diffOrganisation(organisation, { ...organisation })).toEqual([]);
  });

  it("names each field that differs", () => {
    const protocol = {
      instanceId: instanceIdBytes(),
      settlementMode: "DevnetTokenSimulation",
      admin: "A",
      accreditor: "B",
    };
    expect(
      diffProtocol(protocol, { ...protocol, settlementMode: "FiatAttestationTest", admin: "Z" }),
    ).toEqual([
      "settlementMode: found DevnetTokenSimulation, wanted FiatAttestationTest",
      "admin: found A, wanted Z",
    ]);
    expect(
      diffClass({ ...wantedClass(), grades: ["G2"], lotValiditySecs: 1n }, wantedClass()),
    ).toEqual(["grades: found [G2], wanted [G1]", "lotValiditySecs: found 1, wanted 7776000"]);
    const organisation = {
      orgId: uuidToBytes("11000000-0000-4000-8000-000000000001"),
      role: "Exporter",
      displayName: "X",
      admin: "C",
    };
    expect(diffOrganisation({ ...organisation, role: "Buyer", admin: "D" }, organisation)).toEqual([
      "role: found Buyer, wanted Exporter",
      "admin: found D, wanted C",
    ]);
  });

  it("compares decoded numeric enums by name", () => {
    const protocol = {
      instanceId: instanceIdBytes(),
      settlementMode: 0,
      admin: "A",
      accreditor: "B",
    };
    expect(diffProtocol(protocol, { ...protocol, settlementMode: "FiatAttestationTest" })).toEqual(
      [],
    );
    const organisation = {
      orgId: uuidToBytes("11000000-0000-4000-8000-000000000002"),
      role: 2,
      displayName: "X",
      admin: "C",
    };
    expect(diffOrganisation(organisation, { ...organisation, role: "Custodian" })).toEqual([]);
    expect(diffOrganisation(organisation, { ...organisation, role: "Lender" })).toEqual([
      "role: found Custodian, wanted Lender",
    ]);
  });

  it("links a signature to the devnet explorer", () => {
    expect(explorerUrl("abc")).toBe("https://explorer.solana.com/tx/abc?cluster=devnet");
  });
});

describe("guards", () => {
  it("accepts no override, or an explicit devnet one", () => {
    expect(() => assertDevnetOnly([], {})).not.toThrow();
    expect(() => assertDevnetOnly(["--url", "devnet"], { CLUSTER: "devnet" })).not.toThrow();
    expect(() => assertDevnetOnly(["--url=https://api.devnet.solana.com"], {})).not.toThrow();
  });

  it("refuses a non-devnet --url, cluster environment variable, or unknown argument", () => {
    expect(() => assertDevnetOnly(["--url", "mainnet-beta"], {})).toThrow(/not devnet/);
    expect(() => assertDevnetOnly(["--url=https://api.mainnet-beta.solana.com"], {})).toThrow(
      /not devnet/,
    );
    expect(() => assertDevnetOnly(["--url"], {})).toThrow(/not devnet/);
    expect(() => assertDevnetOnly([], { CLUSTER: "mainnet-beta" })).toThrow(/CLUSTER=mainnet-beta/);
    expect(() => assertDevnetOnly([], { URL: "http://localhost:8899" })).toThrow(/not devnet/);
    expect(() => assertDevnetOnly(["--keypair", "x"], {})).toThrow(/unknown argument/);
  });

  it("refuses a keys directory inside the repository, even one not yet created", () => {
    const outside = tempDir();
    expect(assertKeysDirOutsideRepo(join(outside, "keys"), [repoRoot])).toBe(join(outside, "keys"));
    expect(() => assertKeysDirOutsideRepo(repoRoot, [repoRoot])).toThrow(/inside the repository/);
    expect(() => assertKeysDirOutsideRepo(join(repoRoot, "keys", "devnet"), [repoRoot])).toThrow(
      /inside the repository/,
    );
    expect(() => assertKeysDirOutsideRepo(join(repoRoot, "packages", ".."), [repoRoot])).toThrow(
      SeedError,
    );
  });
});

describe("seed log: pending before send, reconciled on rerun", () => {
  const entry = (
    signature: string,
    status: LoggedTransaction["status"],
    lastValid = "100",
  ): LoggedTransaction => ({
    step: `step-${signature}`,
    signature,
    url: explorerUrl(signature),
    status,
    lastValidBlockHeight: lastValid,
  });

  // A fake RPC: statuses by signature, a fixed block height, and a record of what was asked.
  function fakeRpc(
    statuses: Record<string, { err: unknown; confirmationStatus: string | null }>,
    height: bigint,
  ) {
    const asked: string[][] = [];
    let heightCalls = 0;
    return {
      asked,
      heightCalls: () => heightCalls,
      rpc: {
        getSignatureStatuses: (
          signatures: readonly string[],
          config: { searchTransactionHistory: boolean },
        ) => {
          expect(config.searchTransactionHistory).toBe(true);
          asked.push([...signatures]);
          return { send: async () => ({ value: signatures.map((sig) => statuses[sig] ?? null) }) };
        },
        getBlockHeight: () => {
          heightCalls += 1;
          return { send: async () => height };
        },
      },
    };
  }

  it("records the signature as pending before sending, and confirmed after", async () => {
    const entries: LoggedTransaction[] = [];
    const snapshots: string[] = [];
    const persist = () => snapshots.push(JSON.stringify(entries.map((e) => e.status)));
    await submitLogged(
      entries,
      { step: "initialize_protocol", signature: "sigA", lastValidBlockHeight: 150n },
      async () => {
        expect(snapshots).toEqual(['["pending"]']);
        expect(entries[0]).toMatchObject({ signature: "sigA", lastValidBlockHeight: "150" });
      },
      persist,
    );
    expect(snapshots).toEqual(['["pending"]', '["confirmed"]']);
    expect(entries[0]?.url).toBe("https://explorer.solana.com/tx/sigA?cluster=devnet");
  });

  it("leaves the entry pending, with its link, when the send throws", async () => {
    const entries: LoggedTransaction[] = [];
    await expect(
      submitLogged(
        entries,
        { step: "register_class", signature: "sigB", lastValidBlockHeight: 9n },
        async () => {
          throw new Error("timed out waiting for confirmation");
        },
        () => {},
      ),
    ).rejects.toThrow(/timed out/);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "pending", url: explorerUrl("sigB") });
  });

  it("settles pending entries from their on-chain status and keeps their links", async () => {
    const entries = [
      entry("landed", "pending"),
      entry("finalized", "pending"),
      entry("broken", "pending"),
      entry("done", "confirmed"),
    ];
    const fake = fakeRpc(
      {
        landed: { err: null, confirmationStatus: "confirmed" },
        finalized: { err: null, confirmationStatus: "finalized" },
        broken: { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" },
      },
      50n,
    );
    await reconcilePending(fake.rpc, entries);
    expect(entries.map((e) => e.status)).toEqual(["confirmed", "confirmed", "failed", "confirmed"]);
    expect(fake.asked).toEqual([["landed", "finalized", "broken"]]);
    expect(fake.heightCalls()).toBe(0);
    expect(entries[0]?.url).toBe(explorerUrl("landed"));
  });

  it("keeps an unseen transaction pending until its blockhash has expired", async () => {
    const entries = [entry("unseen", "pending", "100"), entry("processed", "pending", "100")];
    const statuses = { processed: { err: null, confirmationStatus: "processed" } };
    await reconcilePending(fakeRpc(statuses, 100n).rpc, entries);
    expect(entries.map((e) => e.status)).toEqual(["pending", "pending"]);
    expect(() => assertNoPending(entries, "step-unseen")).toThrow(/still pending/);
    expect(() => assertNoPending(entries, "step-other")).not.toThrow();

    await reconcilePending(fakeRpc(statuses, 101n).rpc, entries);
    expect(entries.map((e) => e.status)).toEqual(["expired", "expired"]);
    expect(() => assertNoPending(entries, "step-unseen")).not.toThrow();
  });

  it("asks nothing when there is nothing pending", async () => {
    const fake = fakeRpc({}, 1n);
    await reconcilePending(fake.rpc, [entry("done", "confirmed")]);
    expect(fake.asked).toEqual([]);
  });
});

describe("key files", () => {
  it("creates a mode-600 Solana keypair file once and reloads the same key", async () => {
    const dir = tempDir();
    const first = await loadOrCreateKey(dir, "admin");
    const path = join(dir, "admin.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
    expect(bytes).toHaveLength(64);
    expect(Array.from(getAddressEncoder().encode(first.address))).toEqual(bytes.slice(32));
    const second = await loadOrCreateKey(dir, "admin");
    expect(second.address).toBe(first.address);
    expect((await loadOrCreateKey(dir, "accreditor")).address).not.toBe(first.address);
  });
});

describe("deploy-devnet.sh", () => {
  function run(script: string, args: string[], env: Record<string, string>) {
    return spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: tempDir(), ...env },
    });
  }

  it("refuses a non-devnet cluster before running anything", () => {
    const keys = tempDir();
    for (const [args, env] of [
      [["--url", "mainnet-beta"], {}],
      [["--cluster=mainnet-beta"], {}],
      [[], { CLUSTER: "mainnet-beta" }],
      [[], { URL: "https://api.mainnet-beta.solana.com" }],
      [["--unknown"], {}],
    ] as const) {
      const result = run(deployScript, [...args], { THETIS_KEYS_DIR: keys, ...env });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/refusing/);
    }
  });

  it("refuses THETIS_KEYS_DIR inside the repository", () => {
    const result = run(deployScript, [], { THETIS_KEYS_DIR: join(repoRoot, "keys") });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/inside the repository/);
  });

  it("stops when the program keypair, declare_id! or Anchor.toml names another id", () => {
    const check = (pubkey: string, libId: string, anchorId: string) => {
      const dir = tempDir();
      writeFileSync(join(dir, "lib.rs"), `declare_id!("${libId}");\n`);
      writeFileSync(join(dir, "Anchor.toml"), `[programs.devnet]\nthetis = "${anchorId}"\n`);
      return spawnSync(
        "bash",
        [
          "-c",
          `source "${deployScript}"; check_program_id "${pubkey}" "${dir}/lib.rs" "${dir}/Anchor.toml"`,
        ],
        { encoding: "utf8" },
      );
    };
    expect(check(PROGRAM_ID, PROGRAM_ID, PROGRAM_ID).status).toBe(0);
    const wrong = "2sJZyhjeSApWJuojVm8tHfiziPSDnujZJ1mH5UyRhgze";
    expect(check(wrong, PROGRAM_ID, PROGRAM_ID).stderr).toMatch(/thetis-keypair.json is/);
    expect(check(PROGRAM_ID, wrong, PROGRAM_ID).stderr).toMatch(/declare_id!/);
    expect(check(PROGRAM_ID, PROGRAM_ID, wrong).stderr).toMatch(/Anchor.toml names thetis/);
  });

  // A throwaway copy of the repo layout the script reads, with fake solana, solana-keygen, anchor and
  // date that record their arguments. No real binary runs and nothing reaches a network.
  // `onChainLength` is the program data length the fake devnet reports; null means not deployed yet.
  function fakeRepo(balance: number, onChainLength: number | null = null) {
    const root = tempDir();
    const bin = join(root, "bin");
    const repo = join(root, "repo");
    const keys = join(root, "keys");
    mkdirSync(bin);
    for (const dir of ["scripts", "programs/thetis/src", "target/deploy"]) {
      mkdirSync(join(repo, dir), { recursive: true });
    }
    copyFileSync(deployScript, join(repo, "scripts/deploy-devnet.sh"));
    writeFileSync(join(repo, "programs/thetis/src/lib.rs"), `declare_id!("${PROGRAM_ID}");\n`);
    writeFileSync(join(repo, "Anchor.toml"), `[programs.localnet]\nthetis = "${PROGRAM_ID}"\n`);
    writeFileSync(join(repo, "target/deploy/thetis-keypair.json"), "program-keypair");
    writeFileSync(join(repo, "target/deploy/thetis.so"), Buffer.alloc(1000));
    mkdirSync(keys, { mode: 0o700 });
    writeFileSync(join(keys, "deployer.json"), "deployer-keypair");
    const log = join(root, "calls.log");
    const state = join(root, "deployed");
    const fake = (name: string, body: string) => {
      writeFileSync(
        join(bin, name),
        `#!/usr/bin/env bash\necho "${name} $*" >>"${log}"\n${body}\n`,
      );
      chmodSync(join(bin, name), 0o755);
    };
    fake(
      "solana-keygen",
      `case "$2" in *thetis-keypair.json) echo ${PROGRAM_ID};; *) echo DeployerPubkey;; esac`,
    );
    fake("anchor", "exit 0");
    fake("date", "echo 20260101T000000Z");
    const show =
      onChainLength === null
        ? `if [ -f "${state}" ]; then echo "Data Length: 1000 (0x3e8) bytes"; else echo "Unable to find the account ${PROGRAM_ID}" >&2; exit 1; fi`
        : `echo "Data Length: ${onChainLength} (0x0) bytes"`;
    fake(
      "solana",
      `case "$1 $2" in
  "config set") ;;
  "program show") ${show} ;;
  "program deploy") touch "${state}" ;;
  "program extend") ;;
  *) case "$1" in rent) echo "Rent-exempt minimum: 7000000 lamports";; balance) echo "${balance} lamports";; *) echo ok;; esac ;;
esac`,
    );
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, THETIS_KEYS_DIR: keys };
    const runIt = () =>
      spawnSync("bash", [join(repo, "scripts/deploy-devnet.sh")], { encoding: "utf8", env });
    const calls = () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => /^(solana|anchor) /.test(line));
    return { repo, keys, root, runIt, calls };
  }

  it("deploys to devnet only, through a dedicated config, with a private keypair backup", () => {
    const { repo, keys, runIt, calls } = fakeRepo(10_000_000_000);
    const result = runIt();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Funding case: fresh deploy");
    const all = calls();
    expect(all.length).toBeGreaterThanOrEqual(6);
    const setCall = all.find((call) => call.startsWith("solana config set")) as string;
    expect(setCall).toMatch(
      /--config \S+\/config\.yml --url https:\/\/api\.devnet\.solana\.com --ws wss:\/\/api\.devnet\.solana\.com\/ --keypair /,
    );
    const configPath = /--config (\S+)/.exec(setCall)?.[1] as string;
    for (const call of all.filter((c) => c.startsWith("solana "))) {
      expect(call, call).toContain(`--config ${configPath}`);
      if (!call.startsWith("solana config set")) expect(call, call).toMatch(/--url devnet/);
    }
    expect(existsSync(dirname(configPath))).toBe(false); // the trap removed it
    expect(
      all.some((call) => call.startsWith("anchor build --provider.cluster devnet -p thetis")),
    ).toBe(true);
    const deploy = all.find((call) => call.startsWith("solana program deploy")) as string;
    expect(deploy).toContain(`--program-id ${repo}/target/deploy/thetis-keypair.json`);
    expect(deploy).toContain(`--upgrade-authority ${keys}/deployer.json`);
    expect(all.at(-1)).toMatch(
      new RegExp(`^solana program show ${PROGRAM_ID} --config \\S+ --url devnet$`),
    );
    expect(all.some((call) => call.startsWith("solana program extend"))).toBe(false);

    const backup = join(keys, "backup", "20260101T000000Z");
    expect(statSync(backup).mode & 0o777).toBe(0o700);
    for (const file of ["deployer.json", "thetis-keypair.json"]) {
      expect(statSync(join(backup, file)).mode & 0o777).toBe(0o600);
    }
    expect(result.stdout).toContain(backup);
  });

  it("refuses an existing backup directory, and a backup path that leads into the repository", () => {
    const existing = fakeRepo(10_000_000_000);
    mkdirSync(join(existing.keys, "backup", "20260101T000000Z"), { recursive: true });
    const refusedExisting = existing.runIt();
    expect(refusedExisting.status).toBe(1);
    expect(refusedExisting.stderr).toMatch(/already exists/);
    expect(existing.calls().some((call) => call.startsWith("solana program deploy"))).toBe(false);

    const linked = fakeRepo(10_000_000_000);
    symlinkSync(join(linked.repo, "scripts"), join(linked.keys, "backup"));
    const refusedLink = linked.runIt();
    expect(refusedLink.status).toBe(1);
    expect(refusedLink.stderr).toMatch(/inside the repository/);
    expect(linked.calls().some((call) => call.startsWith("solana program deploy"))).toBe(false);
    expect(existsSync(join(linked.repo, "scripts", "20260101T000000Z"))).toBe(false);
  });

  it("stops with the shortfall when a fresh deploy is underfunded", () => {
    const { runIt, calls } = fakeRepo(1_000_000);
    const result = runIt();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Short by 513000000 lamports"); // 2 x 7,000,000 + 500,000,000 - 1,000,000
    expect(calls().some((call) => call.startsWith("solana program deploy"))).toBe(false);
  });

  it("asks only for one buffer plus the margin when upgrading a program of the same size", () => {
    const enough = fakeRepo(507_000_000, 1000); // 7,000,000 + 500,000,000
    const ok = enough.runIt();
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("Funding case: upgrade");
    expect(enough.calls().some((call) => call.startsWith("solana program extend"))).toBe(false);

    const short = fakeRepo(506_999_999, 1000);
    const refused = short.runIt();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Short by 1 lamports");
  });

  it("pays for program-data growth and extends before deploying", () => {
    const { runIt, calls } = fakeRepo(514_000_000, 400); // buffer 7,000,000 + growth 7,000,000 + margin
    const result = runIt();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("rent for 600 bytes of growth");
    const all = calls();
    const extendAt = all.findIndex((call) =>
      call.startsWith(`solana program extend ${PROGRAM_ID} 600 `),
    );
    const deployAt = all.findIndex((call) => call.startsWith("solana program deploy"));
    expect(extendAt).toBeGreaterThan(-1);
    expect(deployAt).toBeGreaterThan(extendAt);
    expect(all[extendAt]).toMatch(/--keypair \S+\/deployer\.json --config \S+ --url devnet$/);

    const short = fakeRepo(513_999_999, 400);
    expect(short.runIt().stderr).toContain("Short by 1 lamports");
  });

  it("stops and explains how to create the deployer when deployer.json is missing", () => {
    const { keys, runIt } = fakeRepo(0);
    rmSync(join(keys, "deployer.json"));
    const result = runIt();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("solana-keygen new");
  });
});

// ---------------------------------------------------------------------------------------------
// The token-simulation instance
// ---------------------------------------------------------------------------------------------

const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const decodeAscii = (bytes: ArrayLike<number>) => new TextDecoder().decode(Uint8Array.from(bytes));

describe("instance selection", () => {
  it("defaults to the fiat-attestation instance and leaves its values as they were", () => {
    expect(parseInstance([])).toBe(DEFAULT_INSTANCE);
    expect(parseInstance(["--url", "devnet"])).toBe(DEFAULT_INSTANCE);
    expect(DEFAULT_INSTANCE).toEqual({
      instanceId: "fiat-attestation",
      settlementMode: "FiatAttestationTest",
    });
    expect(SEED).toMatchObject({
      instanceId: "fiat-attestation",
      settlementMode: "FiatAttestationTest",
      classCode: "CHROME",
      classVersion: 1,
      grades: ["G1"],
      originRequired: false,
      lotValiditySecs: 7_776_000n,
      splitInheritsExpiry: true,
    });
    expect(Array.from(instanceIdBytes())).toEqual(Array.from(instanceIdBytes(DEFAULT_INSTANCE)));
    expect(decodeAscii(instanceIdBytes())).toBe("fiat-attestation");
  });

  it("selects token-simulation: the 16 ASCII bytes of its name and DevnetTokenSimulation", () => {
    for (const argv of [["--instance", "token-simulation"], ["--instance=token-simulation"]]) {
      expect(parseInstance(argv)).toBe(SIMULATION_INSTANCE);
      expect(() => assertDevnetOnly(argv, {})).not.toThrow();
    }
    expect(SIMULATION_INSTANCE).toEqual({
      instanceId: "token-simulation",
      settlementMode: "DevnetTokenSimulation",
    });
    const bytes = instanceIdBytes(SIMULATION_INSTANCE);
    expect(bytes).toHaveLength(16);
    expect(decodeAscii(bytes)).toBe("token-simulation");
    expect(Array.from(bytes)).toEqual([
      0x74, 0x6f, 0x6b, 0x65, 0x6e, 0x2d, 0x73, 0x69, 0x6d, 0x75, 0x6c, 0x61, 0x74, 0x69, 0x6f,
      0x6e,
    ]);
    expect(Object.keys(INSTANCES)).toEqual(["fiat-attestation", "token-simulation"]);
    expect(instanceByName("fiat-attestation")).toBe(DEFAULT_INSTANCE);
  });

  it("refuses an unknown or missing instance, a repeated flag, and still any unknown argument", () => {
    expect(() => assertDevnetOnly(["--instance", "mainnet"], {})).toThrow(/not an instance/);
    expect(() => assertDevnetOnly(["--instance"], {})).toThrow(/\(missing\)/);
    expect(() => assertDevnetOnly(["--instance", "toString"], {})).toThrow(/not an instance/);
    expect(() =>
      assertDevnetOnly(["--instance", "token-simulation", "--instance=fiat-attestation"], {}),
    ).toThrow(/more than once/);
    expect(() => assertDevnetOnly(["--keypair", "x"], {})).toThrow(/unknown argument/);
  });

  it("keeps the devnet guard when an instance is chosen", () => {
    expect(() =>
      assertDevnetOnly(["--instance", "token-simulation", "--url", "mainnet-beta"], {}),
    ).toThrow(/not devnet/);
    expect(() =>
      assertDevnetOnly(["--instance", "token-simulation"], { CLUSTER: "mainnet-beta" }),
    ).toThrow(/CLUSTER=mainnet-beta/);
    expect(() =>
      assertDevnetOnly(["--url", "devnet", "--instance", "token-simulation"], {
        CLUSTER: "devnet",
      }),
    ).not.toThrow();
  });
});

describe("simulation instance transactions", () => {
  async function signers() {
    const [deployer, admin, accreditor] = await Promise.all([
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    return { deployer, admin, accreditor };
  }

  it("builds the default instance's instructions as before, and the simulation's under its own protocol", async () => {
    const keys = await signers();
    const [fiatProtocol] = await findProtocolPda({ instanceId: instanceIdBytes() });
    const [simProtocol] = await findProtocolPda({
      instanceId: instanceIdBytes(SIMULATION_INSTANCE),
    });
    expect(simProtocol).not.toBe(fiatProtocol);

    const defaultInit = await buildInitializeProtocol(keys);
    expect(defaultInit).toEqual(await buildInitializeProtocol(keys, DEFAULT_INSTANCE));
    expect(defaultInit.accounts?.map((account) => account.address)).toContain(fiatProtocol);
    expect(await buildRegisterClass(keys)).toEqual(
      await buildRegisterClass(keys, DEFAULT_INSTANCE),
    );

    const init = await buildInitializeProtocol(keys, SIMULATION_INSTANCE);
    const data = getInitializeProtocolInstructionDataDecoder().decode(init.data as Uint8Array);
    expect(decodeAscii(data.instanceId)).toBe("token-simulation");
    expect(enumName(SettlementMode, data.settlementMode)).toBe("DevnetTokenSimulation");
    expect(data.admin).toBe(keys.admin.address);
    expect(data.accreditor).toBe(keys.accreditor.address);
    expect(init.accounts?.map((account) => account.address)).toContain(simProtocol);

    const register = await buildRegisterClass(keys, SIMULATION_INSTANCE);
    expect(
      getRegisterClassInstructionDataDecoder().decode(register.data as Uint8Array),
    ).toMatchObject({
      classCode: "CHROME",
      version: 1,
      grades: ["G1"],
      originRequired: false,
      lotValiditySecs: 7_776_000n,
      splitInheritsExpiry: true,
    });
    const classAddress = await findClassPolicyPda(simProtocol, "CHROME", 1);
    expect(register.accounts?.map((account) => account.address)).toContain(classAddress);
    expect(classAddress).not.toBe(await findClassPolicyPda(fiatProtocol, "CHROME", 1));
  });

  it("accredits the same seven organisations, with the same ids and keys, under the simulation protocol", async () => {
    const keys = await signers();
    const [fiatProtocol] = await findProtocolPda({ instanceId: instanceIdBytes() });
    const [simProtocol] = await findProtocolPda({
      instanceId: instanceIdBytes(SIMULATION_INSTANCE),
    });
    const organisations = parseSeedOrganisations(seedSql);
    expect(organisations).toHaveLength(7);
    for (const organisation of organisations) {
      const orgAdmin = (await generateKeyPairSigner()).address;
      const fiat = await buildAccreditOrganisation(keys, organisation, orgAdmin);
      const sim = await buildAccreditOrganisation(
        keys,
        organisation,
        orgAdmin,
        SIMULATION_INSTANCE,
      );
      // The instruction arguments are identical; only the protocol-derived accounts differ.
      expect(sim.data).toEqual(fiat.data);
      const decoded = getAccreditOrganisationInstructionDataDecoder().decode(
        sim.data as Uint8Array,
      );
      expect(Array.from(decoded.orgId)).toEqual(Array.from(uuidToBytes(organisation.id)));
      expect(decoded.admin).toBe(orgAdmin);
      const [organisationAddress] = await findOrganisationPda({
        protocol: simProtocol,
        orgId: organisation.orgId,
      });
      const addresses = sim.accounts?.map((account) => account.address);
      expect(addresses).toContain(simProtocol);
      expect(addresses).toContain(organisationAddress);
      expect(addresses).toContain(await findOrganisationNamePda(simProtocol, organisation.name));
      expect(addresses).not.toContain(fiatProtocol);
    }
  });

  it("creates the test mint and initialises it in one transaction, with no freeze authority", async () => {
    const [payer, mint, authority] = await Promise.all([
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    const [create, init] = buildCreateTestMint({
      payer,
      mint,
      mintAuthority: authority.address,
      lamports: 1_461_600n,
    });
    expect(create?.programAddress).toBe("11111111111111111111111111111111");
    expect(create?.accounts?.map((account) => [account.address, account.role])).toEqual([
      [payer.address, AccountRole.WRITABLE_SIGNER],
      [mint.address, AccountRole.WRITABLE_SIGNER],
    ]);
    const createBytes = Uint8Array.from(create?.data as Uint8Array);
    const createData = new DataView(createBytes.buffer);
    expect(createData.getUint32(0, true)).toBe(0);
    expect(createData.getBigUint64(4, true)).toBe(1_461_600n);
    expect(createData.getBigUint64(12, true)).toBe(BigInt(MINT_ACCOUNT_SIZE));
    expect(MINT_ACCOUNT_SIZE).toBe(82);
    expect(Array.from(createBytes.slice(20))).toEqual(
      Array.from(getAddressEncoder().encode(TOKEN_PROGRAM_ADDRESS)),
    );

    expect(init?.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(TOKEN_PROGRAM_ADDRESS).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(init?.accounts).toEqual([{ address: mint.address, role: AccountRole.WRITABLE }]);
    const initData = init?.data as Uint8Array;
    expect(initData).toHaveLength(35);
    expect(initData[0]).toBe(20); // InitializeMint2
    expect(initData[1]).toBe(2); // decimals: USD cents
    expect(Array.from(initData.slice(2, 34))).toEqual(
      Array.from(getAddressEncoder().encode(authority.address)),
    );
    expect(initData[34]).toBe(0); // no freeze authority
  });

  it("opens the USD pool as the admin, on the test mint, at the addresses the program derives", async () => {
    const keys = await signers();
    const mint = (await generateKeyPairSigner()).address;
    const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes(SIMULATION_INSTANCE) });
    const { pool, poolAuthority, vault } = await derivePoolAddresses(protocol, mint);
    expect(pool).toBe((await findPoolPda({ protocol }))[0]);
    expect(vault).toBe(await findAssociatedTokenAddress(poolAuthority, mint));

    const instruction = await buildOpenPool(keys, mint);
    expect(
      getOpenPoolInstructionDataDecoder().decode(instruction.data as Uint8Array).currency,
    ).toEqual(new TextEncoder().encode("USD"));
    const [admin, payer, protocolMeta, poolMeta, authorityMeta, mintMeta, vaultMeta] =
      instruction.accounts ?? [];
    expect(admin).toMatchObject({ address: keys.admin.address, role: AccountRole.READONLY_SIGNER });
    expect(payer).toMatchObject({
      address: keys.deployer.address,
      role: AccountRole.WRITABLE_SIGNER,
    });
    expect(
      [protocolMeta, poolMeta, authorityMeta, mintMeta, vaultMeta].map((meta) => meta?.address),
    ).toEqual([protocol, pool, poolAuthority, mint, vault]);
    expect(await buildOpenPool(keys, mint, SIMULATION_INSTANCE)).toEqual(instruction);
  });
});

// A classic SPL Token mint account, 82 bytes: a COption authority, supply, decimals, an
// initialised flag, and a COption freeze authority.
function mintBytes(options: {
  authority?: Address | null;
  freeze?: Address | null;
  decimals?: number;
  supply?: bigint;
  initialised?: boolean;
}): Uint8Array {
  const bytes = new Uint8Array(MINT_ACCOUNT_SIZE);
  const view = new DataView(bytes.buffer);
  const address = getAddressEncoder();
  if (options.authority) {
    view.setUint32(0, 1, true);
    bytes.set(address.encode(options.authority), 4);
  }
  view.setBigUint64(36, options.supply ?? 0n, true);
  bytes[44] = options.decimals ?? 2;
  bytes[45] = options.initialised === false ? 0 : 1;
  if (options.freeze) {
    view.setUint32(46, 1, true);
    bytes.set(address.encode(options.freeze), 50);
  }
  return bytes;
}

describe("test mint rules", () => {
  it("accepts the wanted mint whatever its supply, and names every field that is wrong", async () => {
    const [authority, other] = await Promise.all([
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    const wanted = { mintAuthority: authority.address };
    const account = (data: Uint8Array, programAddress: string = TOKEN_PROGRAM_ADDRESS) => ({
      programAddress,
      data,
    });

    expect(diffMint(account(mintBytes({ authority: authority.address })), wanted)).toEqual([]);
    expect(
      diffMint(account(mintBytes({ authority: authority.address, supply: 5_000_000n })), wanted),
    ).toEqual([]);

    expect(
      diffMint(account(mintBytes({ authority: authority.address, decimals: 6 })), wanted),
    ).toEqual(["decimals: found 6, wanted 2"]);
    expect(
      diffMint(account(mintBytes({ authority: authority.address, freeze: other.address })), wanted),
    ).toEqual([`freezeAuthority: found ${other.address}, wanted none`]);
    expect(diffMint(account(mintBytes({ authority: other.address })), wanted)).toEqual([
      `mintAuthority: found ${other.address}, wanted ${authority.address}`,
    ]);
    expect(diffMint(account(mintBytes({ authority: null })), wanted)).toEqual([
      `mintAuthority: found none, wanted ${authority.address}`,
    ]);
    expect(
      diffMint(account(mintBytes({ authority: authority.address, initialised: false })), wanted),
    ).toEqual(["mint is not initialised"]);
    // Every difference is reported together.
    expect(
      diffMint(
        account(mintBytes({ authority: other.address, freeze: other.address, decimals: 9 })),
        wanted,
      ),
    ).toHaveLength(3);
  });

  it("refuses a Token-2022 mint, a wrong size and a malformed option", async () => {
    const authority = (await generateKeyPairSigner()).address;
    const good = mintBytes({ authority });
    expect(
      diffMint({ programAddress: TOKEN_2022_PROGRAM, data: good }, { mintAuthority: authority }),
    ).toEqual([`owner: found ${TOKEN_2022_PROGRAM}, wanted ${TOKEN_PROGRAM_ADDRESS}`]);
    expect(
      diffMint(
        { programAddress: TOKEN_PROGRAM_ADDRESS, data: good.slice(0, 81) },
        { mintAuthority: authority },
      ),
    ).toEqual(["data length: found 81, wanted 82"]);
    const malformed = mintBytes({ authority });
    new DataView(malformed.buffer).setUint32(46, 2, true);
    expect(
      diffMint(
        { programAddress: TOKEN_PROGRAM_ADDRESS, data: malformed },
        { mintAuthority: authority },
      ),
    ).toEqual(["freezeAuthority: found malformed, wanted none"]);
  });
});

type FakeAccount = { owner: string; data: Uint8Array };

// A fake RPC holding accounts by address; it records every address that is read.
function fakeAccountRpc(accounts: Record<string, FakeAccount>) {
  const reads: string[] = [];
  const rpc = {
    getAccountInfo: (address: string, config: { encoding: string }) => {
      expect(config.encoding).toBe("base64");
      reads.push(address);
      const account = accounts[address];
      return {
        send: async () => ({
          context: { slot: 1n },
          value:
            account === undefined
              ? null
              : {
                  data: [Buffer.from(account.data).toString("base64"), "base64"],
                  executable: false,
                  lamports: 1_000_000n,
                  owner: account.owner,
                  space: BigInt(account.data.length),
                },
        }),
      };
    },
  };
  return { reads, rpc: rpc as unknown as AccountReader };
}

describe("simulation step decisions against a fake RPC", () => {
  async function setup() {
    const [authority, mint] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
    const [protocol] = await findProtocolPda({ instanceId: instanceIdBytes(SIMULATION_INSTANCE) });
    const addresses = await derivePoolAddresses(protocol, mint.address);
    return { authority, mint, protocol, ...addresses };
  }

  const poolAccount = (fields: {
    protocol: Address;
    mint: Address;
    vault: Address;
    currency?: string;
    decimals?: number;
    cash?: bigint;
  }): FakeAccount => ({
    owner: THETIS_PROGRAM_ADDRESS,
    data: Uint8Array.from(
      getSimulationPoolEncoder().encode({
        protocol: fields.protocol,
        mint: fields.mint,
        vault: fields.vault,
        currency: new TextEncoder().encode(fields.currency ?? "USD"),
        currencyDecimals: fields.decimals ?? 2,
        cashMinor: fields.cash ?? 0n,
        totalShares: fields.cash ?? 0n,
        lentMinor: 0n,
        incomeMinor: 0n,
        revision: 0n,
        bump: 255,
      }),
    ),
  });

  it("creates the mint when it is missing, skips it when it holds the wanted values, stops otherwise", async () => {
    const { authority, mint } = await setup();
    const wantedMint = {
      owner: TOKEN_PROGRAM_ADDRESS,
      data: mintBytes({ authority: authority.address }),
    };

    const missing = fakeAccountRpc({});
    expect(await decideTestMint(missing.rpc, mint.address, authority.address)).toBe("create");
    expect(missing.reads).toEqual([mint.address]);

    const present = fakeAccountRpc({ [mint.address]: wantedMint });
    expect(await decideTestMint(present.rpc, mint.address, authority.address)).toBe("skip");

    // Supply moves after test tokens are minted; that is not a difference.
    const minted = fakeAccountRpc({
      [mint.address]: {
        ...wantedMint,
        data: mintBytes({ authority: authority.address, supply: 90_000_000n }),
      },
    });
    expect(await decideTestMint(minted.rpc, mint.address, authority.address)).toBe("skip");

    const wrongDecimals = fakeAccountRpc({
      [mint.address]: {
        ...wantedMint,
        data: mintBytes({ authority: authority.address, decimals: 6 }),
      },
    });
    await expect(
      decideTestMint(wrongDecimals.rpc, mint.address, authority.address),
    ).rejects.toThrow(
      /already exists with different values; nothing sent for it:\n {2}decimals: found 6, wanted 2/,
    );
    const frozen = fakeAccountRpc({
      [mint.address]: {
        ...wantedMint,
        data: mintBytes({ authority: authority.address, freeze: authority.address }),
      },
    });
    await expect(decideTestMint(frozen.rpc, mint.address, authority.address)).rejects.toThrow(
      /freezeAuthority/,
    );
    const otherAuthority = (await generateKeyPairSigner()).address;
    const stranger = fakeAccountRpc({ [mint.address]: wantedMint });
    await expect(decideTestMint(stranger.rpc, mint.address, otherAuthority)).rejects.toThrow(
      new RegExp(`mintAuthority: found ${authority.address}, wanted ${otherAuthority}`),
    );
    const token2022 = fakeAccountRpc({
      [mint.address]: { ...wantedMint, owner: TOKEN_2022_PROGRAM },
    });
    await expect(decideTestMint(token2022.rpc, mint.address, authority.address)).rejects.toThrow(
      SeedError,
    );
  });

  it("opens the pool when it is missing, skips it when it holds the wanted values, stops otherwise", async () => {
    const { mint, protocol, pool, vault } = await setup();
    const wanted = {
      pool,
      protocol,
      mint: mint.address,
      vault,
      currency: new TextEncoder().encode(SIMULATION.currency),
      currencyDecimals: SIMULATION.mintDecimals,
    };
    const fields = { protocol, mint: mint.address, vault };

    const missing = fakeAccountRpc({});
    expect(await decideOpenPool(missing.rpc, wanted)).toBe("open");
    expect(missing.reads).toEqual([pool]);

    expect(await decideOpenPool(fakeAccountRpc({ [pool]: poolAccount(fields) }).rpc, wanted)).toBe(
      "skip",
    );
    // Deposits move the counters; that is not a difference.
    expect(
      await decideOpenPool(
        fakeAccountRpc({ [pool]: poolAccount({ ...fields, cash: 40_000_000n }) }).rpc,
        wanted,
      ),
    ).toBe("skip");

    const otherMint = (await generateKeyPairSigner()).address;
    await expect(
      decideOpenPool(
        fakeAccountRpc({ [pool]: poolAccount({ ...fields, mint: otherMint }) }).rpc,
        wanted,
      ),
    ).rejects.toThrow(new RegExp(`mint: found ${otherMint}, wanted ${mint.address}`));
    await expect(
      decideOpenPool(
        fakeAccountRpc({ [pool]: poolAccount({ ...fields, currency: "EUR" }) }).rpc,
        wanted,
      ),
    ).rejects.toThrow(/currency: found EUR, wanted USD/);
    await expect(
      decideOpenPool(
        fakeAccountRpc({ [pool]: poolAccount({ ...fields, decimals: 6 }) }).rpc,
        wanted,
      ),
    ).rejects.toThrow(/currencyDecimals: found 6, wanted 2/);
  });

  it("reads the pool before the mint, and stops on a pool left on another mint before any mint is made", async () => {
    const { authority, mint, protocol, pool, vault } = await setup();
    const wantedPool = {
      pool,
      protocol,
      mint: mint.address,
      vault,
      currency: new TextEncoder().encode(SIMULATION.currency),
      currencyDecimals: SIMULATION.mintDecimals,
    };
    const wanted = { mintAuthority: authority.address, pool: wantedPool };
    const wantedMint = {
      owner: TOKEN_PROGRAM_ADDRESS,
      data: mintBytes({ authority: authority.address }),
    };
    const fields = { protocol, mint: mint.address, vault };

    // Nothing exists yet: both steps are needed, and the pool is read first.
    const empty = fakeAccountRpc({});
    expect(await decideSimulationSteps(empty.rpc, wanted)).toEqual({
      pool: "open",
      mint: "create",
    });
    expect(empty.reads).toEqual([pool, mint.address]);

    // Both exist with the wanted values: nothing to send.
    const done = fakeAccountRpc({
      [pool]: poolAccount(fields),
      [mint.address]: wantedMint,
    });
    expect(await decideSimulationSteps(done.rpc, wanted)).toEqual({ pool: "skip", mint: "skip" });

    // sim-mint.json was lost: a new mint address, the old pool. The run stops on the pool and never
    // reads (so never creates) the new mint.
    const oldMint = (await generateKeyPairSigner()).address;
    const lost = fakeAccountRpc({ [pool]: poolAccount({ ...fields, mint: oldMint }) });
    await expect(decideSimulationSteps(lost.rpc, wanted)).rejects.toThrow(
      new RegExp(`mint: found ${oldMint}, wanted ${mint.address}`),
    );
    expect(lost.reads).toEqual([pool]);
  });

  it("compares only the pool's fixed fields", () => {
    const base = {
      protocol: "P",
      mint: "M",
      vault: "V",
      currency: new TextEncoder().encode("USD"),
      currencyDecimals: 2,
    };
    expect(diffPool(base, { ...base })).toEqual([]);
    expect(diffPool({ ...base, protocol: "Q", vault: "W" }, base)).toEqual([
      "protocol: found Q, wanted P",
      "vault: found W, wanted V",
    ]);
  });

  it("stops when the protocol under the simulation id holds the fiat settlement mode", () => {
    const found = {
      instanceId: instanceIdBytes(SIMULATION_INSTANCE),
      settlementMode: "FiatAttestationTest",
      admin: "A",
      accreditor: "B",
    };
    expect(diffProtocol(found, { ...found, settlementMode: "DevnetTokenSimulation" })).toEqual([
      "settlementMode: found FiatAttestationTest, wanted DevnetTokenSimulation",
    ]);
    expect(diffProtocol(found, { ...found, instanceId: instanceIdBytes() })).toEqual([
      "instanceId differs",
    ]);
  });
});

describe("seed-log.json keeps the instances apart", () => {
  const tx = (
    step: string,
    signature: string,
    status: LoggedTransaction["status"] = "confirmed",
  ) => ({
    step,
    signature,
    url: explorerUrl(signature),
    status,
    lastValidBlockHeight: "100",
  });
  const fiatLog = () => ({
    cluster: "devnet" as const,
    program: THETIS_PROGRAM_ADDRESS,
    protocol: "FiatProtocol",
    transactions: [tx("initialize_protocol", "sigFiat")],
  });
  const simLog = (): InstanceLog => ({
    protocol: "SimProtocol",
    mint: "SimMint",
    pool: "SimPool",
    vault: "SimVault",
    transactions: [tx("create_test_mint", "sigMint", "pending"), tx("open_pool USD", "sigPool")],
  });

  it("renders a default-instance log exactly as before: no instances key", () => {
    expect(renderSeedLog(fiatLog())).toBe(`${JSON.stringify(fiatLog(), null, 2)}\n`);
    expect(Object.keys(JSON.parse(renderSeedLog(fiatLog())))).toEqual([
      "cluster",
      "program",
      "protocol",
      "transactions",
    ]);
    expect(renderSeedLog({ ...fiatLog(), instances: {} })).toBe(renderSeedLog(fiatLog()));
  });

  it("writes the simulation's addresses and transactions under its instance id, after the fiat ones", () => {
    const text = renderSeedLog({ ...fiatLog(), instances: { "token-simulation": simLog() } });
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed)).toEqual([
      "cluster",
      "program",
      "protocol",
      "transactions",
      "instances",
    ]);
    expect(parsed.transactions).toEqual(fiatLog().transactions);
    expect(parsed.instances["token-simulation"]).toEqual(simLog());
    expect(Object.keys(parsed.instances["token-simulation"])).toEqual([
      "protocol",
      "mint",
      "pool",
      "vault",
      "transactions",
    ]);
  });

  it("reads back what it wrote, and a simulation-only log has no fiat part", () => {
    const dir = tempDir();
    const path = join(dir, "seed-log.json");
    expect(readSeedLog(path)).toBeUndefined();

    writeFileSync(
      path,
      renderSeedLog({
        cluster: "devnet",
        program: "P",
        instances: { "token-simulation": simLog() },
      }),
    );
    const simOnly = readSeedLog(path);
    expect(simOnly?.transactions).toBeUndefined();
    expect(simOnly?.protocol).toBeUndefined();
    expect(simOnly?.instances?.["token-simulation"]).toEqual(simLog());

    writeFileSync(
      path,
      renderSeedLog({ ...fiatLog(), instances: { "token-simulation": simLog() } }),
    );
    const both = readSeedLog(path);
    expect(both?.transactions).toEqual(fiatLog().transactions);
    expect(
      both?.instances?.["token-simulation"]?.transactions.map((entry) => entry.status),
    ).toEqual(["pending", "confirmed"]);
  });

  it("reads an older fiat-only log unchanged", () => {
    const path = join(tempDir(), "seed-log.json");
    writeFileSync(path, `${JSON.stringify(fiatLog(), null, 2)}\n`);
    const log = readSeedLog(path);
    expect(log?.transactions).toEqual(fiatLog().transactions);
    expect(log?.instances).toBeUndefined();
    expect(renderSeedLog(log as NonNullable<typeof log>)).toBe(readFileSync(path, "utf8"));
  });

  it("refuses a log it did not write", () => {
    const path = join(tempDir(), "seed-log.json");
    const attempts = [
      { ...fiatLog(), transactions: [{ step: 1 }] },
      { ...fiatLog(), instances: [] },
      { ...fiatLog(), instances: { "token-simulation": { protocol: "P" } } },
      { ...fiatLog(), instances: { "token-simulation": { ...simLog(), mint: 7 } } },
      {
        ...fiatLog(),
        instances: { "token-simulation": { ...simLog(), transactions: [{ step: "x" }] } },
      },
    ];
    for (const content of attempts) {
      writeFileSync(path, JSON.stringify(content));
      expect(() => readSeedLog(path)).toThrow(/not a seed log this script wrote/);
    }
  });

  it("takes each instance's own transactions from its own part of the log", () => {
    const log = { ...fiatLog(), instances: { "token-simulation": simLog() } };
    expect(ownTransactions(log, DEFAULT_INSTANCE)).toEqual(fiatLog().transactions);
    expect(ownTransactions(log, SIMULATION_INSTANCE)).toEqual(simLog().transactions);
    expect(ownTransactions(undefined, DEFAULT_INSTANCE)).toEqual([]);
    expect(ownTransactions(fiatLog(), SIMULATION_INSTANCE)).toEqual([]);
  });

  it("writes one instance's part and keeps the other's exactly as the file now has it", () => {
    // The simulation run writes while the fiat part on disk has moved on (a new pending entry).
    const fiatNow = {
      ...fiatLog(),
      transactions: [
        ...fiatLog().transactions,
        tx("register_class CHROME v1", "sigClass", "pending"),
      ],
    };
    const simWrite = mergeSeedLog(fiatNow, THETIS_PROGRAM_ADDRESS, SIMULATION_INSTANCE, simLog());
    expect(simWrite.protocol).toBe("FiatProtocol");
    expect(simWrite.transactions).toEqual(fiatNow.transactions);
    expect(simWrite.instances?.["token-simulation"]).toEqual(simLog());

    // The fiat run writes while the simulation part is on disk: it keeps that part untouched.
    const withSim = { ...fiatLog(), instances: { "token-simulation": simLog() } };
    const ownFiat = {
      protocol: "FiatProtocol",
      transactions: [tx("initialize_protocol", "sigFiat2")],
    };
    const fiatWrite = mergeSeedLog(withSim, THETIS_PROGRAM_ADDRESS, DEFAULT_INSTANCE, ownFiat);
    expect(fiatWrite.transactions).toEqual(ownFiat.transactions);
    expect(fiatWrite.instances?.["token-simulation"]).toEqual(simLog());

    // First write of either instance into an empty file.
    expect(mergeSeedLog(undefined, THETIS_PROGRAM_ADDRESS, SIMULATION_INSTANCE, simLog())).toEqual({
      cluster: "devnet",
      program: THETIS_PROGRAM_ADDRESS,
      protocol: undefined,
      transactions: undefined,
      instances: { "token-simulation": simLog() },
    });
    expect(
      Object.keys(
        JSON.parse(
          renderSeedLog(mergeSeedLog(undefined, THETIS_PROGRAM_ADDRESS, DEFAULT_INSTANCE, ownFiat)),
        ),
      ),
    ).toEqual(["cluster", "program", "protocol", "transactions"]);
  });

  it("keeps a step's pending entry apart: another instance's pending step does not block this one", () => {
    const sim = [tx("initialize_protocol", "sigSimInit", "pending")];
    expect(() => assertNoPending(sim, "initialize_protocol")).toThrow(/still pending/);
    expect(() => assertNoPending(fiatLog().transactions, "initialize_protocol")).not.toThrow();
  });
});

describe("simulation keys and run", () => {
  it("creates the mint and the mint authority as two distinct mode-600 files, once", async () => {
    const dir = tempDir();
    const mint = await loadOrCreateKey(dir, "sim-mint");
    const authority = await loadOrCreateKey(dir, "sim-mint-authority");
    expect(mint.address).not.toBe(authority.address);
    for (const name of ["sim-mint.json", "sim-mint-authority.json"]) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(dir, name), "utf8"))).toHaveLength(64);
    }
    expect((await loadOrCreateKey(dir, "sim-mint")).address).toBe(mint.address);
    expect((await loadOrCreateKey(dir, "sim-mint-authority")).address).toBe(authority.address);
  });

  it("stops for a missing deployer before creating any key, in either mode", async () => {
    for (const argv of [[], ["--instance", "token-simulation"]]) {
      const dir = tempDir();
      await expect(main(argv, { THETIS_KEYS_DIR: dir })).rejects.toThrow(
        /deployer\.json is missing/,
      );
      expect(existsSync(join(dir, "sim-mint.json"))).toBe(false);
      expect(existsSync(join(dir, "admin.json"))).toBe(false);
    }
  });

  it("refuses a non-devnet override or a keys directory in the repository before touching anything", async () => {
    await expect(
      main(["--instance", "token-simulation", "--url", "mainnet-beta"], {
        THETIS_KEYS_DIR: tempDir(),
      }),
    ).rejects.toThrow(/not devnet/);
    await expect(
      main(["--instance", "token-simulation"], { THETIS_KEYS_DIR: join(repoRoot, "keys") }),
    ).rejects.toThrow(/inside the repository/);
    expect(existsSync(join(repoRoot, "keys"))).toBe(false);
  });
});
