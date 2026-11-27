// scripts/demo-reset.ts against the real Thetis program in LiteSVM (demo.md §5.8). Every key is a
// throwaway generated here, the local Supabase is the in-memory fake, and nothing reaches devnet.
// The issue text in the lender case is a test-only builder over the relay's envelope: the script
// itself takes T067r's issueLotMessage and refuses while it is missing (demo-reset.test.ts).
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  getTransactionEncoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Transaction,
} from "@solana/kit";
import {
  fetchMaybeAuthority,
  fetchMaybeCustodianClass,
  fetchMaybeLot,
  fetchMaybeOrganisation,
  fetchMaybeProtocol,
  findAuthorityPda,
  findOrganisationPda,
  findProtocolPda,
  getDelegateAuthorityInstruction,
  THETIS_PROGRAM_ADDRESS,
} from "@thetis/contracts";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { describe, expect, it } from "vitest";
import {
  type Chain,
  CUSTODIAN_CLASSES,
  DELEGATIONS,
  type IssueText,
  reset,
} from "../../../scripts/demo-reset.ts";
import { loadOrCreateKey, readKeyFile } from "../../../scripts/seed-demo.ts";
import { envelope, formatTonnes } from "../../../services/api/src/commands/texts.ts";
import {
  castFile,
  fakeStack,
  keysDir,
  organisations,
  repoRoot,
  seedSql,
} from "./demo-reset.fakes.ts";

const programSo = join(repoRoot, "target/deploy/thetis.so");
const NOW = 1_800_000_000n;
const MAX_TRANSACTION_BYTES = 1_232;
const ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111";

type SvmChain = Chain & { svm: LiteSVM; sizes: number[] };

function svmChain(svm: LiteSVM): SvmChain {
  const landed = new Set<string>();
  const sizes: number[] = [];
  const advance = () => {
    svm.warpToSlot(svm.getClock().slot + 1n);
    const [latest] = svm.getSlotHashes();
    if (!latest) throw new Error("LiteSVM has no slot hash");
    latest.slot = svm.getClock().slot;
    latest.hash = svm.latestBlockhash();
    svm.setSlotHashes([latest]);
  };
  return {
    svm,
    sizes,
    rpc: {
      getAccountInfo(address: Address) {
        return {
          send: async () => {
            const account = svm.getAccount(address);
            return {
              context: { slot: svm.getClock().slot },
              value: account.exists
                ? {
                    data: [Buffer.from(account.data).toString("base64"), "base64"],
                    executable: account.executable,
                    lamports: account.lamports,
                    owner: account.programAddress,
                    space: BigInt(account.data.length),
                    rentEpoch: 0n,
                  }
                : null,
            };
          },
        };
      },
    } as unknown as Chain["rpc"],
    programDeployed: async () => svm.getAccount(THETIS_PROGRAM_ADDRESS).exists,
    unixTime: async () => svm.getClock().unixTimestamp,
    slot: async () => {
      advance();
      return svm.getClock().slot;
    },
    balance: async (address) => svm.getBalance(address) ?? 0n,
    rent: async (bytes) => svm.minimumBalanceForRentExemption(BigInt(bytes)),
    latestBlockhash: async () => {
      svm.expireBlockhash();
      return { blockhash: svm.latestBlockhash(), lastValidBlockHeight: svm.getClock().slot + 150n };
    },
    submit: async (transaction: Transaction) => {
      sizes.push(getTransactionEncoder().encode(transaction).length);
      const result = svm.sendTransaction(transaction);
      if (result instanceof FailedTransactionMetadata) {
        throw new Error(`${result.toString()}\n${result.meta().prettyLogs()}`);
      }
      landed.add(Buffer.from(Object.values(transaction.signatures)[0] ?? []).toString("hex"));
    },
    statuses: async (signatures) => signatures.map(() => ({ failed: false, confirmed: true })),
    blockHeight: async () => svm.getClock().slot,
    lookupTable: async (table) => {
      const account = svm.getAccount(table);
      if (!account.exists || account.programAddress !== ALT_PROGRAM) return null;
      const decoder = getAddressDecoder();
      const out: Address[] = [];
      for (let at = 56; at + 32 <= account.data.length; at += 32) {
        out.push(decoder.decode(account.data.subarray(at, at + 32)));
      }
      return out;
    },
  };
}

