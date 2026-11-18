import { ArnFormat, Stack, type StackProps } from "aws-cdk-lib";
import { CfnOIDCProvider, FederatedPrincipal, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

const githubIssuer = "token.actions.githubusercontent.com";
const audience = "sts.amazonaws.com";

interface ReleaseStackProps extends StackProps {
  instance: string;
  githubRepo: string;
  createGithubOidcProvider: boolean;
  bootstrapRegions: string[];
}

export class ReleaseStack extends Stack {
  constructor(scope: Construct, id: string, props: ReleaseStackProps) {
    super(scope, id, props);

    const providerArn = props.createGithubOidcProvider
      ? new CfnOIDCProvider(this, "GitHubOidc", {
          url: `https://${githubIssuer}`,
          clientIdList: [audience],
        }).attrArn
      : this.formatArn({
          service: "iam",
          region: "",
          resource: "oidc-provider",
          resourceName: githubIssuer,
          arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
        });

    const release = new Role(this, "GitHubReleaseRole", {
      roleName: `thetis-${props.instance}-release`,
      assumedBy: new FederatedPrincipal(
        providerArn,
        {
          StringEquals: { [`${githubIssuer}:aud`]: audience },
          StringLike: { [`${githubIssuer}:sub`]: `repo:${props.githubRepo}:ref:refs/tags/v*` },
        },
        "sts:AssumeRoleWithWebIdentity",
      ),
    });

    release.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: props.bootstrapRegions.flatMap((region) =>
          ["deploy", "file-publishing", "image-publishing", "lookup"].map((role) =>
            this.formatArn({
              service: "iam",
              region: "",
              resource: "role",
              resourceName: `cdk-hnb659fds-${role}-role-${this.account}-${region}`,
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            }),
          ),
        ),
      }),
    );
  }
}
