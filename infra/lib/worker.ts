import { fileURLToPath } from "node:url";
import { Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
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
} from "aws-cdk-lib/aws-ecs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

interface WorkerStackProps extends StackProps {
  instance: string;
}

export class WorkerStack extends Stack {
  readonly cluster: Cluster;
  readonly service: FargateService;

  override get availabilityZones(): string[] {
    // Resolve AZs in the target account at deployment without a CDK context lookup.
    const azs = Fn.getAzs(this.region);
    return [Fn.select(0, azs), Fn.select(1, azs)];
  }

  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);

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
    });

    this.service = new FargateService(this, "Service", {
      serviceName: "worker",
      cluster: this.cluster as ICluster,
      taskDefinition: task,
      desiredCount: 1,
      assignPublicIp: true,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
    });
  }
}
