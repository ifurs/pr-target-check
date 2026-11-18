import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { GitHub, findToken } from "./github";
import { ansi, needsAction, plain, renderJson, renderMarkdown, renderText } from "./report";
import { scanLocal, scanOwner, scanRemote, type RepoResult } from "./scan";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

const HELP = `pr-target-check: find GitHub Actions workflows that stop running when GitHub blocks
pull_request_target in public repositories on December 2, 2026, and get a safe fix for each.

Usage:
  pr-target-check [path]            scan a local checkout (default: current directory)
  pr-target-check owner/repo ...    scan repositories on GitHub (default branch)
  pr-target-check --owner NAME      scan every public repository of an org or user

Options:
  --markdown     print a Markdown report (for an issue or $GITHUB_STEP_SUMMARY)
  --json         print JSON
  --offline      local scan only; don't ask GitHub about visibility or policies
  --verbose      show every finding and repositories with nothing to report
  -h, --help     show this help
  -v, --version  show the version

Token: GH_TOKEN, GITHUB_TOKEN, or \`gh auth token\`. Public repos work without one,
but checking Actions event policies needs admin access to the repository.
Read-only: it never changes anything on GitHub.

Exit code: 0 nothing to do, 1 something stops running or is unsafe, 2 error.`;

export async function main(argv: string[], io = { out: process.stdout, err: process.stderr, env: process.env }): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        owner: { type: "string" },
        org: { type: "string" },
        markdown: { type: "boolean" },
        json: { type: "boolean" },
        offline: { type: "boolean" },
        verbose: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (e) {
    io.err.write(`${(e as Error).message}\n\n${HELP}\n`);
    return 2;
  }
  const { values: o, positionals } = args;
  if (o.help) return io.out.write(HELP + "\n"), 0;
  if (o.version) return io.out.write(VERSION + "\n"), 0;

  const owner = o.owner ?? o.org;
  const gh = o.offline ? undefined : new GitHub(findToken(io.env));
  const results: RepoResult[] = [];
  try {
    if (owner) {
      if (!gh) throw new Error("--owner needs GitHub access; drop --offline.");
      const tty = (io.err as NodeJS.WriteStream).isTTY;
      results.push(...(await scanOwner(gh, owner, tty ? (d, t) => io.err.write(`\rScanning ${d}/${t}…`) : undefined)));
      if (tty) io.err.write("\r\x1b[K");
    }
    const targets = positionals.length || owner ? positionals : ["."];
    for (const t of targets) {
      if (existsSync(t) && statSync(t).isDirectory()) results.push(await scanLocal(resolve(t), gh));
      else if (/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(t)) {
        if (!gh) throw new Error(`${t} is a GitHub repository; drop --offline to scan it.`);
        results.push(await scanRemote(gh, t));
      } else throw new Error(`${t} is neither a directory nor owner/repo.`);
    }
  } catch (e) {
    io.err.write(`pr-target-check: ${(e as Error).message}\n`);
    return 2;
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  if (o.json) io.out.write(renderJson(results) + "\n");
  else if (o.markdown) io.out.write(renderMarkdown(results) + "\n");
  else {
    const color = (io.out as NodeJS.WriteStream).isTTY && !io.env.NO_COLOR;
    io.out.write(renderText(results, color ? ansi : plain, o.verbose) + "\n");
  }
  if (results.some((r) => r.error)) return 2;
  return results.some((r) => r.files.some(needsAction)) ? 1 : 0;
}
