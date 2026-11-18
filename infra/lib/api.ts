import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { ArnPrincipal, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

interface ApiStackProps extends StackProps {
  instance: string;
  sponsorKeyArn: string;
}

export class ApiStack extends Stack {
  readonly api: NodejsFunction;
  readonly sponsor: NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    this.api = this.createFunction(props.instance, "api");
    this.sponsor = this.createFunction(props.instance, "sponsor", 2);
    this.sponsor.addToRolePolicy(
      new PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [props.sponsorKeyArn],
      }),
    );
    const apiRole = this.api.role;
    if (!apiRole) throw new Error("API Lambda requires an execution role");

    this.sponsor.addPermission("InvokeFromApiRole", {
      principal: new ArnPrincipal(apiRole.roleArn),
      action: "lambda:InvokeFunction",
    });

    const http = new HttpApi(this, "HttpApi");
    http.addRoutes({
      path: "/health",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("ApiHealth", this.api),
    });
  }

  private createFunction(instance: string, service: "api" | "sponsor", concurrency?: number) {
    const functionName = `thetis-${instance}-${service}`;
    const logGroup = new LogGroup(this, `${service}-logs`, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const role = new Role(this, `${service}-role`, {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });
    logGroup.grantWrite(role);

    return new NodejsFunction(this, service, {
      functionName,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      entry: fileURLToPath(new URL(`../../services/${service}/src/main.ts`, import.meta.url)),
      depsLockFilePath: fileURLToPath(new URL("../../pnpm-lock.yaml", import.meta.url)),
      handler: "handler",
      role,
      logGroup,
      ...(concurrency === undefined ? {} : { reservedConcurrentExecutions: concurrency }),
      bundling: {
        forceDockerBundling: false,
        // CDK runs pnpm from the lockfile directory, while esbuild is installed in infra.
        environment: {
          PATH: [fileURLToPath(new URL("../node_modules/.bin", import.meta.url)), process.env.PATH]
            .filter(Boolean)
            .join(delimiter),
        },
      },
    });
  }
}