async function world() {
  if (!existsSync(programSo)) {
    throw new Error(`${programSo} is missing: run anchor build -p thetis before this suite`);
  }
  const svm = new LiteSVM().withPrecompiles();
  svm.addProgramFromFile(THETIS_PROGRAM_ADDRESS, programSo);
  const clock = svm.getClock();
  clock.unixTimestamp = NOW;
  clock.slot = 5_000n;
  svm.setClock(clock);
  const chain = svmChain(svm);
  await chain.slot();
  const dir = await keysDir();
  const deployer = await loadOrCreateKey(dir, "deployer");
  svm.airdrop(deployer.address, lamports(10_000_000_000n));
  const cast = await castFile(dir);
  return { svm, chain, dir, cast };
}

function deps(
  chain: Chain,
  dir: string,
  issueText: () => Promise<IssueText | null> = async () => null,
) {
  return {
    chain,
    stack: fakeStack(),
    keysDir: dir,
    repoRoots: [repoRoot],
    seedSql,
    log: () => {},
    issueText,
    sleep: async () => {},
  };
}

const testIssueText: IssueText = (fields) =>
  envelope(
    fields.programId,
    Buffer.from(fields.instanceId).toString("hex"),
    "Issue lot",
    [
      ["Lot", fields.lotId],
      ["Class", `${fields.classCode} v${fields.classVersion}`],
      ["Grade", fields.grade],
      ["Quantity", formatTonnes(fields.quantityKg)],
      ["Owner", fields.owner],
      ["Custodian", fields.custodian],
      ["Site", fields.siteCode],
      ["Intake", Buffer.from(fields.intakeDigest).toString("hex")],
      ["Origin document", "not required"],
    ],
    fields.validUntil,
  );

async function protocolOf(instanceId: string) {
  const [protocol] = await findProtocolPda({ instanceId: new TextEncoder().encode(instanceId) });
  return protocol;
}

async function lotPda(protocol: Address) {
  const encoder = new TextEncoder();
  const [lot] = await getProgramDerivedAddress({
    programAddress: THETIS_PROGRAM_ADDRESS,
    seeds: [encoder.encode("lot"), getAddressEncoder().encode(protocol), encoder.encode("CR-0001")],
  });
  return lot;
}

async function orgAddress(protocol: Address, slug: string) {
  const organisation = organisations.find((o) => o.slug === slug);
  if (!organisation) throw new Error(slug);
  const [address] = await findOrganisationPda({ protocol, orgId: organisation.orgId });
  return address;
}

