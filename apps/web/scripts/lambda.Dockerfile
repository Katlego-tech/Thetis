# The web app's Lambda image (judge-page.md §10.2), staged into apps/web/.lambda by
# scripts/stage-lambda.mjs, which fills in both image digests at build time. Next's standalone
# server behind the AWS Lambda Web Adapter; the function's environment comes from the CDK stack.
FROM node:24-slim@{{NODE_DIGEST}}
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0@{{ADAPTER_DIGEST}} /lambda-adapter /opt/extensions/lambda-adapter
WORKDIR /app
# The standalone tree, traced from the workspace root: apps/web/server.js, node_modules, packages.
COPY --chown=node:node . .
USER node
CMD ["node", "apps/web/server.js"]
