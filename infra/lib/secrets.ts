import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

interface SecretsStackProps extends StackProps {
  instance: string;
  /** False in the judge profile, which deploys no sponsor. */
  includeSponsorKey: boolean;
}

export class SecretsStack extends Stack {
  readonly sponsorKey: Secret | undefined;
  readonly supabaseServiceRole: Secret;
  readonly solanaRpcUrl: Secret;

  constructor(scope: Construct, id: string, props: SecretsStackProps) {
    super(scope, id, props);

    // Secrets Manager generates an initial string. Set the actual sponsor key out of band.
    this.sponsorKey = props.includeSponsorKey
      ? this.createSecret(props.instance, "sponsor-key")
      : undefined;
    this.supabaseServiceRole = this.createSecret(props.instance, "supabase-service-role");
    this.solanaRpcUrl = this.createSecret(props.instance, "solana-rpc-url");
  }

  private createSecret(instance: string, name: string) {
    return new Secret(this, name, {
      secretName: `thetis/${instance}/${name}`,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
