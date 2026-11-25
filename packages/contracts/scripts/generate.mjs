import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";
import { createFromRoot } from "codama";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const idl = JSON.parse(readFileSync(resolve(packageDir, "idl/thetis.json"), "utf8"));
const outDir = resolve(process.argv[2] ?? resolve(packageDir, "src/generated"));

const codama = createFromRoot(rootNodeFromAnchor(idl));
await codama.accept(
  renderVisitor(outDir, {
    deleteFolderBeforeRendering: true,
    formatCode: false,
    generatedFolder: ".",
    syncPackageJson: false,
    importExtension: "ts",
    erasableSyntax: true,
  }),
);

// The renderer's builders pass `programAddress` through as `X | undefined`, which TypeScript
// rejects under exactOptionalPropertyTypes (the repository default). Consumers compile this
// package's TypeScript with their own settings, so widen the builders' option type to accept it.
const OPTION =
  "config?: { programAddress?: TProgramAddress | { readonly address: TProgramAddress } }";
const WIDENED =
  "config?: { programAddress?: TProgramAddress | { readonly address: TProgramAddress } | undefined }";
const instructionsDir = join(outDir, "instructions");
let widened = 0;
for (const name of readdirSync(instructionsDir)) {
  if (name === "index.ts") continue;
  const file = join(instructionsDir, name);
  const source = readFileSync(file, "utf8");
  const count = source.split(OPTION).length - 1;
  if (count === 0) throw new Error(`${name}: expected the builder config type to rewrite`);
  writeFileSync(file, source.replaceAll(OPTION, WIDENED));
  widened += count;
}
if (widened === 0) throw new Error("no builder config types were rewritten");
