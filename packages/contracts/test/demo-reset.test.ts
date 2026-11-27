// Tests for scripts/demo-reset.ts (demo.md §5). They live here for the same reason as
// seed-demo.test.ts: scripts/ is not a workspace package. Nothing here touches a network or a
// database: the chain and the local Supabase are in-memory fakes. Every key is a throwaway.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type Address,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import {
  findProtocolPda,
  getProtocolEncoder,
  SettlementMode,
  THETIS_PROGRAM_ADDRESS,
} from "@thetis/contracts";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_LIFETIME_SECS,
  type Chain,
  CUSTODIAN_CLASSES,
  DELEGATIONS,
  DemoError,
  estimateCost,
  instanceIdFor,
  loadIssueText,
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
} from "../../../scripts/demo-reset.ts";
import {
  castFile,
  fakeStack,
  keysDir,
  organisations,
  repoRoot,
  seedSql,
} from "./demo-reset.fakes.ts";

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

function deps(dir: string, chain = memoryChain(), stack = fakeStack(), sql = seedSql) {
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
      issueText: async () => null,
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

  it("a lender run refuses before sending anything with needs T067r while texts.ts has no issueLotMessage", async () => {
    expect(await loadIssueText()).toBeNull();
    const dir = await keysDir();
    await castFile(dir);
    const run = deps(dir);
    await expect(reset({ scenario: "lender", run: 1, yes: true }, run.deps)).rejects.toThrow(
      NEEDS_T067R,
    );
    expect(run.chain.submitted).toEqual([]);
    expect(run.stack.resets()).toBe(0);
  });
});