describe("demo reset in LiteSVM (demo.md §5.8)", () => {
  it("a phone run lands B1 to B18 and leaves §5.1's accounts and no Lot CR-0001", async () => {
    const { chain, dir, cast } = await world();
    const result = await reset({ scenario: "phone", run: 1, yes: true }, deps(chain, dir));
    expect(result.sent).toHaveLength(18);
    expect(chain.sizes.every((size) => size <= MAX_TRANSACTION_BYTES)).toBe(true);
    const protocol = await protocolOf("fiat-demo-run-01");
    expect(result.protocol).toBe(protocol);
    expect((await fetchMaybeProtocol(chain.rpc, protocol)).exists).toBe(true);
    for (const organisation of organisations) {
      const found = await fetchMaybeOrganisation(
        chain.rpc,
        await orgAddress(protocol, organisation.slug),
      );
      expect(found.exists && found.data.displayName).toBe(organisation.name);
      expect(found.exists && found.data.related).toEqual([]);
    }
    expect(result.runFile?.custodianClasses.map((c) => [c.site, c.approvedKg])).toEqual(
      CUSTODIAN_CLASSES.map((c) => [c.site, c.approvedKg.toString()]),
    );
    for (const custodianClass of result.runFile?.custodianClasses ?? []) {
      const found = await fetchMaybeCustodianClass(chain.rpc, custodianClass.address as Address);
      expect(found.exists && found.data.siteCode).toBe(custodianClass.site);
      expect(found.exists && found.data.occupiedKg).toBe(0n);
    }
    for (const delegation of DELEGATIONS) {
      const [authority] = await findAuthorityPda({
        protocol,
        wallet: cast.wallets[delegation.key] as Address,
      });
      const found = await fetchMaybeAuthority(chain.rpc, authority);
      expect(found.exists).toBe(true);
      if (!found.exists) continue;
      expect(found.data.scopes).toBe(delegation.scopes);
      expect(found.data.expiresAt).toBe(NOW + 2_592_000n);
      expect(found.data.organisation).toBe(await orgAddress(protocol, delegation.slug));
    }
    const [refused] = await findAuthorityPda({
      protocol,
      wallet: cast.wallets["mosela-refused"] as Address,
    });
    expect((await fetchMaybeAuthority(chain.rpc, refused)).exists).toBe(false);
    expect((await fetchMaybeLot(chain.rpc, await lotPda(protocol))).exists).toBe(false);
  });

  it("a rerun of the same NN sends nothing", async () => {
    const { chain, dir } = await world();
    await reset({ scenario: "phone", run: 1, yes: true }, deps(chain, dir));
    const sizes = chain.sizes.length;
    const again = await reset({ scenario: "phone", run: 1, yes: true }, deps(chain, dir));
    expect(again.sent).toEqual([]);
    expect(again.steps.every((step) => step.action === "skip")).toBe(true);
    expect(chain.sizes).toHaveLength(sizes);
  });

  it("mosela-refused has no Authority and a planned Authority for it is refused", async () => {
    const { svm, chain, dir, cast } = await world();
    await reset({ scenario: "phone", run: 1, yes: true }, deps(chain, dir));
    // Someone delegates the refused wallet by hand: the next reset of the run refuses (refusal 9).
    const protocol = await protocolOf("fiat-demo-run-01");
    const admin = await readKeyFile(join(dir, "org-mosela.json"));
    const deployer = await readKeyFile(join(dir, "deployer.json"));
    const wallet = cast.wallets["mosela-refused"] as Address;
    const [authority] = await findAuthorityPda({ protocol, wallet });
    const mosela = await orgAddress(protocol, "mosela");
    svm.expireBlockhash();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(deployer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: svm.latestBlockhash() as never, lastValidBlockHeight: 0n },
          m,
        ),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getDelegateAuthorityInstruction({
              protocol,
              organisation: mosela,
              authority,
              admin,
              payer: deployer,
              wallet,
              scopes: 3072,
              expiresAt: NOW + 100n,
            }),
          ],
          m,
        ),
    );
    await chain.submit(await signTransactionMessageWithSigners(message));
    expect((await fetchMaybeAuthority(chain.rpc, authority)).exists).toBe(true);
    await expect(reset({ scenario: "phone", run: 1, yes: true }, deps(chain, dir))).rejects.toThrow(
      /mosela-refused/,
    );
  });

  it("a lender run issues CR-0001 at KOPANO-YARD-1 in a v0 transaction of at most 1,232 bytes", async () => {
    const { chain, dir } = await world();
    const result = await reset(
      { scenario: "lender", run: 1, yes: true },
      deps(chain, dir, async () => testIssueText),
    );
    expect(result.sent).toHaveLength(22);
    expect(chain.sizes).toHaveLength(22);
    expect(Math.max(...chain.sizes)).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    const protocol = await protocolOf("fiat-lend-run-01");
    const lot = await fetchMaybeLot(chain.rpc, await lotPda(protocol));
    expect(lot.exists).toBe(true);
    if (!lot.exists) return;
    expect(lot.data.lotId).toBe("CR-0001");
    expect(lot.data.supplyKg).toBe(5_000_000n);
    expect(lot.data.grade).toBe("G1");
    const yard = result.runFile?.custodianClasses.find((c) => c.site === "KOPANO-YARD-1");
    expect(lot.data.custodianClass).toBe(yard?.address);
    const found = await fetchMaybeCustodianClass(chain.rpc, yard?.address as Address);
    expect(found.exists && found.data.occupiedKg).toBe(5_000_000n);
    expect(result.runFile?.lot).toEqual({ lotId: "CR-0001", address: lot.address });
  });

  it("a phone run whose CR-0001 exists is refused as Used", async () => {
    const { svm, chain, dir } = await world();
    await reset({ scenario: "phone", run: 1, yes: true }, deps(chain, dir));
    const protocol = await protocolOf("fiat-demo-run-01");
    // Stand in for the live intake on phone 1: an account at the run's Lot CR-0001 address.
    const lot = await lotPda(protocol);
    svm.setAccount({
      address: lot,
      data: new Uint8Array(300),
      executable: false,
      lamports: lamports(10_000_000n),
      programAddress: THETIS_PROGRAM_ADDRESS,
      space: 300n,
    });
    await expect(reset({ scenario: "phone", run: 1, yes: true }, deps(chain, dir))).rejects.toThrow(
      /Used/,
    );
  });
});
