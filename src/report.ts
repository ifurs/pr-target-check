// Formats results as text (terminal), Markdown (issues, job summaries) or JSON.
import { allowPolicyBody, allowPolicyCommand, type PolicyStatus } from "./policy";
import { allowable } from "./workflow";
import { clean, mdCode, mdText } from "./sanitize";
import type { FileResult, RepoResult } from "./scan";

export const GUIDE_URL = "https://github.com/ifurs/pr-target-check/blob/main/docs/migrate.md";

export function stopsRunning(p: PolicyStatus): boolean {
  return p.kind === "blocked-by-default" || p.kind === "blocked-by-policy" || p.kind === "unknown";
}

const otherBlocked = (p: PolicyStatus): string[] =>
  (p.kind === "allowed" || p.kind === "blocked-by-policy") && p.otherBlocked ? p.otherBlocked : [];

export function needsAction(f: FileResult): boolean {
  return (
    f.policy.kind !== "not-affected" && (stopsRunning(f.policy) || f.analysis.risk === "unsafe" || otherBlocked(f.policy).length > 0)
  );
}

function otherBlockedText(p: PolicyStatus): string {
  const ev = otherBlocked(p);
  if (ev.length === 0) return "";
  const names = ev.map((e) => `\`${e}\``).join(", ");
  return ` But its ${ev.length === 1 ? "trigger" : "triggers"} ${names} ${ev.length === 1 ? "isn't" : "aren't"} in the policy's allowed_events, so the workflow won't run on ${ev.length === 1 ? "it" : "them"}. Add ${ev.length === 1 ? "it" : "them"} to the policy.`;
}

export function statusLine(p: PolicyStatus): string {
  switch (p.kind) {
    case "allowed":
      return `Keeps running: allowed by ${list(p.policies)}.${otherBlockedText(p)}`;
    case "blocked-by-policy":
      return `Blocked now: ${list(p.policies)} doesn't allow pull_request_target.${otherBlockedText(p)}`;
    case "blocked-by-default":
      return "Stops running on December 2: no Actions event policy allows pull_request_target for this file.";
    case "not-affected":
      return `Not affected (${p.reason}).`;
    case "unknown":
      return `Stops running on December 2${p.isPublic ? "" : " if the repository is public"}, unless an event policy allows it (couldn't check: ${p.reason}).`;
  }
}

const RISK_TEXT = {
  unsafe: "Likely unsafe: it looks like it can run code from a pull request with this repository's token or secrets.",
  review: "Check it: it touches pull request code or calls code this tool can't see.",
  safe: "Looks safe: it doesn't check out or run pull request code.",
} as const;

export function fixLines(f: FileResult, slug: string | undefined): string[] {
  const a = f.analysis;
  const out: string[] = [];
  const hasDefaultPerms = a.findings.some((x) => x.code === "default-permissions");
  if (a.risk === "unsafe") out.push("Don't allow this file as it is.");
  if (a.fix === "switch" || a.fix === "switch-or-allow") {
    out.push(
      "Change `pull_request_target` to `pull_request`. It uses no secrets and asks for no write access, so fork PRs can run it with a read-only token. One difference: depending on your fork-PR approval setting, runs for outside contributors may wait for a maintainer to approve them.",
    );
  } else {
    out.push(
      `Split it into two workflows: \`pull_request\` does the untrusted part with no secrets, then a \`workflow_run\` workflow does the privileged part (comments, labels, secrets) without running PR code. Guide: ${GUIDE_URL}`,
    );
    if (hasDefaultPerms) {
      out.push("If it only needs read access, add `permissions: contents: read` and switch to `pull_request` instead.");
    }
  }
  if (allowable(a.fix) && f.policy.kind !== "allowed") {
    out.push("Or keep it as it is and allow only this file:");
    out.push(`  ${allowPolicyCommand(slug ?? "OWNER/REPO", a.path, a.triggers)}`);
  }
  if (a.risk === "unsafe" && f.policy.kind === "allowed") {
    out.push("A policy allows this file, so it keeps running, and it stays exploitable. Fix it or remove it from that policy.");
  }
  return out;
}

const MAX_FINDINGS = 4;

const list = (xs: string[]) => xs.map((x) => `"${x}"`).join(", ");

// ---------- text ----------

