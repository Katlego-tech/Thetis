import { Stack, type StackProps } from "aws-cdk-lib";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import type { Construct } from "constructs";

interface BudgetStackProps extends StackProps {
  budgetMonthlyUsd: number;
  alertEmail: string;
}

export class BudgetStack extends Stack {
  constructor(scope: Construct, id: string, props: BudgetStackProps) {
    super(scope, id, props);

    new CfnBudget(this, "MonthlyCost", {
      budget: {
        budgetName: this.stackName,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.budgetMonthlyUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [
        { notificationType: "ACTUAL", threshold: 80 },
        { notificationType: "FORECASTED", threshold: 100 },
      ].map((notification) => ({
        notification: {
          ...notification,
          comparisonOperator: "GREATER_THAN",
          thresholdType: "PERCENTAGE",
        },
        subscribers: [{ address: props.alertEmail, subscriptionType: "EMAIL" }],
      })),
    });
  }
}
