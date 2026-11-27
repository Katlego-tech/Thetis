// Tests for scripts/demo-reset.ts (demo.md §5). They live here for the same reason as
// seed-demo.test.ts: scripts/ is not a workspace package. Nothing here touches a network or a
// database: the chain and the local Supabase are in-memory fakes. Every key is a throwaway.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type Address,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { getMintSize, getTokenSize } from "@solana-program/token";
import {
  findProtocolPda,
  getAuthorityEncoder,
  getClassPolicyEncoder,
  getCustodianClassEncoder,
  getIntakeIdentitySize,
  getLotEncoder,
  getOrganisationEncoder,
  getOrganisationNameSize,
  getPositionSize,
  getProtocolEncoder,
  getProtocolSize,
  SettlementMode,
  THETIS_PROGRAM_ADDRESS,
} from "@thetis/contracts";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_BYTES,
  AUTHORITY_LIFETIME_SECS,
  bindIssueLotMessage,
  type Chain,
  CUSTODIAN_CLASSES,
  check,
  DELEGATIONS,
  DemoError,
  devnetChain,
  estimateCost,
  ISSUE_LOT_MESSAGE_PARAMS,
  ISSUER_KEY,
  instanceIdFor,
  loadIssueText,
  localStack,
  NEEDS_T067R,
  nextFreeRun,
  parseArgs,
  planSteps,
  ROLE_SCOPES,
  renderEnv,
  rentEstimate,
  reset,
  resetCast,
  SCOPE,
  STATE_MAX,
} from "../../../scripts/demo-reset.ts";
import {
  castFile,
  fakeStack,
  keysDir,
  organisations,
  repoRoot,
  seedSql,
} from "./demo-reset.fakes.ts";
import {
  DO_BLOCK,
  INSERT_NO_RETURNING,
  INSERT_RETURNING_NO_ROWS,
  SELECT_NO_ROWS,
  SELECT_ONE_ROW,
} from "./fixtures/supabase-db-query-2.122.1.ts";

// ------------------------------------------------------------------------- fakes

type FakeAccount = { data: Uint8Array; owner: Address };

function memoryChain(options: { balance?: bigint; now?: bigint } = {}) {
  const accounts = new Map<string, FakeAccount>();
  const submitted: unknown[] = [];
  let slot = 1_000n;
  const chain: Chain & { accounts: Map<string, FakeAccount>; submitted: unknown[] } = {
    accounts,
    submitted,
    rpc: {
      getAccountInfo(address: Address) {
        return {
          send: async () => {
            const found = accounts.get(address);
            return {
              context: { slot },
              value: found
                ? {
                    data: [Buffer.from(found.data).toString("base64"), "base64"],
                    executable: false,
                    lamports: 1n,
                    owner: found.owner,
                    space: BigInt(found.data.length),
                    rentEpoch: 0n,
                  }
                : null,
            };
          },
        };
      },
    } as unknown as Chain["rpc"],
    programDeployed: async () => true,
    unixTime: async () => options.now ?? 1_800_000_000n,
    slot: async () => {
      slot += 1n;
      return slot;
    },
    balance: async () => options.balance ?? 100_000_000_000n,
    rent: async (bytes: number) => BigInt(bytes + 128) * 6_960n,
    latestBlockhash: async () => ({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 10_000n,
    }),
    submit: async (transaction: unknown) => {
      submitted.push(transaction);
    },
    statuses: async (signatures: readonly string[]) =>
      signatures.map(() => ({ failed: false, confirmed: true })),
    blockHeight: async () => 1n,
    lookupTable: async () => null,
  };
  return chain;
}

function deps(
  dir: string,
  chain = memoryChain(),
  stack = fakeStack(),
  sql = seedSql,
  issueText: () => Promise<((fields: unknown) => Uint8Array) | null> = async () => null,
) {
  const lines: string[] = [];
  return {
    chain,
    stack,
    lines,
    deps: {
      chain,
      stack,
      keysDir: dir,
      repoRoots: [repoRoot],
      seedSql: sql,
      log: (line: string) => lines.push(line),
      issueText,
      sleep: async () => {},
    },
  };
}

// ------------------------------------------------------------------------- tests