export interface Style {
  bold(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  green(s: string): string;
  dim(s: string): string;
}

export const plain: Style = { bold: (s) => s, red: (s) => s, yellow: (s) => s, green: (s) => s, dim: (s) => s };
export const ansi: Style = {
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  red: (s) => `\x1b[31m${s}\x1b[39m`,
  yellow: (s) => `\x1b[33m${s}\x1b[39m`,
  green: (s) => `\x1b[32m${s}\x1b[39m`,
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
};

export function renderText(results: RepoResult[], s: Style = plain, verbose = false): string {
  const out: string[] = [];
  for (const r of results) {
    if (r.error) {
      out.push(`${s.bold(clean(r.name))}  ${s.red(`error: ${clean(r.error)}`)}`, "");
      continue;
    }
    if (r.files.length === 0) {
      if (verbose || results.length === 1) out.push(`${s.bold(clean(r.name))}  ${s.green("✓")} no pull_request_target workflows (${r.scanned} scanned)`, "");
      continue;
    }
    out.push(`${s.bold(clean(r.name))}${r.visibility ? s.dim(`  (${clean(r.visibility)})`) : ""}`);
    if (r.note) out.push(s.dim(`  ${clean(r.note)}`));
    for (const f of r.files) {
      const a = f.analysis;
      const mark = needsAction(f) ? s.red("✗") : f.policy.kind === "not-affected" ? s.dim("–") : s.green("✓");
      out.push(`  ${mark} ${s.bold(clean(a.path))}`);
      const st = statusLine(f.policy);
      out.push(`      ${stopsRunning(f.policy) ? s.yellow(st) : st}`);
      if (a.error) out.push(`      ${s.yellow(a.error)}`);
      const riskText = RISK_TEXT[a.risk];
      out.push(`      ${a.risk === "unsafe" ? s.red(riskText) : a.risk === "review" ? s.yellow(riskText) : riskText}`);
      const shown = a.findings.filter((x) => x.severity !== "info" || verbose);
      const limit = verbose ? Infinity : MAX_FINDINGS;
      for (const fd of shown.slice(0, limit)) {
        const where = fd.line ? s.dim(`line ${fd.line}: `) : "";
        out.push(`        - ${where}${fd.message}`);
      }
      if (shown.length > limit) out.push(s.dim(`        … and ${shown.length - limit} more like these (--verbose shows all)`));
      const info = a.findings.filter((x) => x.severity === "info");
      if (info.length && !verbose) out.push(s.dim(`        ${info.map((x) => x.message).join(" ")}`));
      if (showFix(f)) {
        out.push(`      ${s.bold("Fix:")}`);
        for (const l of fixLines(f, r.slug)) out.push(`        ${l}`);
      }
    }
    out.push("");
  }
  out.push(summary(results, s));
  return out.join("\n");
}

export function summary(results: RepoResult[], s: Style = plain): string {
  const files = results.flatMap((r) => r.files);
  const stop = files.filter((f) => stopsRunning(f.policy)).length;
  const unsafe = files.filter((f) => f.analysis.risk === "unsafe" && f.policy.kind !== "not-affected").length;
  const errors = results.filter((r) => r.error).length;
  const repos = results.length === 1 ? "1 repository" : `${results.length} repositories`;
  if (files.length === 0 && errors === 0) return s.green(`✓ No pull_request_target workflows in ${repos}. Nothing to do.`);
  const parts = [`${files.length} pull_request_target workflow${files.length === 1 ? "" : "s"} in ${repos}`];
  parts.push(stop ? s.yellow(`${stop} stop${stop === 1 ? "s" : ""} running on December 2`) : s.green("none stop running"));
  if (unsafe) parts.push(s.red(`${unsafe} unsafe`));
  if (errors) parts.push(s.red(`${errors} couldn't be scanned`));
  return parts.join(", ") + ".";
}

// ---------- markdown ----------

export function renderMarkdown(results: RepoResult[]): string {
  const out: string[] = ["## pull_request_target check", "", summary(results), ""];
  for (const r of results) {
    if (r.error) {
      out.push(`### ${mdText(r.name)}`, "", `Couldn't scan: ${mdText(r.error)}`, "");
      continue;
    }
    if (r.files.length === 0) continue;
    out.push(`### ${mdText(r.name)}${r.visibility ? ` (${mdText(r.visibility)})` : ""}`, "");
    for (const f of r.files) {
      const a = f.analysis;
      out.push(`#### ${needsAction(f) ? "❌" : "✅"} ${mdCode(a.path)}`, "");
      out.push(`- ${statusLine(f.policy)}`);
      out.push(`- ${RISK_TEXT[a.risk]}`);
      if (a.error) out.push(`- ${mdText(a.error)}`);
      for (const fd of a.findings) out.push(`  - ${fd.line ? `line ${fd.line}: ` : ""}${mdText(fd.message)}`);
      if (showFix(f)) {
        out.push("", "**Fix**", "");
        for (const l of fixLines(f, r.slug)) {
          // The command holds a file name from the scanned repo: pick a fence it can't close.
          const fence = "`".repeat(Math.max(3, ...[...l.matchAll(/`+/g)].map((m) => m[0].length + 1)));
          out.push(l.startsWith("  ") ? `${fence}sh\n${clean(l.trim(), 2000)}\n${fence}` : `- ${l}`);
        }
      }
      out.push("");
    }
  }
  return out.join("\n");
}

// ---------- json ----------

export function renderJson(results: RepoResult[]): string {
  return JSON.stringify(
    {
      results: results.map((r) => ({
        ...r,
        files: r.files.map((f) => ({
          ...f,
          stopsRunning: stopsRunning(f.policy),
          needsAction: needsAction(f),
          allowPolicy: allowable(f.analysis.fix) ? allowPolicyBody(f.analysis.path, f.analysis.triggers) : undefined,
        })),
      })),
    },
    null,
    2,
  );
}

/** Fix advice is noise for files that are fine, or already allowed and safe. */
function showFix(f: FileResult): boolean {
  const a = f.analysis;
  if (f.policy.kind === "not-affected") return false;
  if (f.policy.kind === "allowed" && a.risk === "safe") return false;
  return needsAction(f) || a.risk !== "safe";
}
