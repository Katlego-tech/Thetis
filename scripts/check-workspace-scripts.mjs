import { globSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const workspaceFile = "pnpm-workspace.yaml";
const requiredScripts = ["lint", "typecheck", "test"];

function readPackageGlobs() {
  const lines = readFileSync(workspaceFile, "utf8").split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (start === -1 || !/^packages\s*:\s*(?:#.*)?$/.test(lines[start])) {
    throw new Error(`${workspaceFile}: expected a packages block list of dir/* globs`);
  }

  const globs = [];
  for (const [index, line] of lines.slice(start + 1).entries()) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    if (/^[^\s-]/.test(line)) break;

    const entry = line.match(/^\s*-\s+(["']?)([\w.-]+)\/\*\1(?:\s+#.*)?\s*$/);
    if (!entry || entry[2] === "." || entry[2] === "..") {
      throw new Error(
        `${workspaceFile}:${start + index + 2}: expected a dir/* package glob, got ${line.trim()}`,
      );
    }
    globs.push(`${entry[2]}/*/package.json`);
  }
  return globs;
}

function checkWorkspaceScripts() {
  const manifests = new Set(readPackageGlobs().flatMap((pattern) => globSync(pattern)));
  if (manifests.size === 0) {
    throw new Error(`${workspaceFile}: no workspace packages found`);
  }

  for (const manifest of [...manifests].sort()) {
    const { scripts } = JSON.parse(readFileSync(manifest, "utf8"));
    for (const name of requiredScripts) {
      if (typeof scripts?.[name] !== "string" || !scripts[name].trim()) {
        console.error(`${dirname(manifest)}: missing ${name}`);
        process.exitCode = 1;
      }
    }
  }

  if (!process.exitCode) {
    console.log(`workspace scripts: ${manifests.size} package(s) ok`);
  }
}

try {
  checkWorkspaceScripts();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