describe("demo reset (demo.md §5)", () => {
  it("instance ids are 16 ASCII bytes for 01 to 99 and next picks the smallest free NN", async () => {
    for (const n of [1, 9, 10, 99]) {
      for (const scenario of ["phone", "lender"] as const) {
        const id = instanceIdFor(scenario, n);
        expect(new TextEncoder().encode(id)).toHaveLength(16);
        expect(id).toMatch(/^[\x20-\x7e]{16}$/);
      }
    }
    expect(instanceIdFor("phone", 1)).toBe("fiat-demo-run-01");
    expect(instanceIdFor("lender", 42)).toBe("fiat-lend-run-42");
    expect(() => instanceIdFor("phone", 0)).toThrow(DemoError);
    expect(() => instanceIdFor("phone", 100)).toThrow(DemoError);

    const taken = new Set<string>();
    for (const n of [1, 2, 4]) {
      const [protocol] = await findProtocolPda({
        instanceId: new TextEncoder().encode(instanceIdFor("phone", n)),
      });
      taken.add(protocol);
    }
    expect(await nextFreeRun("phone", async (protocol) => taken.has(protocol))).toBe(3);
    expect(await nextFreeRun("lender", async (protocol) => taken.has(protocol))).toBe(1);
  });

  it("the plan for phone is B1 to B18 in order and for lender adds L1 to L4", () => {
    const phone = planSteps("phone").map((step) => step.name);
    expect(phone).toEqual([
      "initialize_protocol",
      "register_class CHROME v1",
      ...organisations.map((organisation) => `accredit_organisation ${organisation.slug}`),
      "accredit_custodian_class KOPANO-YARD-1",
      "accredit_custodian_class PORT-T1",
      ...DELEGATIONS.map((delegation) => `delegate_authority ${delegation.key}`),
    ]);
    expect(phone).toHaveLength(18);
    // A phone run never holds a pre-issued lot (owner, 27 Nov): no issuer and no issue step.
    expect(phone.some((name) => /issue_lot|seed-issuer|lookup_table/.test(name))).toBe(false);
    const lender = planSteps("lender").map((step) => step.name);
    expect(lender.slice(0, 18)).toEqual(phone);
    expect(lender.slice(18)).toEqual([
      "delegate_authority kopano-seed-issuer",
      "create_lookup_table",
      "extend_lookup_table",
      "issue_lot CR-0001",
    ]);
    expect(CUSTODIAN_CLASSES).toEqual([
      { slug: "kopano", site: "KOPANO-YARD-1", approvedKg: 10_000_000n },
      { slug: "port-t1", site: "PORT-T1", approvedKg: 5_000_000n },
    ]);
  });

  it("scopes per wallet equal the §5.1 table and stay inside setup.rs's role table", () => {
    expect(Object.fromEntries(DELEGATIONS.map((d) => [d.key, d.scopes]))).toEqual({
      kopano: 19465,
      "port-t1": 23552,
      mosela: 3072,
      khunou: 558,
      "lender-one": 128,
      "lender-two": 128,
      "buyer-smelter": 590,
    });
    expect(DELEGATIONS.some((d) => (d.key as string) === "mosela-refused")).toBe(false);
    for (const delegation of DELEGATIONS) {
      const organisation = organisations.find((o) => o.slug === delegation.slug);
      expect(organisation).toBeDefined();
      const allowed = ROLE_SCOPES[organisation?.role as keyof typeof ROLE_SCOPES];
      expect(delegation.scopes & ~allowed).toBe(0);
      expect(delegation.scopes).not.toBe(0);
    }
    expect(ROLE_SCOPES.Custodian).toBe(
      SCOPE.ISSUE | SCOPE.REDEEM | SCOPE.CARRY | SCOPE.OBSERVE | SCOPE.ATTEST_TRANSPORT,
    );
    expect(ROLE_SCOPES.Lender & SCOPE.POOL).toBe(SCOPE.POOL);
    expect(DELEGATIONS.filter((d) => d.scopes & SCOPE.POOL)).toEqual([]);
  });

  it("expires_at is t0 plus 2,592,000 and a rerun reuses t0", async () => {
    const dir = await keysDir();
    await castFile(dir);
    const first = deps(dir, memoryChain({ now: 1_800_000_000n }));
    const planned = await reset({ scenario: "phone", run: 1, yes: true }, first.deps);
    expect(AUTHORITY_LIFETIME_SECS).toBe(2_592_000n);
    expect(planned.t0).toBe(1_800_000_000n);
    expect(planned.expiresAt).toBe(1_800_000_000n + 2_592_000n);
    // Later, with the chain clock moved on: the run file's t0 is kept.
    const later = deps(dir, memoryChain({ now: 1_800_090_000n }));
    const again = await reset({ scenario: "phone", run: 1, yes: false }, later.deps);
    expect(again.t0).toBe(1_800_000_000n);
    expect(again.expiresAt).toBe(1_802_592_000n);
  });

  it("refuses each of refusals 1 to 8 before any send or wipe", async () => {
    // 1. Not devnet.
    expect(() =>
      parseArgs(["--scenario", "phone", "--run", "1", "--url", "mainnet-beta"], {}),
    ).toThrow(/not devnet/);
    expect(() =>
      parseArgs(["--scenario", "phone", "--run", "1"], {
        SOLANA_URL: "https://api.mainnet-beta.solana.com",
      }),
    ).toThrow(/not devnet/);
    expect(() => parseArgs(["--scenario", "both", "--run", "1"], {})).toThrow(DemoError);
    expect(parseArgs(["--scenario", "phone", "--run", "next"], {})).toEqual({
      mode: "reset",
      scenario: "phone",
      run: "next",
      yes: false,
    });
    expect(parseArgs(["--check", "--run", "fiat-demo-run-07"], {})).toEqual({
      mode: "check",
      instanceId: "fiat-demo-run-07",
    });

    const refuse = async (
      setup: (dir: string) => Promise<void>,
      pattern: RegExp,
      options: {
        chain?: ReturnType<typeof memoryChain>;
        stack?: ReturnType<typeof fakeStack>;
        sql?: string;
        yes?: boolean;
      } = {},
    ) => {
      const dir = await keysDir();
      await setup(dir);
      const run = deps(dir, options.chain, options.stack, options.sql);
      await expect(
        reset({ scenario: "phone", run: 1, yes: options.yes ?? true }, run.deps),
      ).rejects.toThrow(pattern);
      expect(run.chain.submitted).toEqual([]);
      expect(run.stack.resets()).toBe(0);
      return run;
    };

    // 2. Missing cast file (the template is printed), a missing operator key, a keys dir in the repo.
    const missing = await refuse(async () => {}, /demo-cast\.json/);
    expect(missing.lines.join("\n")).toContain('"mosela-refused": ""');
    await refuse(async (dir) => {
      await castFile(dir);
      rmSync(join(dir, "accreditor.json"));
    }, /accreditor\.json/);
    {
      const run = deps(join(repoRoot, "tmp-keys-in-repo"));
      await expect(reset({ scenario: "phone", run: 1, yes: true }, run.deps)).rejects.toThrow(
        /inside the repository/,
      );
    }
    // 3. A cast wallet equal to an operator key, a duplicate, a real-looking email, a wrong user set.
    await refuse(async (dir) => {
      const deployer = JSON.parse(readFileSync(join(dir, "deployer.json"), "utf8")) as number[];
      const signer = await createKeyPairSignerFromBytes(Uint8Array.from(deployer));
      await castFile(dir, (cast) => {
        cast.wallets.khunou = signer.address;
      });
    }, /operator key/);
    await refuse(async (dir) => {
      await castFile(dir, (cast) => {
        cast.wallets["mosela-refused"] = cast.wallets.mosela;
      });
    }, /more than once/);
    await refuse(async (dir) => {
      await castFile(dir, (cast) => {
        (cast.users[0] as { email: string }).email = "someone@example.com";
      });
    }, /\.test/);
    await refuse(async (dir) => {
      await castFile(dir, (cast) => {
        cast.users.pop();
      });
    }, /six users/);
    // 4. An organisation not marked synthetic.
    await refuse(
      async (dir) => {
        await castFile(dir);
      },
      /not marked synthetic/,
      {
        sql: seedSql.replace(
          "'Mosela Haulage', 'transporter', true",
          "'Mosela Haulage', 'transporter', false",
        ),
      },
    );
    // 5. A Supabase that is not local.
    await refuse(
      async (dir) => {
        await castFile(dir);
      },
      /not the local stack/,
      { stack: fakeStack({ apiUrl: "https://abcd.supabase.co" }) },
    );
    // 6. The API or the web app running.
    await refuse(
      async (dir) => {
        await castFile(dir);
      },
      /3200/,
      { stack: fakeStack({ listening: [3200] }) },
    );
    await refuse(
      async (dir) => {
        await castFile(dir);
      },
      /3100 \(the web app\)/,
      { stack: fakeStack({ listening: [3100] }) },
    );
    // 6. The worker polled less than 120 s ago; a checkpoint polled long ago does not refuse.
    await refuse(
      async (dir) => {
        await castFile(dir);
      },
      /worker polled in the last 120 s/,
      { stack: fakeStack({ checkpointAge: 45 }) },
    );
    {
      const dir = await keysDir();
      await castFile(dir);
      const old = deps(dir, memoryChain(), fakeStack({ checkpointAge: 600 }));
      await expect(
        reset({ scenario: "phone", run: 1, yes: true }, old.deps),
      ).resolves.toBeDefined();
    }
    // 7. A Used run, and an instance holding other values.
    {
      const chain = memoryChain();
      const [protocol] = await findProtocolPda({
        instanceId: new TextEncoder().encode("fiat-demo-run-01"),
      });
      const encoder = new TextEncoder();
      const [lot] = await getProgramDerivedAddress({
        programAddress: THETIS_PROGRAM_ADDRESS,
        seeds: [
          encoder.encode("lot"),
          getAddressEncoder().encode(protocol),
          encoder.encode("CR-0001"),
        ],
      });
      chain.accounts.set(lot, { data: new Uint8Array(300), owner: THETIS_PROGRAM_ADDRESS });
      await refuse(
        async (dir) => {
          await castFile(dir);
        },
        /Used/,
        { chain, yes: false },
      );
    }
    {
      const chain = memoryChain();
      const [protocol] = await findProtocolPda({
        instanceId: new TextEncoder().encode("fiat-demo-run-01"),
      });
      const stranger = (await generateKeyPairSigner()).address;
      chain.accounts.set(protocol, {
        data: Uint8Array.from(
          getProtocolEncoder().encode({
            instanceId: new TextEncoder().encode("fiat-demo-run-01"),
            settlementMode: SettlementMode.FiatAttestationTest,
            admin: stranger,
            accreditor: stranger,
            pauseFlags: 0,
            bump: 255,
          }),
        ),
        owner: THETIS_PROGRAM_ADDRESS,
      });
      await refuse(
        async (dir) => {
          await castFile(dir);
        },
        /different values/,
        { chain, yes: false },
      );
    }
    // 8. A deployer balance below the plan's cost plus 0.1 SOL.
    await refuse(
      async (dir) => {
        await castFile(dir);
      },
      /balance/,
      { chain: memoryChain({ balance: 50_000_000n }) },
    );
  });

  it("the dry run sends nothing and wipes nothing", async () => {
    const dir = await keysDir();
    await castFile(dir);
    const run = deps(dir);
    const result = await reset({ scenario: "phone", run: "next", yes: false }, run.deps);
    expect(result.instanceId).toBe("fiat-demo-run-01");
    expect(result.steps.map((step) => step.action)).toEqual(Array(18).fill("send"));
    expect(result.sent).toEqual([]);
    expect(run.chain.submitted).toEqual([]);
    expect(run.stack.resets()).toBe(0);
    expect(run.stack.users.size).toBe(0);
    const printed = run.lines.join("\n");
    expect(printed).toMatch(/dry run/i);
    expect(printed).toContain("wipes the local Supabase database");
    expect(printed).toMatch(/SOL/);
  });

  it("the Supabase stage wipes when the marker is absent or another run's and only ensures rows when it is this run's", async () => {
    const dir = await keysDir();
    const cast = await castFile(dir);
    const stack = fakeStack();
    const first = await resetCast(stack, "fiat-demo-run-01", cast, organisations);
    expect(stack.resets()).toBe(1);
    expect(stack.marker()).toBe("fiat-demo-run-01");
    expect(first).toHaveLength(6);
    // Seven memberships: phone 1's person is in two organisations.
    expect(stack.memberships.size).toBe(7);
    const kopano = organisations.find((o) => o.slug === "kopano")?.id;
    const phone1 = stack.users.get("phone1@thetis-demo.test");
    expect(stack.memberships.has(`${kopano} ${phone1}`)).toBe(true);

    await resetCast(stack, "fiat-demo-run-01", cast, organisations);
    expect(stack.resets()).toBe(1);
    expect(stack.users.size).toBe(6);

    await resetCast(stack, "fiat-demo-run-02", cast, organisations);
    expect(stack.resets()).toBe(2);
    expect(stack.marker()).toBe("fiat-demo-run-02");
  });

  it("the env file holds the run's protocol and no secret", () => {
    const text = renderEnv({ protocol: "G9GNDdbYKQY14xv1xgNw1D6EY8SFnZxgHrDBdEbHsoo3" });
    expect(text).toContain("THETIS_PROTOCOL=G9GNDdbYKQY14xv1xgNw1D6EY8SFnZxgHrDBdEbHsoo3\n");
    expect(text).toContain("THETIS_NETWORK=devnet\n");
    expect(text).toContain("THETIS_PROGRAM_ID=jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3\n");
    expect(text).toContain(
      "THETIS_FIRST_SIGNATURE=vtK8h43bEg8zDn5w7u319t6VfNztCKB87nYBJ7LN6bsgFmMR2cFKA2iVLKgve8spmhri9mQJbSk28amZthbVviE\n",
    );
    expect(text).toContain("THETIS_DATA_SOURCE=live\n");
    expect(text).not.toMatch(/KEY|SECRET|PASSWORD|SUPABASE/);
  });

  it("the cost estimate equals the rent formula over the planned accounts", () => {
    for (const scenario of ["phone", "lender"] as const) {
      const steps = planSteps(scenario);
      const cost = estimateCost(steps, rentEstimate);
      const rent = steps
        .flatMap((step) => step.creates)
        .reduce((sum, account) => sum + BigInt(account.bytes + 128) * 6_960n, 0n);
      const fees = steps.reduce((sum, step) => sum + BigInt(step.signatures) * 5_000n, 0n);
      expect(cost).toEqual({ rent, fees, total: rent + fees });
    }
    const phone = estimateCost(planSteps("phone"), rentEstimate);
    // demo.md §5.5: about 0.053 SOL.
    expect(Number(phone.total) / 1e9).toBeCloseTo(0.0524, 3);
  });

  it("the real issueLotMessage from services/api binds, so a lender run can build CR-0001's text", async () => {
    expect(await loadIssueText()).toBeTypeOf("function");
  });
  it("a lender run refuses before sending anything with needs T067r when no issueLotMessage is available", async () => {
    const dir = await keysDir();
    await castFile(dir);
    const run = deps(dir);
    await expect(reset({ scenario: "lender", run: 1, yes: true }, run.deps)).rejects.toThrow(
      NEEDS_T067R,
    );
    expect(run.chain.submitted).toEqual([]);
    expect(run.stack.resets()).toBe(0);
  });
  it("demo:check passes only with the indexed cast, no Authority for mosela-refused and every wallet linked", async () => {
    const dir = await keysDir();
    const cast = await castFile(dir);
    const first = deps(dir);
    const result = await reset({ scenario: "phone", run: 1, yes: true }, first.deps);
    const run = result.runFile;
    if (run === null) throw new Error("no run file");
    const rows = (refusedAuthority: boolean, unlinked: string | null) => {
      const stack = fakeStack();
      const slugOf = (key: string) => (key === "mosela-refused" ? "mosela" : key);
      stack.query = async (sql: string) => {
        if (/indexer_checkpoints/.test(sql)) return [{ protocol: run.protocol, status: "live" }];
        if (/chain_organisations/.test(sql))
          return organisations.map((o) => ({ org_id: o.id, synthetic: true }));
        if (/chain_custodian_classes/.test(sql)) {
          return CUSTODIAN_CLASSES.map((c) => ({
            site_code: c.site,
            approved_capacity_kg: c.approvedKg.toString(),
          }));
        }
        if (/chain_authorities/.test(sql)) {
          const found: Record<string, unknown>[] = DELEGATIONS.map((d) => ({
            wallet: cast.wallets[d.key],
            scopes: d.scopes,
            expires_at: String(run.expiresAt),
            revoked_at: null,
          }));
          if (refusedAuthority) {
            found.push({
              wallet: cast.wallets["mosela-refused"],
              scopes: 3072,
              expires_at: "1",
              revoked_at: null,
            });
          }
          return found;
        }
        if (/signer_links/.test(sql)) {
          return Object.entries(cast.wallets)
            .filter(([key]) => key !== unlinked)
            .map(([key, wallet]) => ({ wallet, slug: slugOf(key) }));
        }
        return [];
      };
      return stack;
    };
    const quiet = { keysDir: dir, repoRoots: [repoRoot], log: () => {} };
    expect((await check("fiat-demo-run-01", { ...quiet, stack: rows(false, null) })).ok).toBe(true);
    const refused = await check("fiat-demo-run-01", { ...quiet, stack: rows(true, null) });
    expect(refused.ok).toBe(false);
    expect(refused.items.filter((i) => !i.ok).map((i) => i.item)).toEqual([
      "exactly 7 Authorities on fiat-demo-run-01",
      "mosela-refused holds no Authority",
    ]);
    const unlinked = await check("fiat-demo-run-01", {
      ...quiet,
      stack: rows(false, "lender-two"),
    });
    expect(unlinked.items.filter((i) => !i.ok).map((i) => i.item)).toEqual([
      "lender-two wallet linked to lender-two",
    ]);
  });

  // --------------------------------------------------------------- PR #68 review folds (27 Nov)

  it("localStack.query reads the CLI's JSON rows and treats a bare command tag as zero rows (CLI 2.122.1)", async () => {
    const query = (stdout: string, sql = "select 1") =>
      localStack(repoRoot, () => stdout).query(sql);
    expect(await query(SELECT_NO_ROWS)).toEqual([]);
    expect(await query(SELECT_ONE_ROW)).toEqual([{ n: null, one: 1 }]);
    expect(
      await query(INSERT_RETURNING_NO_ROWS, "insert into x select 1 where false returning a"),
    ).toEqual([]);
    expect(await query(INSERT_NO_RETURNING, "insert into x select 1 where false")).toEqual([]);
    expect(await query(DO_BLOCK, "do $$ begin perform 1; end $$")).toEqual([]);
    await expect(
      query("Error: connection refused\n", "select value\nfrom private.settings"),
    ).rejects.toThrow(/select value/);
    await expect(query('{"boundary": "x"}\n', "select 2")).rejects.toThrow(DemoError);
  });

  it("localStack.query also reads a bare JSON array of rows, as a newer Supabase CLI prints it", async () => {
    const query = (stdout: string, sql = "select 1") =>
      localStack(repoRoot, () => stdout).query(sql);
    expect(
      await query("[]\n", "select value from private.settings where key = 'demo_run'"),
    ).toEqual([]);
    expect(await query('[{"value": "fiat-demo-run-01"}]\n')).toEqual([
      { value: "fiat-demo-run-01" },
    ]);
    await expect(query("[1, 2]\n", "select 3")).rejects.toThrow(DemoError);
    await expect(query("[null]\n", "select 4")).rejects.toThrow(DemoError);
  });

  it("a cast run against the honest fake completes, every write returns rows, and the marker is set", async () => {
    const dir = await keysDir();
    const cast = await castFile(dir);
    const stack = fakeStack();
    const users = await resetCast(stack, "fiat-demo-run-03", cast, organisations);
    expect(users).toHaveLength(6);
    expect(stack.marker()).toBe("fiat-demo-run-03");
    expect(stack.memberships.size).toBe(7);
    const writes = stack.calls.filter((sql) => /^\s*insert\b/i.test(sql));
    expect(writes.length).toBe(7);
    for (const sql of writes) expect(sql).toMatch(/\breturning\b/i);
  });

  it("every devnet read asks for confirmed commitment", async () => {
    const requests: { method: string; args: unknown[] }[] = [];
    const answers: Record<string, unknown> = {
      getAccountInfo: { value: null },
      getSlot: 5n,
      getBlockTime: 1_800_000_000n,
      getBalance: { value: 1n },
      getMinimumBalanceForRentExemption: 1n,
      getLatestBlockhash: {
        value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 9n },
      },
      getSignatureStatuses: { value: [null] },
      getBlockHeight: 7n,
    };
    const rpc = new Proxy(
      {},
      {
        get:
          (_target, method: string) =>
          (...args: unknown[]) => {
            requests.push({ method, args });
            return { send: async () => answers[method] };
          },
      },
    );
    const chain = devnetChain(rpc as never, () => {
      throw new Error("no subscriptions in this test");
    });
    const table = (await generateKeyPairSigner()).address;
    await chain.programDeployed();
    await chain.unixTime();
    await chain.slot();
    await chain.balance(table);
    await chain.rent(100);
    await chain.latestBlockhash();
    await chain.statuses(["1111111111111111111111111111111111111111111111111111111111111111"]);
    await chain.blockHeight();
    await chain.lookupTable(table);
    // getBlockTime takes a slot only; getSignatureStatuses reports each status's own level.
    const takesCommitment = requests.filter(
      (r) => r.method !== "getBlockTime" && r.method !== "getSignatureStatuses",
    );
    expect(new Set(takesCommitment.map((r) => r.method))).toEqual(
      new Set([
        "getAccountInfo",
        "getSlot",
        "getBalance",
        "getMinimumBalanceForRentExemption",
        "getLatestBlockhash",
        "getBlockHeight",
      ]),
    );
    for (const request of takesCommitment) {
      expect({ method: request.method, config: request.args.at(-1) }).toMatchObject({
        config: { commitment: "confirmed" },
      });
    }
    expect(requests.filter((r) => r.method === "getAccountInfo")).toHaveLength(2);
  });

  it("the issue-text binding fails loudly when issueLotMessage's arity or argument names differ", () => {
    // T067r will export the real builder; this pins the order the script passes its arguments in.
    expect(ISSUE_LOT_MESSAGE_PARAMS).toEqual([
      "programId",
      "instanceId",
      "lotId",
      "classCode",
      "classVersion",
      "grade",
      "quantityKg",
      "owner",
      "custodian",
      "siteCode",
      "intake",
      "origin",
      "validUntil",
    ]);
    const params = ISSUE_LOT_MESSAGE_PARAMS.join(", ");
    const good = new Function(params, "return new Uint8Array([arguments.length]);");
    const bound = bindIssueLotMessage(good);
    expect(typeof bound).toBe("function");
    const fewer = new Function(
      ISSUE_LOT_MESSAGE_PARAMS.slice(0, 12).join(", "),
      "return new Uint8Array();",
    );
    expect(() => bindIssueLotMessage(fewer)).toThrow(/issueLotMessage/);
    const swapped: string[] = [...ISSUE_LOT_MESSAGE_PARAMS];
    [swapped[7], swapped[8]] = [swapped[8] as string, swapped[7] as string];
    expect(() =>
      bindIssueLotMessage(new Function(swapped.join(", "), "return new Uint8Array();")),
    ).toThrow(/custodian/);
  });

  it("demo:check asserts the exact Authority count and refuses a missing cast file with the template", async () => {
    const dir = await keysDir();
    const cast = await castFile(dir);
    const first = deps(dir);
    const result = await reset({ scenario: "phone", run: 1, yes: true }, first.deps);
    const run = result.runFile;
    if (run === null) throw new Error("no run file");
    const stack = (extra: number) => {
      const s = fakeStack();
      s.query = async (sql: string) => {
        if (/indexer_checkpoints/.test(sql)) return [{ protocol: run.protocol, status: "live" }];
        if (/chain_organisations/.test(sql))
          return organisations.map((o) => ({ org_id: o.id, synthetic: true }));
        if (/chain_custodian_classes/.test(sql)) {
          return CUSTODIAN_CLASSES.map((c) => ({
            site_code: c.site,
            approved_capacity_kg: c.approvedKg.toString(),
          }));
        }
        if (/chain_authorities/.test(sql)) {
          const rows: Record<string, unknown>[] = DELEGATIONS.map((d) => ({
            wallet: cast.wallets[d.key],
            scopes: d.scopes,
            expires_at: String(run.expiresAt),
            revoked_at: null,
          }));
          for (let i = 0; i < extra; i += 1) {
            rows.push({
              wallet: `Extra${i}`,
              scopes: 1,
              expires_at: String(run.expiresAt),
              revoked_at: null,
            });
          }
          return rows;
        }
        if (/signer_links/.test(sql)) {
          return Object.entries(cast.wallets).map(([key, wallet]) => ({
            wallet,
            slug: key === "mosela-refused" ? "mosela" : key,
          }));
        }
        return [];
      };
      return s;
    };
    const quiet = { keysDir: dir, repoRoots: [repoRoot], log: () => {} };
    const exact = await check("fiat-demo-run-01", { ...quiet, stack: stack(0) });
    expect(exact.ok).toBe(true);
    expect(exact.items.map((i) => i.item)).toContain("exactly 7 Authorities on fiat-demo-run-01");
    const more = await check("fiat-demo-run-01", { ...quiet, stack: stack(1) });
    expect(more.items.filter((i) => !i.ok).map((i) => i.item)).toEqual([
      "exactly 7 Authorities on fiat-demo-run-01",
    ]);

    rmSync(join(dir, "demo-cast.json"));
    const lines: string[] = [];
    await expect(
      check("fiat-demo-run-01", { ...quiet, log: (line) => lines.push(line), stack: stack(0) }),
    ).rejects.toThrow(/demo-cast\.json is missing/);
    expect(lines.join("\n")).toContain('"mosela-refused": ""');
  });

  it("demo:check of a lender run wants eight Authorities including the seed issuer", async () => {
    const dir = await keysDir();
    const cast = await castFile(dir);
    const issuer = await loadOrCreateKeyForTest(dir);
    const run = await reset(
      { scenario: "lender", run: 1, yes: false },
      deps(dir, memoryChain(), fakeStack(), seedSql, async () => () => new Uint8Array(1)).deps,
    );
    // A lender run file, as a --yes run would leave it.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "runs"), { recursive: true });
    writeFileSync(
      join(dir, "runs", "fiat-lend-run-01.json"),
      JSON.stringify({
        scenario: "lender",
        instanceId: "fiat-lend-run-01",
        protocol: run.protocol,
        t0: Number(run.t0),
        expiresAt: Number(run.expiresAt),
        explorer: "",
        authorities: [],
        custodianClasses: [],
        lookupTable: null,
        lot: null,
        transactions: [],
        supabase: { status: "done", users: [] },
      }),
    );
    const stack = (withIssuer: boolean) => {
      const s = fakeStack();
      s.query = async (sql: string) => {
        if (/indexer_checkpoints/.test(sql)) return [{ protocol: run.protocol, status: "live" }];
        if (/chain_organisations/.test(sql))
          return organisations.map((o) => ({ org_id: o.id, synthetic: true }));
        if (/chain_custodian_classes/.test(sql)) {
          return CUSTODIAN_CLASSES.map((c) => ({
            site_code: c.site,
            approved_capacity_kg: c.approvedKg.toString(),
          }));
        }
        if (/chain_authorities/.test(sql)) {
          const rows: Record<string, unknown>[] = DELEGATIONS.map((d) => ({
            wallet: cast.wallets[d.key],
            scopes: d.scopes,
            expires_at: String(run.expiresAt),
            revoked_at: null,
          }));
          if (withIssuer) {
            rows.push({
              wallet: issuer,
              scopes: 1,
              expires_at: String(run.expiresAt),
              revoked_at: null,
            });
          }
          return rows;
        }
        if (/signer_links/.test(sql)) {
          return Object.entries(cast.wallets).map(([key, wallet]) => ({
            wallet,
            slug: key === "mosela-refused" ? "mosela" : key,
          }));
        }
        if (/chain_lots/.test(sql)) return [{ state: "Stored", supply_kg: "5000000" }];
        return [];
      };
      return s;
    };
    const quiet = { keysDir: dir, repoRoots: [repoRoot], log: () => {} };
    const full = await check("fiat-lend-run-01", { ...quiet, stack: stack(true) });
    expect(full.items.filter((i) => !i.ok)).toEqual([]);
    expect(full.items.map((i) => i.item)).toContain("exactly 8 Authorities on fiat-lend-run-01");
    const missing = await check("fiat-lend-run-01", { ...quiet, stack: stack(false) });
    expect(missing.items.filter((i) => !i.ok).map((i) => i.item)).toEqual([
      "exactly 8 Authorities on fiat-lend-run-01",
      `${ISSUER_KEY} Authority (scopes 1)`,
    ]);
  });

  it("the dry run reads the marker and the checkpoint and says whether it would wipe", async () => {
    const dir = await keysDir();
    await castFile(dir);
    const same = deps(
      dir,
      memoryChain(),
      fakeStack({ marker: "fiat-demo-run-01", checkpointAge: 30 }),
    );
    await reset({ scenario: "phone", run: 1, yes: false }, same.deps);
    const kept = same.lines.join("\n");
    expect(kept).toContain("already holds this run's cast (demo_run = fiat-demo-run-01): no wipe");
    expect(kept).toMatch(/indexer checkpoint .* polled 30 s ago/i);
    expect(same.stack.calls.some((sql) => /from private\.settings/.test(sql))).toBe(true);
    expect(same.stack.resets()).toBe(0);

    const other = deps(dir, memoryChain(), fakeStack({ marker: "fiat-demo-run-07" }));
    await reset({ scenario: "phone", run: 1, yes: false }, other.deps);
    const wiped = other.lines.join("\n");
    expect(wiped).toContain("wipes the local Supabase database");
    expect(wiped).toContain("demo_run = fiat-demo-run-07");
    expect(wiped).toMatch(/no indexer checkpoint/i);
    expect(other.stack.resets()).toBe(0);
  });

  it("a refused lender --yes run creates no seed issuer key", async () => {
    const dir = await keysDir();
    await castFile(dir);
    const poor = deps(
      dir,
      memoryChain({ balance: 50_000_000n }),
      fakeStack(),
      seedSql,
      async () => () => new Uint8Array(1),
    );
    await expect(reset({ scenario: "lender", run: 1, yes: true }, poor.deps)).rejects.toThrow(
      /balance/,
    );
    expect(existsSync(join(dir, `${ISSUER_KEY}.json`))).toBe(false);
    const busy = deps(
      dir,
      memoryChain(),
      fakeStack({ listening: [3100] }),
      seedSql,
      async () => () => new Uint8Array(1),
    );
    await expect(reset({ scenario: "lender", run: 1, yes: true }, busy.deps)).rejects.toThrow(
      /3100/,
    );
    expect(existsSync(join(dir, `${ISSUER_KEY}.json`))).toBe(false);
  });

  it("the cost check's account sizes equal state.rs and the generated codecs", () => {
    const state = readFileSync(join(repoRoot, "programs/thetis/src/state.rs"), "utf8");
    const constant = (name: string) =>
      Number(new RegExp(`pub const ${name}: usize = (\\d+);`).exec(state)?.[1]);
    expect(STATE_MAX).toEqual({
      classCode: constant("MAX_CLASS_CODE"),
      grades: constant("MAX_GRADES"),
      grade: constant("MAX_GRADE"),
      displayName: constant("MAX_DISPLAY_NAME"),
      related: constant("MAX_RELATED"),
      siteCode: constant("MAX_SITE_CODE"),
      lotId: constant("MAX_LOT_ID"),
    });
    const key = "11111111111111111111111111111111" as Address;
    const text = (n: number) => "x".repeat(n);
    const classPolicy = getClassPolicyEncoder().encode({
      protocol: key,
      classCode: text(STATE_MAX.classCode),
      version: 1,
      unit: 0,
      grades: Array(STATE_MAX.grades).fill(text(STATE_MAX.grade)),
      originRequired: false,
      lotValiditySecs: 0n,
      splitInheritsExpiry: false,
      bump: 0,
    }).length;
    const organisation = getOrganisationEncoder().encode({
      protocol: key,
      orgId: new Uint8Array(16),
      role: 0,
      displayName: text(STATE_MAX.displayName),
      admin: key,
      related: Array(STATE_MAX.related).fill(key),
      bump: 0,
    }).length;
    const custodianClass = getCustodianClassEncoder().encode({
      protocol: key,
      custodian: key,
      classPolicy: key,
      siteCode: text(STATE_MAX.siteCode),
      approvedCapacityKg: 0n,
      occupiedKg: 0n,
      reservedInboundKg: 0n,
      bump: 0,
    }).length;
    const authority = getAuthorityEncoder().encode({
      protocol: key,
      organisation: key,
      wallet: key,
      scopes: 0,
      expiresAt: 0n,
      revokedAt: { __option: "Some", value: 0n },
      bump: 0,
    }).length;
    const lot = getLotEncoder().encode({
      protocol: key,
      lotId: text(STATE_MAX.lotId),
      classPolicy: key,
      classVersion: 1,
      grade: text(STATE_MAX.grade),
      custodianClass: key,
      intake: key,
      parent: { __option: "Some", value: key },
      root: key,
      mint: key,
      supplyKg: 0n,
      state: 0,
      restriction: 0,
      expiresAt: 0n,
      revision: 0n,
      liveChildren: 0,
      bump: 0,
    }).length;
    expect(ACCOUNT_BYTES).toEqual({
      Protocol: getProtocolSize(),
      ClassPolicy: classPolicy,
      Organisation: organisation,
      OrganisationName: getOrganisationNameSize(),
      CustodianClass: custodianClass,
      Authority: authority,
      IntakeIdentity: getIntakeIdentitySize(),
      Lot: lot,
      Mint: getMintSize(),
      Position: getPositionSize(),
      // A Token-2022 account with ImmutableOwner: base, account type byte, one empty TLV entry.
      Vault: getTokenSize() + 1 + 4,
      LookupTableHeader: 56,
    });
    // The review's figures (state.rs with the 8-byte discriminator), checked once by hand.
    expect(ACCOUNT_BYTES).toMatchObject({
      Protocol: 92,
      ClassPolicy: 168,
      Organisation: 402,
      OrganisationName: 8,
      CustodianClass: 149,
      Authority: 124,
      IntakeIdentity: 138,
      Lot: 300,
      Position: 137,
      Mint: 82,
      Vault: 170,
    });
    const planned = new Map(
      planSteps("lender").flatMap((step) => step.creates.map((c) => [c.label, c.bytes])),
    );
    for (const [label, bytes] of planned) {
      if (label === "lookup table") expect(bytes).toBe(ACCOUNT_BYTES.LookupTableHeader + 32 * 17);
      else expect(bytes).toBe(ACCOUNT_BYTES[label as keyof typeof ACCOUNT_BYTES]);
    }
  });
});

async function loadOrCreateKeyForTest(dir: string): Promise<string> {
  const { loadOrCreateKey } = await import("../../../scripts/seed-demo.ts");
  return (await loadOrCreateKey(dir, ISSUER_KEY)).address;
}
