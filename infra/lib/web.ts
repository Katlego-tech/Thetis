import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  AllowedMethods,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  Distribution,
  PriceClass,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { FunctionUrlOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  DockerImageCode,
  DockerImageFunction,
  FunctionUrl,
  FunctionUrlAuthType,
  InvokeMode,
} from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

/** The staged Next standalone tree and its Dockerfile, written by the web judge build. */
export const WEB_LAMBDA_DIRECTORY = fileURLToPath(new URL("../../apps/web/.lambda", import.meta.url));

interface WebStackProps extends StackProps {
  instance: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  lambdaDirectory?: string;
}

export class WebStack extends Stack {
  readonly function: DockerImageFunction;
  readonly functionUrl: FunctionUrl;
  readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const directory = props.lambdaDirectory ?? WEB_LAMBDA_DIRECTORY;
    // The image holds the staged standalone server, so a direct cdk call cannot run without a build.
    if (!existsSync(join(directory, "apps/web/server.js"))) {
      throw new Error("run pnpm --filter @thetis/web build:judge");
    }

    const functionName = `thetis-${props.instance}-web`;
    const logGroup = new LogGroup(this, "web-logs", {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const role = new Role(this, "web-role", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });
    logGroup.grantWrite(role);

    this.function = new DockerImageFunction(this, "web", {
      functionName,
      code: DockerImageCode.fromImageAsset(directory, { platform: Platform.LINUX_ARM64 }),
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.seconds(15),
      role,
      logGroup,
      environment: {
        NEXT_PUBLIC_SUPABASE_URL: props.supabaseUrl,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: props.supabaseAnonKey,
        THETIS_SITE_MODE: "judge",
        NODE_ENV: "production",
        PORT: "8080",
        HOSTNAME: "0.0.0.0",
        AWS_LWA_PORT: "8080",
      },
    });

    this.functionUrl = new FunctionUrl(this, "web-url", {
      function: this.function,
      authType: FunctionUrlAuthType.NONE,
      invokeMode: InvokeMode.BUFFERED,
    });

    const cachePolicy = new CachePolicy(this, "web-cache", {
      minTtl: Duration.seconds(30),
      defaultTtl: Duration.seconds(30),
      maxTtl: Duration.seconds(60),
      cookieBehavior: CacheCookieBehavior.none(),
      headerBehavior: CacheHeaderBehavior.none(),
      queryStringBehavior: CacheQueryStringBehavior.none(),
    });
    this.distribution = new Distribution(this, "web-cdn", {
      defaultBehavior: {
        origin: new FunctionUrlOrigin(this.functionUrl),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy,
      },
      errorResponses: [{ httpStatus: 503, ttl: Duration.seconds(0) }],
      priceClass: PriceClass.PRICE_CLASS_100,
    });

    new CfnOutput(this, "JudgeUrl", {
      value: `https://${this.distribution.distributionDomainName}/run`,
    });
    new CfnOutput(this, "FunctionUrl", { value: this.functionUrl.url });
  }
}
