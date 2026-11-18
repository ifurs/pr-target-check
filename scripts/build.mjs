// Bundles the CLI into one file with no runtime dependencies.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const result = await build({
  metafile: true,
  entryPoints: ["src/bin.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/cli.mjs",
  define: { __VERSION__: JSON.stringify(version) },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  legalComments: "eof",
});

// dist/licenses.txt: license texts of the bundled packages, as their licenses require.
writeFileSync("build-meta.json", JSON.stringify(result.metafile));
execFileSync(process.execPath, ["scripts/licenses.mjs", "build-meta.json"], { stdio: "inherit" });
