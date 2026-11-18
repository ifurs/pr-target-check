// Writes dist/licenses.txt: the license text of every third-party package bundled into
// dist/cli.mjs, as their licenses (MIT, ISC, Apache-2.0, ...) require.
// Usage: node scripts/licenses.mjs <esbuild metafile>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const meta = JSON.parse(readFileSync(process.argv[2], "utf8"));

// Map each bundled input file to the package directory it belongs to.
const packages = new Set();
for (const input of Object.keys(meta.inputs)) {
  const parts = input.split("/");
  const i = parts.lastIndexOf("node_modules");
  if (i === -1) continue;
  const name = parts[i + 1].startsWith("@") ? `${parts[i + 1]}/${parts[i + 2]}` : parts[i + 1];
  packages.add(parts.slice(0, i + 1).join("/") + "/" + name);
}

const sections = [];
for (const dir of packages) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const file = readdirSync(dir).sort().find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const text = file ? readFileSync(join(dir, file), "utf8").trim() : `License: ${pkg.license ?? "unknown"} (no license file in the package)`;
  sections.push({ key: `${pkg.name}@${pkg.version}`, text: `${pkg.name}@${pkg.version} (${pkg.license ?? "unknown"})\n${"-".repeat(60)}\n${text.replace(/\r\n/g, "\n")}` });
}
// Plain code-point order, so the file is identical on every OS and locale (CI checks dist/).
sections.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

writeFileSync(
  "dist/licenses.txt",
  `Third-party software bundled in dist/cli.mjs\n${"=".repeat(60)}\n\n${sections.map((s) => s.text).join("\n\n\n")}\n`,
);
console.log(`Wrote licenses for ${sections.length} packages`);
