import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { FilterPattern, MetricFilter } from "aws-cdk-lib/aws-logs";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import type { ApiStack } from "./api.ts";
import type { WorkerStack } from "./worker.ts";

interface OpsStackProps extends StackProps {
  instance: string;
  alertEmail: string;
  api: ApiStack;
  worker: WorkerStack;
}

export class OpsStack extends Stack {
  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props);

    const topic = new Topic(this, "Alerts");
    topic.addSubscription(new EmailSubscription(props.alertEmail));

    for (const service of ["api", "sponsor"] as const) {
      const alarm = new Alarm(this, `${service}-errors`, {
        metric: props.api[service].metricErrors({ period: Duration.minutes(5), statistic: "Sum" }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(new SnsAction(topic));
    }

    const workerAlarm = new Alarm(this, "worker-running-tasks", {
      metric: new Metric({
        namespace: "ECS/ContainerInsights",
        metricName: "RunningTaskCount",
        dimensionsMap: {
          ClusterName: props.worker.cluster.clusterName,
          ServiceName: props.worker.service.serviceName,
        },
        period: Duration.minutes(1),
        statistic: "Minimum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.BREACHING,
    });
    workerAlarm.addAlarmAction(new SnsAction(topic));

    if (props.worker.indexes) {
      // The indexer logs INDEXER_HALTED when it stops on something it does not recognise.
      const halted = new MetricFilter(this, "indexer-halted-filter", {
        logGroup: props.worker.logGroup,
        filterPattern: FilterPattern.literal('{ $.code = "INDEXER_HALTED" }'),
        metricNamespace: `Thetis/${props.instance}`,
        metricName: "IndexerHalted",
        metricValue: "1",
      });
      const haltedAlarm = new Alarm(this, "indexer-halted", {
        metric: halted.metric({ period: Duration.minutes(5), statistic: "Sum" }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      haltedAlarm.addAlarmAction(new SnsAction(topic));
    }
  }
}
