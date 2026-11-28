import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { App, type Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStacks } from "../lib/app.ts";

const instance = "fiat-attestation-test";
const valid = {
  account: "111111111111",
  region: "af-south-1",
  availabilityZones: "af-south-1a,af-south-1b",
  instance,
  githubRepo: "Katlego-tech/Thetis",
  budgetMonthlyUsd: "25",
  alertEmail: "alerts@example.invalid",
  // Declared placeholder until the hosted Supabase project exists.
  supabaseUrl: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co",
  thetisProtocol: "G9GNDdbYKQY14xv1xgNw1D6EY8SFnZxgHrDBdEbHsoo3",
  // The program's deploy transaction on devnet (README, "Seed transactions").
  thetisFirstSignature:
    "vtK8h43bEg8zDn5w7u319t6VfNztCKB87nYBJ7LN6bsgFmMR2cFKA2iVLKgve8spmhri9mQJbSk28amZthbVviE",
};
const oidcHost = "token.actions.githubusercontent.com";

function synth(context: Record<string, unknown>, webLambdaDirectory?: string) {
  const app = new App({ context, autoSynth: false });
  const stacks = createStacks(app, webLambdaDirectory ? { webLambdaDirectory } : {});
  return { assembly: app.synth(), stacks };
}

const invalidValues = {
  account: "123",
  region: "xx-fake-9",
  instance: "test",
  githubRepo: "another/repo",
  budgetMonthlyUsd: "0",
  alertEmail: "invalid",
  supabaseUrl: "https://example.supabase.co",
  thetisProtocol: "0OIl-not-base58",
  thetisFirstSignature: "G9GNDdbYKQY14xv1xgNw1D6EY8SFnZxgHrDBdEbHsoo3",
};

describe("required context", () => {
  it.each(Object.entries(invalidValues))(
    "rejects missing or invalid %s by name",
    (key, invalid) => {
      const context: Record<string, unknown> = { ...valid };
      delete context[key];
      expect(() => synth(context)).toThrow(key);
      expect(() => synth({ ...valid, [key]: invalid })).toThrow(key);
    },
  );

  it("rejects an unknown profile by name and accepts full explicitly", { timeout: 30_000 }, () => {
    expect(() => synth({ ...valid, profile: "demo" })).toThrow("profile");
    const names = synth({ ...valid, profile: "full" })
      .assembly.stacks.map(({ stackName }) => stackName)
      .sort();
    expect(names).toEqual(
      ["Api", "Budget", "Ops", "Release", "Secrets", "Worker"].map(
        (name) => `Thetis-${instance}-${name}`,
      ),
    );
  });

  it("rejects missing or invalid availabilityZones by name", () => {
    for (const availabilityZones of [
      undefined,
      "af-south-1a",
      "af-south-1a,af-south-1b,af-south-1c",
      "af-south-1a,us-east-1b",
      "af-south-1a,af-south-1a",
      "af-south-1a,af-south-1",
      ["af-south-1a", "af-south-1b"],
    ]) {
      expect(() => synth({ ...valid, availabilityZones })).toThrow("availabilityZones");
    }
  });
});

type PolicyStatement = {
  Action: string | string[];
  Effect: string;
  Resource?: unknown;
  NotAction?: unknown;
  NotResource?: unknown;
};

function policyStatements(template: Template) {
  const policies = [
    ...Object.values(template.findResources("AWS::IAM::Policy")),
    ...Object.values(template.findResources("AWS::IAM::RolePolicy")),
    ...Object.values(template.findResources("AWS::IAM::ManagedPolicy")),
  ];
  const attached = policies.flatMap(({ Properties }) =>
    (Properties.PolicyDocument.Statement as PolicyStatement[]).map((statement) => ({
      roles: Properties.Roles ?? [Properties.RoleName],
      statement,
    })),
  );
  const inline = Object.entries(template.findResources("AWS::IAM::Role")).flatMap(
    ([id, { Properties }]) =>
      (Properties.Policies ?? []).flatMap(
        ({ PolicyDocument }: { PolicyDocument: { Statement: PolicyStatement[] } }) =>
          PolicyDocument.Statement.map((statement) => ({ roles: [{ Ref: id }], statement })),
      ),
  );
  return [...attached, ...inline];
}

function actions(statement: PolicyStatement) {
  return [statement.Action].flat();
}

