import type { App } from "aws-cdk-lib";
import { RegionInfo } from "aws-cdk-lib/region-info";
import { ApiStack } from "./api.ts";
import { BudgetStack } from "./budget.ts";
import { OpsStack } from "./ops.ts";
import { ReleaseStack } from "./release.ts";
import { SecretsStack } from "./secrets.ts";
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

export function createStacks(app: App) {
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
  const secrets = new SecretsStack(app, `${stackPrefix}-Secrets`, { ...settings, instance });
  const api = new ApiStack(app, `${stackPrefix}-Api`, {
    ...settings,
    instance,
    sponsorKeyArn: secrets.sponsorKey.secretArn,
  });
  const worker = new WorkerStack(app, `${stackPrefix}-Worker`, {
    ...settings,
    instance,
    availabilityZones,
  });
  const ops = new OpsStack(app, `${stackPrefix}-Ops`, { ...settings, alertEmail, api, worker });
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

  return { secrets, api, worker, ops, budget, release };
}
