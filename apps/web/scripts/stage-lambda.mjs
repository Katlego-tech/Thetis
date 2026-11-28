// Stages the web app's Lambda image context in apps/web/.lambda (judge-page.md §10.2) after
// `THETIS_WEB_OUTPUT=standalone next build`: the standalone tree, the static assets the standalone
// server does not copy itself, and the Dockerfile with both base images pinned by digest.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const standalone = `${web}.next/standalone`;
const out = `${web}.lambda`;
const IMAGES = {
  NODE_DIGEST: "node:24-slim",
  ADAPTER_DIGEST: "public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0",
};

function fail(message) {
  console.error(`stage-lambda: ${message}`);
  process.exit(1);
}

/**
 * The image index digest of a tag as the registry reports it now, or THETIS_<key> when set (a
 * runner without registry access, or a rebuild of a known image).
 */
function digestOf(key, image) {
  const value =
    process.env[`THETIS_${key}`] ||
    JSON.parse(
      execFileSync(
        "docker",
        ["buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest}}"],
        { encoding: "utf8" },
      ),
    ).digest;
  if (!/^sha256:[0-9a-f]{64}$/.test(value ?? "")) fail(`${image}: no sha256 digest (got ${value})`);
  return value;
}

if (!existsSync(`${standalone}/apps/web/server.js`)) {
  fail("no .next/standalone/apps/web/server.js; run THETIS_WEB_OUTPUT=standalone next build first");
}

rmSync(out, { recursive: true, force: true });
cpSync(standalone, out, { recursive: true, verbatimSymlinks: true });
cpSync(`${web}.next/static`, `${out}/apps/web/.next/static`, { recursive: true });
if (existsSync(`${web}public`))
  cpSync(`${web}public`, `${out}/apps/web/public`, { recursive: true });

let dockerfile = readFileSync(`${web}scripts/lambda.Dockerfile`, "utf8");
for (const [key, image] of Object.entries(IMAGES)) {
  dockerfile = dockerfile.replace(`{{${key}}}`, digestOf(key, image));
}
if (dockerfile.includes("{{")) fail("the Dockerfile template has an unfilled value");
writeFileSync(`${out}/Dockerfile`, dockerfile);
console.log(`stage-lambda: staged ${out}`);