function findAllStatements(node: unknown): PolicyStatement[] {
  if (node === null || typeof node !== "object") return [];
  if ("Statement" in node) {
    return [node.Statement].flat() as PolicyStatement[];
  }
  return Object.values(node).flatMap(findAllStatements);
}

describe("synthesized deployment", () => {
  let stacks: Record<string, Stack>;
  let templates: Record<string, Template>;
  let assembly: ReturnType<App["synth"]>;

  beforeAll(() => {
    ({ assembly, stacks } = synth(valid));
    templates = Object.fromEntries(
      Object.entries(stacks).map(([name, stack]) => [name, Template.fromStack(stack)]),
    );
  }, 60_000);

  function template(name: string) {
    const result = templates[name];
    if (!result) throw new Error(`Missing stack ${name}`);
    return result;
  }

  function functionId(service: string) {
    return template("api").getResourceId("AWS::Lambda::Function", {
      Properties: { FunctionName: `thetis-${instance}-${service}` },
    });
  }

  function roleId(service: string) {
    const id = functionId(service);
    const resource = template("api").findResources("AWS::Lambda::Function")[id];
    if (!resource) throw new Error(`Missing Lambda resource ${id}`);
    const { Properties } = resource;
    return Properties.Role["Fn::GetAtt"][0];
  }

  function secretImport(name: string) {
    const secrets = template("secrets");
    const secretId = secrets.getResourceId("AWS::SecretsManager::Secret", {
      Properties: { Name: `thetis/${instance}/${name}` },
    });
    const [output] = Object.values(secrets.findOutputs("*", { Value: { Ref: secretId } }));
    if (!output) throw new Error(`secret ${name} is not exported`);
    return { "Fn::ImportValue": output.Export.Name };
  }

  function workerContainer() {
    const [task] = Object.values(template("worker").findResources("AWS::ECS::TaskDefinition"));
    const [container] = task?.Properties.ContainerDefinitions ?? [];
    if (!container) throw new Error("worker container missing");
    return container;
  }

  function workerExecutionRoleId() {
    const [task] = Object.values(template("worker").findResources("AWS::ECS::TaskDefinition"));
    return task?.Properties.ExecutionRoleArn["Fn::GetAtt"][0];
  }

  it("grants sponsor-key access exclusively to the sponsor role", () => {
    const secrets = template("secrets");
    const secretId = secrets.getResourceId("AWS::SecretsManager::Secret", {
      Properties: { Name: Match.stringLikeRegexp("/sponsor-key$") },
    });
    const exports = secrets.findOutputs("*", { Value: { Ref: secretId } });
    const [secret] = Object.values(exports);
    expect(secret?.Export.Name).toEqual(expect.any(String));
    const secretArn = { "Fn::ImportValue": secret?.Export.Name };

    const secretGrants = (name: string) =>
      policyStatements(template(name)).filter(({ statement }) =>
        actions(statement).some((action) => /^(secretsmanager:|\*)/i.test(action)),
      );
    for (const name of Object.keys(templates)) {
      if (name !== "api" && name !== "worker") expect(secretGrants(name), name).toEqual([]);
    }
    expect(secretGrants("api")).toEqual([
      {
        roles: [{ Ref: roleId("sponsor") }],
        statement: {
          Action: "secretsmanager:GetSecretValue",
          Effect: "Allow",
          Resource: secretArn,
        },
      },
    ]);
    // The indexing worker's execution role reads exactly its two secrets, never sponsor-key.
    const executionRole = workerExecutionRoleId();
    const workerGrants = secretGrants("worker");
    for (const { roles, statement } of workerGrants) {
      expect(roles).toEqual([{ Ref: executionRole }]);
      expect(statement.Effect).toBe("Allow");
    }
    const pairs = workerGrants.flatMap(({ statement }) =>
      actions(statement).flatMap((action) =>
        [statement.Resource].flat().map((resource) => `${action} ${JSON.stringify(resource)}`),
      ),
    );
    expect(new Set(pairs)).toEqual(
      new Set(
        ["supabase-service-role", "solana-rpc-url"].flatMap((name) =>
          ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"].map(
            (action) => `${action} ${JSON.stringify(secretImport(name))}`,
          ),
        ),
      ),
    );
    expect(pairs).toHaveLength(4);
    for (const item of Object.values(templates)) {
      item.resourceCountIs("AWS::SecretsManager::ResourcePolicy", 0);
    }
  });

  it("restricts IAM actions and wildcard resources to documented AWS requirements", () => {
    // ECR issues a registry login token before ECS can request an individual repository image.
    const wildcardActions = new Set(["ecr:GetAuthorizationToken"]);
    for (const item of Object.values(templates)) {
      const roles = Object.values(item.findResources("AWS::IAM::Role"));
      for (const statement of findAllStatements(item.toJSON().Resources)) {
        expect(statement.NotAction).toBeUndefined();
        expect(statement.NotResource).toBeUndefined();
        for (const action of actions(statement)) {
          expect(action).not.toMatch(/\*/);
          if ([statement.Resource].flat().includes("*")) {
            expect(wildcardActions.has(action), action).toBe(true);
          }
        }
      }
      // Inspect permissions in the templates instead of accepting opaque managed policies.
      for (const { Properties } of roles) expect(Properties.ManagedPolicyArns).toBeUndefined();
    }
  });

  it("keeps sponsor off the HTTP API and function URLs and pins its resource policy to the API role", () => {
    const api = template("api");
    const sponsor = functionId("sponsor");
    for (const item of Object.values(templates)) {
      item.resourceCountIs("AWS::Lambda::Url", 0);
      item.resourceCountIs("AWS::Lambda::EventSourceMapping", 0);
      if (item !== api) {
        item.resourceCountIs("AWS::ApiGatewayV2::Integration", 0);
        item.resourceCountIs("AWS::Lambda::Permission", 0);
      }
    }
    api.resourceCountIs("AWS::Lambda::Permission", 2);
    api.resourceCountIs("AWS::ApiGatewayV2::Integration", 1);
    api.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
      IntegrationUri: { "Fn::GetAtt": [functionId("api"), "Arn"] },
    });
    const permissions = Object.values(api.findResources("AWS::Lambda::Permission")).filter(
      ({ Properties }) => JSON.stringify(Properties.FunctionName).includes(sponsor),
    );
    expect(permissions.map(({ Properties }) => Properties)).toEqual([
      {
        Action: "lambda:InvokeFunction",
        FunctionName: { "Fn::GetAtt": [sponsor, "Arn"] },
        Principal: { "Fn::GetAtt": [roleId("api"), "Arn"] },
      },
    ]);
  });

  it("retains every CloudWatch log group for 90 days", () => {
    template("api").resourceCountIs("AWS::Logs::LogGroup", 2);
    template("worker").resourceCountIs("AWS::Logs::LogGroup", 2);
    for (const item of Object.values(templates)) {
      for (const group of Object.values(item.findResources("AWS::Logs::LogGroup"))) {
        expect(group).toMatchObject({
          DeletionPolicy: "Retain",
          UpdateReplacePolicy: "Retain",
          Properties: { RetentionInDays: 90 },
        });
      }
    }
  });

  it("pins GitHub release trust to the main branch and the STS audience", () => {
    template("release").hasResourceProperties("AWS::IAM::Role", {
      RoleName: `thetis-${instance}-release`,
      AssumeRolePolicyDocument: {
        Statement: Match.exact([
          {
            Action: "sts:AssumeRoleWithWebIdentity",
            Effect: "Allow",
            Principal: {
              Federated: {
                "Fn::Join": [
                  "",
                  [
                    "arn:",
                    { Ref: "AWS::Partition" },
                    `:iam::${valid.account}:oidc-provider/${oidcHost}`,
                  ],
                ],
              },
            },
            Condition: {
              StringEquals: {
                [`${oidcHost}:aud`]: "sts.amazonaws.com",
                [`${oidcHost}:sub`]: "repo:Katlego-tech/Thetis:ref:refs/heads/main",
              },
            },
          },
        ]),
      },
    });
  });

  it("tags all six CloudFormation stacks with the project and settlement instance", () => {
    expect(assembly.stacks.map(({ stackName }) => stackName).sort()).toEqual(
      ["Api", "Budget", "Ops", "Release", "Secrets", "Worker"].map(
        (name) => `Thetis-${instance}-${name}`,
      ),
    );
    for (const stack of assembly.stacks) {
      expect(stack.tags).toMatchObject({ project: "thetis", instance });
    }
  });

  it("creates the three retained secrets with AWS-managed encryption", () => {
    const secrets = template("secrets");
    secrets.resourceCountIs("AWS::SecretsManager::Secret", 3);
    for (const name of ["sponsor-key", "supabase-service-role", "solana-rpc-url"]) {
      secrets.hasResource("AWS::SecretsManager::Secret", {
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
        Properties: {
          Name: `thetis/${instance}/${name}`,
          KmsKeyId: Match.absent(),
          SecretString: Match.absent(),
        },
      });
    }
  });

  it("routes only GET /health to ARM64 Node 24 and caps sponsor concurrency at two", () => {
    const api = template("api");
    api.resourceCountIs("AWS::Lambda::Function", 2);
    api.allResourcesProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      Handler: "index.handler",
    });
    api.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: `thetis-${instance}-sponsor`,
      ReservedConcurrentExecutions: 2,
    });
    api.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
    api.hasResourceProperties("AWS::ApiGatewayV2::Api", { ProtocolType: "HTTP" });
    api.resourceCountIs("AWS::ApiGatewayV2::Route", 1);
    api.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /health" });
  });

  it("runs one ARM64 Fargate worker with a public IP in two public subnets and no NAT", () => {
    const worker = template("worker");
    worker.resourceCountIs("AWS::EC2::Subnet", 2);
    worker.resourceCountIs("AWS::EC2::NatGateway", 0);
    worker.allResourcesProperties("AWS::EC2::Subnet", { MapPublicIpOnLaunch: true });
    expect(
      Object.values(worker.findResources("AWS::EC2::Subnet"))
        .map(({ Properties }) => Properties.AvailabilityZone)
        .sort(),
    ).toEqual(valid.availabilityZones.split(","));
    expect(assembly.manifest.missing ?? []).toEqual([]);
    worker.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Cpu: "256",
      Memory: "512",
      RequiresCompatibilities: ["FARGATE"],
      RuntimePlatform: { CpuArchitecture: "ARM64", OperatingSystemFamily: "LINUX" },
    });
    worker.hasResourceProperties("AWS::ECS::Service", {
      ServiceName: "worker",
      DesiredCount: 1,
      NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: "ENABLED" } },
    });
    const imageManifest: { dockerImages: Record<string, { source: { directory: string } }> } =
      JSON.parse(
        readFileSync(`${assembly.directory}/${stacks.worker?.artifactId}.assets.json`, "utf8"),
      );
    expect(Object.values(imageManifest.dockerImages)).toEqual([
      expect.objectContaining({ source: expect.objectContaining({ platform: "linux/arm64" }) }),
    ]);
    const [image] = Object.values(imageManifest.dockerImages);
    if (!image) throw new Error("Worker image asset missing");
    const dockerfile = readFileSync(
      `${assembly.directory}/${image.source.directory}/Dockerfile`,
      "utf8",
    );
    expect(dockerfile).toContain(
      "FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54",
    );
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toContain('CMD ["node", "dist/main.js"]');
    const staged = `${assembly.directory}/${image.source.directory}`;
    const files = readdirSync(staged, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(staged, join(entry.parentPath, entry.name)))
      .sort();
    expect(files).toEqual([".dockerignore", "Dockerfile", "dist/main.js"]);
  });

  it("waits for both public subnet route table associations and default routes", () => {
    const worker = template("worker");
    const associations = worker.findResources("AWS::EC2::SubnetRouteTableAssociation");
    const routes = worker.findResources("AWS::EC2::Route", {
      Properties: { DestinationCidrBlock: "0.0.0.0/0", GatewayId: Match.anyValue() },
    });
    expect(Object.keys(associations)).toHaveLength(2);
    expect(Object.keys(routes)).toHaveLength(2);
    const [service] = Object.values(worker.findResources("AWS::ECS::Service"));
    expect(service?.DependsOn).toEqual(
      expect.arrayContaining([...Object.keys(associations), ...Object.keys(routes)]),
    );
  });

  it("notifies the operations topic for Lambda failures and a missing worker", () => {
    const ops = template("ops");
    const topic = { Ref: ops.getResourceId("AWS::SNS::Topic") };
    ops.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: valid.alertEmail,
      TopicArn: topic,
    });
    ops.resourceCountIs("AWS::CloudWatch::Alarm", 4);
    const alarms = Object.values(ops.findResources("AWS::CloudWatch::Alarm"));
    expect(alarms.filter(({ Properties }) => Properties.MetricName === "Errors")).toHaveLength(2);
    for (const { Properties } of alarms.filter(
      ({ Properties }) => Properties.MetricName === "Errors",
    )) {
      expect(Properties).toMatchObject({
        Namespace: "AWS/Lambda",
        Period: 300,
        Statistic: "Sum",
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        AlarmActions: [topic],
      });
    }
    ops.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "ECS/ContainerInsights",
      MetricName: "RunningTaskCount",
      Threshold: 1,
      ComparisonOperator: "LessThanThreshold",
      TreatMissingData: "breaching",
      AlarmActions: [topic],
    });
  });

  it("gives the fiat-attestation-test worker the indexer variables and secrets", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const deploy = /\[deploy transaction\]\(https:\/\/explorer\.solana\.com\/tx\/([1-9A-HJ-NP-Za-km-z]{64,88})\?cluster=devnet\)/.exec(
      readme,
    )?.[1];
    expect(deploy).toEqual(expect.any(String));
    const container = workerContainer();
    const environment = Object.fromEntries(
      (container.Environment ?? []).map(({ Name, Value }: { Name: string; Value: unknown }) => [Name, Value]),
    );
    expect(environment).toEqual({
      THETIS_INDEXER: "on",
      THETIS_NETWORK: "devnet",
      THETIS_PROGRAM_ID: "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3",
      THETIS_PROTOCOL: "G9GNDdbYKQY14xv1xgNw1D6EY8SFnZxgHrDBdEbHsoo3",
      THETIS_FIRST_SIGNATURE: deploy,
      SUPABASE_URL: valid.supabaseUrl,
    });
    const secrets = Object.fromEntries(
      (container.Secrets ?? []).map(({ Name, ValueFrom }: { Name: string; ValueFrom: unknown }) => [Name, ValueFrom]),
    );
    expect(secrets).toEqual({
      THETIS_RPC_URL: secretImport("solana-rpc-url"),
      SUPABASE_SERVICE_ROLE_KEY: secretImport("supabase-service-role"),
    });
  });

  it("alarms on IndexerHalted log lines for the indexing instance", () => {
    const ops = template("ops");
    const topic = { Ref: ops.getResourceId("AWS::SNS::Topic") };
    const filters = Object.values(templates).flatMap((item) =>
      Object.values(item.findResources("AWS::Logs::MetricFilter")),
    );
    expect(filters).toHaveLength(1);
    expect(filters[0]?.Properties).toMatchObject({
      FilterPattern: '{ $.code = "INDEXER_HALTED" }',
      MetricTransformations: [
        { MetricName: "IndexerHalted", MetricNamespace: `Thetis/${instance}`, MetricValue: "1" },
      ],
    });
    ops.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: `Thetis/${instance}`,
      MetricName: "IndexerHalted",
      Statistic: "Sum",
      Period: 300,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: [topic],
    });
  });

  it("runs the devnet-token-simulation worker as the health loop only, with no indexer alarm", { timeout: 30_000 }, () => {
    const { stacks: simulation } = synth({ ...valid, instance: "devnet-token-simulation" });
    const worker = Template.fromStack(simulation.worker);
    const [task] = Object.values(worker.findResources("AWS::ECS::TaskDefinition"));
    const [container] = task?.Properties.ContainerDefinitions ?? [];
    expect(container?.Environment ?? []).toEqual([]);
    expect(container?.Secrets ?? []).toEqual([]);
    expect(
      policyStatements(worker).filter(({ statement }) =>
        actions(statement).some((action) => action.startsWith("secretsmanager:")),
      ),
    ).toEqual([]);
    const ops = Template.fromStack(simulation.ops);
    ops.resourceCountIs("AWS::CloudWatch::Alarm", 3);
    for (const stack of Object.values(simulation)) {
      Template.fromStack(stack).resourceCountIs("AWS::Logs::MetricFilter", 0);
    }
  });

  it("sets an 80% actual and 100% forecast monthly cost budget in us-east-1", () => {
    expect(stacks.budget?.region).toBe("us-east-1");
    template("budget").hasResourceProperties("AWS::Budgets::Budget", {
      Budget: { BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: 25, Unit: "USD" } },
      NotificationsWithSubscribers: ["ACTUAL", "FORECASTED"].map((type, index) => ({
        Notification: {
          NotificationType: type,
          ComparisonOperator: "GREATER_THAN",
          ThresholdType: "PERCENTAGE",
          Threshold: index === 0 ? 80 : 100,
        },
        Subscribers: [{ Address: valid.alertEmail, SubscriptionType: "EMAIL" }],
      })),
    });
  });

  it("filters monthly budget spend by the settlement instance cost-allocation tag", () => {
    template("budget").hasResourceProperties("AWS::Budgets::Budget", {
      Budget: { CostFilters: { TagKeyValue: [`user:instance$${instance}`] } },
    });
  });

  it("imports GitHub OIDC by default and scopes release to the bootstrap roles", () => {
    const release = template("release");
    release.resourceCountIs("AWS::IAM::OIDCProvider", 0);
    const expected = ["af-south-1", "us-east-1"].flatMap((region) =>
      ["deploy", "file-publishing", "image-publishing", "lookup"].map((role) => ({
        "Fn::Join": [
          "",
          [
            "arn:",
            { Ref: "AWS::Partition" },
            `:iam::${valid.account}:role/cdk-hnb659fds-${role}-role-${valid.account}-${region}`,
          ],
        ],
      })),
    );
    expect(policyStatements(release)).toEqual([
      {
        roles: [{ Ref: release.getResourceId("AWS::IAM::Role") }],
        statement: { Action: "sts:AssumeRole", Effect: "Allow", Resource: expected },
      },
    ]);
  });

  it("creates GitHub OIDC when requested", { timeout: 30_000 }, () => {
    const { stacks } = synth({ ...valid, createGithubOidcProvider: "true" });
    Template.fromStack(stacks.release).hasResourceProperties("AWS::IAM::OIDCProvider", {
      Url: `https://${oidcHost}`,
      ClientIdList: ["sts.amazonaws.com"],
    });
  });
});

