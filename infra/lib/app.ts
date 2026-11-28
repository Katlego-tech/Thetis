import type { App } from "aws-cdk-lib";
import { RegionInfo } from "aws-cdk-lib/region-info";
import { ApiStack } from "./api.ts";
import { BudgetStack } from "./budget.ts";
import { OpsStack } from "./ops.ts";
import { ReleaseStack } from "./release.ts";
import { SecretsStack } from "./secrets.ts";
import { WebStack } from "./web.ts";
import { WorkerStack } from "./worker.ts";

const budgetRegion = "us-east-1";

function required(app: App, key: string, valid: (value: string) => boolean, expected: string) {
  const raw: unknown = app.node.tryGetContext(key);
  const value = typeof raw === "number" && key === "budgetMonthlyUsd" ? String(raw) : raw;
  if (typeof value !== "string" || !valid(value)) {
    throw new Error(`Invalid or missing CDK context "${key}": expected ${expected}`);
  }
  return value;
}

const base58 = "[1-9A-HJ-NP-Za-km-z]";

export interface CreateStacksOptions {
  /** The staged web build directory; defaults to apps/web/.lambda. */
  webLambdaDirectory?: string;
}

export function createStacks(app: App, options: CreateStacksOptions = {}) {
  const rawProfile: unknown = app.node.tryGetContext("profile");
  const profile = rawProfile === undefined ? "full" : rawProfile;
  if (profile !== "full" && profile !== "judge") {
    throw new Error('Invalid CDK context "profile": expected full or judge');
  }
  const judge = profile === "judge";
  const account = required(
    app,
    "account",
    (value) => /^\d{12}$/.test(value),
    "a 12-digit account ID",
  );
  const region = required(
    app,
    "region",
    (value) => RegionInfo.get(value).partition === "aws",
    "a known AWS commercial region",
  );
  const availabilityZones = required(
    app,
    "availabilityZones",
    (value) => {
      const zones = value.split(",");
      return (
        zones.length === 2 &&
        new Set(zones).size === 2 &&
        zones.every((zone) => zone.startsWith(region) && /^[a-z]$/.test(zone.slice(region.length)))
      );
    },
    `two distinct comma-separated availability zone names in ${region}`,
  ).split(",");
  const instance = required(
    app,
    "instance",
    (value) => value === "fiat-attestation-test" || value === "devnet-token-simulation",
    "fiat-attestation-test or devnet-token-simulation",
  );
  const githubRepo = required(
    app,
    "githubRepo",
    (value) => value === "Katlego-tech/Thetis",
    "Katlego-tech/Thetis",
  );
  const budgetMonthlyUsd = Number(
    required(
      app,
      "budgetMonthlyUsd",
      (value) => /^\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0,
      "a positive USD amount",
    ),
  );
  const alertEmail = required(
    app,
    "alertEmail",
    (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    "an email address",
  );

  const supabaseUrl = required(
    app,
    "supabaseUrl",
    (value) => /^https:\/\/[a-z]{20}\.supabase\.co$/.test(value),
    "a hosted Supabase project URL, https://<20 lowercase letters>.supabase.co",
  );

  const thetisProtocol = required(
    app,
    "thetisProtocol",
    (value) => new RegExp(`^${base58}{32,44}$`).test(value),
    "a base58 protocol address",
  );
  const thetisFirstSignature = required(
    app,
    "thetisFirstSignature",
    (value) => new RegExp(`^${base58}{64,88}$`).test(value),
    "a base58 transaction signature",
  );
  const supabaseAnonKey = judge
    ? required(
        app,
        "supabaseAnonKey",
        (value) =>
          /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ||
          /^sb_publishable_[A-Za-z0-9_-]+$/.test(value),
        "a Supabase anon JWT or sb_publishable_ key",
      )
    : undefined;

  const createProvider: unknown = app.node.tryGetContext("createGithubOidcProvider");
  if (
    createProvider !== undefined &&
    createProvider !== true &&
    createProvider !== false &&
    createProvider !== "true" &&
    createProvider !== "false"
  ) {
    throw new Error('Invalid CDK context "createGithubOidcProvider": expected true or false');
  }

  const settings = { env: { account, region }, tags: { project: "thetis", instance } };
  const stackPrefix = `Thetis-${instance}`;
  const secrets = new SecretsStack(app, `${stackPrefix}-Secrets`, {
    ...settings,
    instance,
    includeSponsorKey: !judge,
  });
  const api =
    !judge && secrets.sponsorKey
      ? new ApiStack(app, `${stackPrefix}-Api`, {
          ...settings,
          instance,
          sponsorKeyArn: secrets.sponsorKey.secretArn,
        })
      : undefined;
  const worker = new WorkerStack(app, `${stackPrefix}-Worker`, {
    ...settings,
    instance,
    availabilityZones,
    supabaseUrl,
    thetisProtocol,
    thetisFirstSignature,
    supabaseServiceRole: secrets.supabaseServiceRole,
    solanaRpcUrl: secrets.solanaRpcUrl,
  });
  const web =
    supabaseAnonKey === undefined
      ? undefined
      : new WebStack(app, `${stackPrefix}-Web`, {
          ...settings,
          instance,
          supabaseUrl,
          supabaseAnonKey,
          ...(options.webLambdaDirectory === undefined
            ? {}
            : { lambdaDirectory: options.webLambdaDirectory }),
        });
  const ops = new OpsStack(app, `${stackPrefix}-Ops`, {
    ...settings,
    instance,
    alertEmail,
    worker,
    ...(api ? { api } : {}),
    ...(web ? { web } : {}),
  });
  const budget = new BudgetStack(app, `${stackPrefix}-Budget`, {
    ...settings,
    env: { account, region: budgetRegion },
    instance,
    budgetMonthlyUsd,
    alertEmail,
  });
  const release = new ReleaseStack(app, `${stackPrefix}-Release`, {
    ...settings,
    instance,
    githubRepo,
    createGithubOidcProvider: createProvider === true || createProvider === "true",
    bootstrapRegions: [...new Set([region, budgetRegion])],
  });

  return {
    secrets,
    ...(api ? { api } : {}),
    worker,
    ...(web ? { web } : {}),
    ops,
    budget,
    release,
  };
}
