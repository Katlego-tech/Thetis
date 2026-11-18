import { readFileSync } from "node:fs";
import { App, type Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { createStacks } from "../lib/app.ts";

const instance = "fiat-attestation-test";
const valid = {
  account: "111111111111",
  region: "af-south-1",
  instance,
  githubRepo: "Katlego-tech/Thetis",
  budgetMonthlyUsd: "25",
  alertEmail: "alerts@example.invalid",
};
const oidcHost = "token.actions.githubusercontent.com";

function synth(context: Record<string, unknown>) {
  const app = new App({ context, autoSynth: false });
  const stacks = createStacks(app);
  return { assembly: app.synth(), stacks };
}

const invalidValues = {
  account: "123",
  region: "xx-fake-9",
  instance: "test",
  githubRepo: "another/repo",
  budgetMonthlyUsd: "0",
  alertEmail: "invalid",
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
  });

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

  it("grants sponsor-key access exclusively to the sponsor role", () => {
    const secrets = template("secrets");
    const secretId = secrets.getResourceId("AWS::SecretsManager::Secret", {
      Properties: { Name: Match.stringLikeRegexp("/sponsor-key$") },
    });
    const exports = secrets.findOutputs("*", { Value: { Ref: secretId } });
    const [secret] = Object.values(exports);
    expect(secret?.Export.Name).toEqual(expect.any(String));
    const secretArn = { "Fn::ImportValue": secret?.Export.Name };

    const grants = Object.values(templates)
      .flatMap(policyStatements)
      .filter(({ statement }) =>
        actions(statement).some((action) => /^(secretsmanager:|\*)/i.test(action)),
      );
    expect(grants).toEqual([
      {
        roles: [{ Ref: roleId("sponsor") }],
        statement: {
          Action: "secretsmanager:GetSecretValue",
          Effect: "Allow",
          Resource: secretArn,
        },
      },
    ]);
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

  it("pins GitHub release trust to repository tags and the STS audience", () => {
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
              StringEquals: { [`${oidcHost}:aud`]: "sts.amazonaws.com" },
              StringLike: { [`${oidcHost}:sub`]: "repo:Katlego-tech/Thetis:ref:refs/tags/v*" },
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
    expect(dockerfile).toContain('CMD ["node", "src/main.ts"]');
  });

  it("notifies the operations topic for Lambda failures and a missing worker", () => {
    const ops = template("ops");
    const topic = { Ref: ops.getResourceId("AWS::SNS::Topic") };
    ops.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: valid.alertEmail,
      TopicArn: topic,
    });
    ops.resourceCountIs("AWS::CloudWatch::Alarm", 3);
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

  it("creates GitHub OIDC when requested", () => {
    const { stacks } = synth({ ...valid, createGithubOidcProvider: "true" });
    Template.fromStack(stacks.release).hasResourceProperties("AWS::IAM::OIDCProvider", {
      Url: `https://${oidcHost}`,
      ClientIdList: ["sts.amazonaws.com"],
    });
  });
});
