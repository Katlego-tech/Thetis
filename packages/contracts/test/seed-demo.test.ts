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
import { generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertDevnetOnly,
  assertKeysDirOutsideRepo,
  assertNoPending,
  buildAccreditOrganisation,
  buildInitializeProtocol,
  buildRegisterClass,
  diffClass,
  diffOrganisation,
  diffProtocol,
  enumName,
  explorerUrl,
  findClassPolicyPda,
  findOrganisationNamePda,
  instanceIdBytes,
  type LoggedTransaction,
  loadOrCreateKey,
  parseSeedOrganisations,
  reconcilePending,
  SEED,
  SeedError,
  submitLogged,
  uuidToBytes,
  wantedClass,
} from "../../../scripts/seed-demo.ts";
import {
  findOrganisationPda,
  findProtocolPda,
  getAccreditOrganisationInstructionDataDecoder,
  getInitializeProtocolInstructionDataDecoder,
  getRegisterClassInstructionDataDecoder,
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
