import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { type IVpc, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import {
  Cluster,
  ContainerImage,
  ContainerInsights,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  type ICluster,
  LogDrivers,
  OperatingSystemFamily,
  Secret as EcsSecret,
} from "aws-cdk-lib/aws-ecs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

interface WorkerStackProps extends StackProps {
  instance: string;
  availabilityZones: string[];
  supabaseUrl: string;
  /** The judged instance's protocol address (context thetisProtocol). */
  thetisProtocol: string;
  /** The program deploy signature, the oldest entry the indexer lists (thetisFirstSignature). */
  thetisFirstSignature: string;
  supabaseServiceRole: Secret;
  solanaRpcUrl: Secret;
}

// The one CDK instance whose worker indexes the program: on-chain instance "fiat-attestation".
const INDEXING_INSTANCE = "fiat-attestation-test";
const THETIS_PROGRAM_ID = "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3";

export class WorkerStack extends Stack {
  readonly cluster: Cluster;
  readonly service: FargateService;
  readonly logGroup: LogGroup;
  /** True when this worker runs the indexer; the other instance runs the health loop only. */
  readonly indexes: boolean;
  private readonly workerAvailabilityZones: string[];

  override get availabilityZones(): string[] {
    // CDK's VPC reads the stack's AZs even when the VPC receives an explicit list.
    return this.workerAvailabilityZones;
  }

  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);
    this.workerAvailabilityZones = props.availabilityZones;
    this.indexes = props.instance === INDEXING_INSTANCE;

    // The image holds the bundled worker, so a direct cdk call cannot stage it without a build.
    const bundle = fileURLToPath(new URL("../../services/worker/dist/main.js", import.meta.url));
    if (!existsSync(bundle)) throw new Error("run pnpm --filter @thetis/worker build");

    const vpc = new Vpc(this, "Vpc", {
      natGateways: 0,
      subnetConfiguration: [{ name: "Public", subnetType: SubnetType.PUBLIC }],
    });

    const clusterName = `thetis-${props.instance}-worker`;
    const insightsLogs = new LogGroup(this, "ContainerInsightsLogs", {
      logGroupName: `/aws/ecs/containerinsights/${clusterName}/performance`,
      retention: RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.cluster = new Cluster(this, "Cluster", {
      clusterName,
      // CDK concrete types expose undefined for some optional interface properties.
      vpc: vpc as IVpc,
      containerInsightsV2: ContainerInsights.ENABLED,
    });
    this.cluster.node.addDependency(insightsLogs);

    const workerLogs = new LogGroup(this, "WorkerLogs", {
      logGroupName: `/thetis/${props.instance}/worker`,
      retention: RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.logGroup = workerLogs;
    const task = new FargateTaskDefinition(this, "Task", {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.ARM64,
        operatingSystemFamily: OperatingSystemFamily.LINUX,
      },
    });
    task.addContainer("worker", {
      image: ContainerImage.fromAsset(
        fileURLToPath(new URL("../../services/worker", import.meta.url)),
        { platform: Platform.LINUX_ARM64 },
      ),
      logging: LogDrivers.awsLogs({ logGroup: workerLogs, streamPrefix: "worker" }),
      ...(this.indexes
        ? {
            environment: {
              THETIS_INDEXER: "on",
              THETIS_NETWORK: "devnet",
              THETIS_PROGRAM_ID,
              THETIS_PROTOCOL: props.thetisProtocol,
              THETIS_FIRST_SIGNATURE: props.thetisFirstSignature,
              SUPABASE_URL: props.supabaseUrl,
            },
            // CDK concrete types expose undefined for some optional interface properties.
            secrets: {
              THETIS_RPC_URL: EcsSecret.fromSecretsManager(props.solanaRpcUrl as ISecret),
              SUPABASE_SERVICE_ROLE_KEY: EcsSecret.fromSecretsManager(props.supabaseServiceRole as ISecret),
            },
          }
        : {}),
    });

    const vpcSubnets = { subnetType: SubnetType.PUBLIC };
    this.service = new FargateService(this, "Service", {
      serviceName: "worker",
      cluster: this.cluster as ICluster,
      taskDefinition: task,
      desiredCount: 1,
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      vpcSubnets,
    });
    this.service.node.addDependency(vpc.selectSubnets(vpcSubnets).internetConnectivityEstablished);
  }
}