const judgeContext = {
  ...valid,
  profile: "judge",
  // A fixture key in the publishable format; the hosted key arrives as context at deploy.
  supabaseAnonKey: "sb_publishable_fixture",
};
const webKeys = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "THETIS_SITE_MODE",
  "NODE_ENV",
  "PORT",
  "HOSTNAME",
  "AWS_LWA_PORT",
];

describe("judge profile", () => {
  let staged: string;
  let stacks: Record<string, Stack>;
  let templates: Record<string, Template>;
  let assembly: ReturnType<App["synth"]>;

  beforeAll(() => {
    // A staged tree with the two files the Web stack reads; the real one comes from build:judge.
    staged = mkdtempSync(join(tmpdir(), "thetis-web-lambda-"));
    mkdirSync(join(staged, "apps/web"), { recursive: true });
    writeFileSync(join(staged, "apps/web/server.js"), "");
    writeFileSync(join(staged, "Dockerfile"), 'CMD ["node", "apps/web/server.js"]\n');
    ({ assembly, stacks } = synth(judgeContext, staged));
    templates = Object.fromEntries(
      Object.entries(stacks).map(([name, stack]) => [name, Template.fromStack(stack)]),
    );
  }, 60_000);

  afterAll(() => {
    rmSync(staged, { recursive: true, force: true });
  });

  function template(name: string) {
    const result = templates[name];
    if (!result) throw new Error(`Missing stack ${name}`);
    return result;
  }

  function webFunction() {
    const web = template("web");
    const id = web.getResourceId("AWS::Lambda::Function", {
      Properties: { FunctionName: `thetis-${instance}-web` },
    });
    const resource = web.findResources("AWS::Lambda::Function")[id];
    if (!resource) throw new Error("web function missing");
    return { id, properties: resource.Properties };
  }

  it("requires supabaseAnonKey by name, and refuses a key in neither format", { timeout: 30_000 }, () => {
    const context: Record<string, unknown> = { ...judgeContext };
    delete context.supabaseAnonKey;
    expect(() => synth(context, staged)).toThrow("supabaseAnonKey");
    expect(() => synth({ ...judgeContext, supabaseAnonKey: "service_role" }, staged)).toThrow(
      "supabaseAnonKey",
    );
    // A JWT-shaped fixture (three dot-separated parts), not a real key.
    const jwtShaped = ["eyJfixture", "eyJfixture", "fixture"].join(".");
    expect(() => synth({ ...judgeContext, supabaseAnonKey: jwtShaped }, staged)).not.toThrow();
  });

  it("refuses to synthesize the Web stack without the staged web build", { timeout: 30_000 }, () => {
    const empty = mkdtempSync(join(tmpdir(), "thetis-web-empty-"));
    try {
      expect(() => synth(judgeContext, empty)).toThrow("run pnpm --filter @thetis/web build:judge");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("synthesizes exactly Secrets, Worker, Web, Ops, Budget and Release, tagged", () => {
    expect(assembly.stacks.map(({ stackName }) => stackName).sort()).toEqual(
      ["Budget", "Ops", "Release", "Secrets", "Web", "Worker"].map(
        (name) => `Thetis-${instance}-${name}`,
      ),
    );
    for (const stack of assembly.stacks) {
      expect(stack.tags).toMatchObject({ project: "thetis", instance });
    }
  });

  it("has no api or sponsor function, no HTTP API and no sponsor-key secret", () => {
    for (const item of Object.values(templates)) {
      item.resourceCountIs("AWS::ApiGatewayV2::Api", 0);
      for (const { Properties } of Object.values(item.findResources("AWS::Lambda::Function"))) {
        expect(Properties.FunctionName).not.toMatch(/^thetis-.*-(api|sponsor)$/);
      }
    }
    const secrets = template("secrets");
    secrets.resourceCountIs("AWS::SecretsManager::Secret", 2);
    for (const name of ["supabase-service-role", "solana-rpc-url"]) {
      secrets.hasResource("AWS::SecretsManager::Secret", {
        DeletionPolicy: "Retain",
        Properties: { Name: `thetis/${instance}/${name}`, SecretString: Match.absent() },
      });
    }
  });

  it("grants secret reads to the worker task execution role only, on its two secrets", () => {
    const [task] = Object.values(template("worker").findResources("AWS::ECS::TaskDefinition"));
    const executionRole = task?.Properties.ExecutionRoleArn["Fn::GetAtt"][0];
    const grants = Object.entries(templates).flatMap(([name, item]) =>
      policyStatements(item)
        .filter(({ statement }) =>
          actions(statement).some((action) => /^(secretsmanager:|\*)/i.test(action)),
        )
        .map((grant) => ({ name, ...grant })),
    );
    for (const { name, roles, statement } of grants) {
      expect(name).toBe("worker");
      expect(roles).toEqual([{ Ref: executionRole }]);
      expect(statement.Effect).toBe("Allow");
    }
    const resources = new Set(
      grants
        .filter(({ statement }) => actions(statement).includes("secretsmanager:GetSecretValue"))
        .flatMap(({ statement }) => [statement.Resource].flat().map((item) => JSON.stringify(item))),
    );
    expect(resources.size).toBe(2);
    const webRole = webFunction().properties.Role["Fn::GetAtt"][0];
    for (const { roles, statement } of policyStatements(template("web"))) {
      if (JSON.stringify(roles).includes(webRole)) {
        for (const action of actions(statement)) expect(action).toMatch(/^logs:/);
      }
    }
  });

  it("restricts IAM actions and wildcard resources to documented AWS requirements", () => {
    const wildcardActions = new Set(["ecr:GetAuthorizationToken"]);
    for (const item of Object.values(templates)) {
      for (const statement of findAllStatements(item.toJSON().Resources)) {
        expect(statement.NotAction).toBeUndefined();
        expect(statement.NotResource).toBeUndefined();
        for (const action of actions(statement)) {
          expect(action).not.toMatch(/\*/);
          if ([statement.Resource].flat().includes("*")) {
            expect(wildcardActions.has(action), action).toBe(true);
          }
        }
      }
      for (const { Properties } of Object.values(item.findResources("AWS::IAM::Role"))) {
        expect(Properties.ManagedPolicyArns).toBeUndefined();
      }
    }
  });

  it("gives the web function exactly its seven public variables and no secret", () => {
    const { properties } = webFunction();
    const environment: Record<string, unknown> = properties.Environment.Variables;
    expect(Object.keys(environment).sort()).toEqual([...webKeys].sort());
    expect(environment).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: valid.supabaseUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: judgeContext.supabaseAnonKey,
      THETIS_SITE_MODE: "judge",
      NODE_ENV: "production",
      PORT: "8080",
      HOSTNAME: "0.0.0.0",
      AWS_LWA_PORT: "8080",
    });
    for (const value of Object.values(environment)) {
      expect(typeof value).toBe("string");
      expect(value).not.toMatch(/service_role|secretsmanager|resolve:/i);
    }
  });

  it("runs the web function as an ARM64 1024 MB image with a 15 second timeout", () => {
    const { properties } = webFunction();
    expect(properties).toMatchObject({
      PackageType: "Image",
      Architectures: ["arm64"],
      MemorySize: 1024,
      Timeout: 15,
    });
    const manifest: { dockerImages: Record<string, { source: { platform?: string } }> } =
      JSON.parse(readFileSync(`${assembly.directory}/${stacks.web?.artifactId}.assets.json`, "utf8"));
    expect(Object.values(manifest.dockerImages)).toEqual([
      expect.objectContaining({ source: expect.objectContaining({ platform: "linux/arm64" }) }),
    ]);
  });

  it("opens only the web function URL to the public, buffered, behind CloudFront GET and HEAD over HTTPS", () => {
    const urls = Object.entries(templates).flatMap(([name, item]) =>
      Object.values(item.findResources("AWS::Lambda::Url")).map(({ Properties }) => ({
        name,
        Properties,
      })),
    );
    expect(urls).toEqual([
      {
        name: "web",
        Properties: {
          AuthType: "NONE",
          InvokeMode: "BUFFERED",
          TargetFunctionArn: { "Fn::GetAtt": [webFunction().id, "Arn"] },
        },
      },
    ]);
    const web = template("web");
    web.resourceCountIs("AWS::CloudFront::Distribution", 1);
    web.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        PriceClass: "PriceClass_100",
        DefaultCacheBehavior: {
          ViewerProtocolPolicy: "redirect-to-https",
          AllowedMethods: ["GET", "HEAD"],
        },
        CustomErrorResponses: [{ ErrorCode: 503, ErrorCachingMinTTL: 0 }],
      },
    });
    web.hasResourceProperties("AWS::CloudFront::CachePolicy", {
      CachePolicyConfig: {
        MinTTL: 30,
        DefaultTTL: 30,
        MaxTTL: 60,
        ParametersInCacheKeyAndForwardedToOrigin: {
          CookiesConfig: { CookieBehavior: "none" },
          HeadersConfig: { HeaderBehavior: "none" },
          QueryStringsConfig: { QueryStringBehavior: "none" },
        },
      },
    });
    // Cross-stack exports for the Ops alarm aside, the stack outputs the two URLs.
    const outputs = Object.entries(web.findOutputs("*")).filter(([, output]) => !output.Export);
    expect(outputs.map(([name]) => name).sort()).toEqual(["FunctionUrl", "JudgeUrl"]);
    expect(JSON.stringify(web.findOutputs("JudgeUrl"))).toContain("/run");
  });

  it("retains every log group, the web one included, for 90 days", () => {
    template("web").hasResource("AWS::Logs::LogGroup", {
      Properties: { LogGroupName: `/aws/lambda/thetis-${instance}-web` },
    });
    for (const item of Object.values(templates)) {
      for (const group of Object.values(item.findResources("AWS::Logs::LogGroup"))) {
        expect(group).toMatchObject({
          DeletionPolicy: "Retain",
          UpdateReplacePolicy: "Retain",
          Properties: { RetentionInDays: 90 },
        });
      }
    }
  });

  it("alarms on worker running tasks, the indexer halting and web 5xx responses", () => {
    const ops = template("ops");
    const topic = { Ref: ops.getResourceId("AWS::SNS::Topic") };
    ops.resourceCountIs("AWS::CloudWatch::Alarm", 3);
    const names = Object.values(ops.findResources("AWS::CloudWatch::Alarm"))
      .map(({ Properties }) => Properties.MetricName)
      .sort();
    expect(names).toEqual(["5xxErrorRate", "IndexerHalted", "RunningTaskCount"]);
    ops.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/CloudFront",
      MetricName: "5xxErrorRate",
      AlarmActions: [topic],
    });
  });

  it("keeps the release role's main-branch trust", () => {
    template("release").hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Condition: {
              StringEquals: {
                [`${oidcHost}:aud`]: "sts.amazonaws.com",
                [`${oidcHost}:sub`]: "repo:Katlego-tech/Thetis:ref:refs/heads/main",
              },
            },
          }),
        ],
      },
    });
    template("release").resourceCountIs("AWS::IAM::OIDCProvider", 0);
  });
});
