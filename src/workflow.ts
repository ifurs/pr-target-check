// Static analysis of one workflow file. Pure: no network, no file system.
import { LineCounter, parseDocument, type Document } from "yaml";

export type Severity = "high" | "medium" | "info";

export type FindingCode =
  | "runs-pr-code" // PR code is checked out and then executed in a privileged job
  | "may-run-pr-code" // PR code is checked out and a third-party action runs after it
  | "pr-checkout" // PR code is checked out (or fetched) but nothing obvious runs it
  | "unsafe-checkout-flag" // actions/checkout allow-unsafe-pr-checkout: true
  | "script-injection" // untrusted PR text interpolated straight into a script
  | "reusable-workflow" // job calls another workflow we don't follow
  | "uses-secrets" // needs secrets, so plain pull_request won't do
  | "write-permissions" // asks for write access
  | "default-permissions"; // no permissions block, token access depends on repo settings

export interface Finding {
  code: FindingCode;
  severity: Severity;
  message: string;
  job?: string;
  line?: number;
}

export type Risk = "unsafe" | "review" | "safe";

/** What we suggest doing about the workflow. */
export type Fix =
  | "switch" // change the trigger to pull_request; nothing privileged is needed
  | "switch-or-allow" // same, or keep it and allow just this file with a policy
  | "split" // pull_request + workflow_run; privileged part must not touch PR code
  | "split-or-allow"; // same, or keep it and allow just this file with a policy

/** Fixes where keeping the file and allowing it with a policy is reasonable. */
export const allowable = (fix: Fix) => fix === "switch-or-allow" || fix === "split-or-allow";

export interface WorkflowAnalysis {
  path: string;
  triggers: string[];
  usesPrTarget: boolean;
  risk: Risk;
  fix: Fix;
  findings: Finding[];
  error?: string;
}

// Expressions that point at the pull request's own code.
const PR_CODE_EXPR =
  /github\.event\.pull_request\.head\.(?:sha|ref)\b|github\.head_ref\b|github\.event\.pull_request\.merge_commit_sha\b|github\.event\.pull_request\.head\.repo\.(?:full_name|clone_url|git_url|ssh_url|html_url)\b|refs\/pull\//;

// Fields a PR author controls that can carry shell metacharacters.
const UNTRUSTED_TEXT =
  /\$\{\{[^}]*?\b(github\.event\.pull_request\.(?:title|body|head\.(?:ref|label)|head\.repo\.(?:default_branch|description|homepage))|github\.head_ref|github\.event\.(?:comment|review|review_comment)\.body)\b[^}]*\}\}/;

const SECRET_REF = /\$\{\{[^}]*\bsecrets\.(?!GITHUB_TOKEN\b)[A-Za-z_][A-Za-z0-9_]*/;
const SECRETS_INHERIT = /^\s*secrets:\s*inherit\s*$/m;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

export function triggersOf(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((t): t is string => typeof t === "string");
  if (isObj(on)) return Object.keys(on);
  return [];
}

function taintedEnvNames(...envs: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const env of envs) {
    if (!isObj(env)) continue;
    for (const [k, v] of Object.entries(env)) if (PR_CODE_EXPR.test(str(v))) names.add(k);
  }
  return names;
}

function mentionsTainted(text: string, tainted: Set<string>): boolean {
  for (const name of tainted) {
    const n = name.replace(/[^A-Za-z0-9_]/g, "");
    if (new RegExp(`env\\.${n}\\b|\\$\\{?${n}\\b`).test(text)) return true;
  }
  return false;
}

function fetchesPrCode(run: string, tainted: Set<string>): boolean {
  if (/\bgh\s+pr\s+checkout\b/.test(run)) return true;
  for (const line of run.split("\n")) {
    if (!/\bgit\s+(?:fetch|pull|clone|checkout|switch|worktree\s+add)\b/.test(line)) continue;
    if (/refs\/pull\/|\bpull\/[^\s]*\/(?:head|merge)\b/.test(line)) return true;
    if (PR_CODE_EXPR.test(line) || mentionsTainted(line, tainted)) return true;
  }
  return false;
}

function permissionLevel(perms: unknown): "write" | "read" | "none" {
  if (perms === undefined || perms === null) return "none";
  if (typeof perms === "string") return perms === "write-all" ? "write" : "read";
  if (isObj(perms)) return Object.values(perms).some((v) => v === "write") ? "write" : "read";
  return "read";
}

export function analyzeWorkflow(path: string, source: string): WorkflowAnalysis {
  const lineCounter = new LineCounter();
  let doc: Document;
  try {
    doc = parseDocument(source, { lineCounter, uniqueKeys: false });
  } catch (e) {
    return parseFailure(path, source, (e as Error).message);
  }
  if (doc.errors.length > 0) return parseFailure(path, source, doc.errors[0]!.message);

  const wf = doc.toJS({ maxAliasCount: 1000 }) as unknown;
  if (!isObj(wf)) return parseFailure(path, source, "not a workflow (top level is not a mapping)");

  const triggers = triggersOf(wf.on);
  const base: WorkflowAnalysis = {
    path,
    triggers,
    usesPrTarget: triggers.includes("pull_request_target"),
    risk: "safe",
    fix: "split-or-allow",
    findings: [],
  };
  if (!base.usesPrTarget) return base;

  const lineAt = (keys: (string | number)[]): number | undefined => {
    const node = doc.getIn(keys, true) as { range?: [number, number, number] } | undefined;
    return node?.range ? lineCounter.linePos(node.range[0]).line : undefined;
  };

  const findings: Finding[] = [];
  const jobs = isObj(wf.jobs) ? wf.jobs : {};
  let anyWrite = permissionLevel(wf.permissions) === "write";
  let anyDefault = false;

  for (const [jobId, jobRaw] of Object.entries(jobs)) {
    if (!isObj(jobRaw)) continue;
    const job = jobRaw;
    if (job.permissions === undefined && wf.permissions === undefined) anyDefault = true;
    if (permissionLevel(job.permissions) === "write") anyWrite = true;

    if (typeof job.uses === "string") {
      findings.push({
        code: "reusable-workflow",
        severity: "medium",
        job: jobId,
        line: lineAt(["jobs", jobId, "uses"]),
        message: `Calls ${job.uses}. Its steps run with this trigger's access, but this tool doesn't check them.`,
      });
      continue;
    }

    const steps = Array.isArray(job.steps) ? job.steps : [];
    const envName = isObj(job.environment) ? str(job.environment.name) : str(job.environment);
    const envNote = envName
      ? ` The job uses the "${envName}" environment: if it requires reviewers, a maintainer approves each run, but the code can still change between approval and the run.`
      : "";
    let prCodeAt: number | undefined;
    let reportedRun = false;
    let reportedMaybe = false;

    steps.forEach((stepRaw, i) => {
      if (!isObj(stepRaw)) return;
      const step = stepRaw;
      const uses = str(step.uses);
      const run = str(step.run);
      const w = isObj(step.with) ? step.with : {};
      const tainted = taintedEnvNames(wf.env, job.env, step.env);
      const line = lineAt(["jobs", jobId, "steps", i]);
      const label = str(step.name) || uses || "run step";

      if (/^actions\/checkout@/i.test(uses)) {
        const ref = str(w.ref);
        const repo = str(w.repository);
        const unsafeFlag = w["allow-unsafe-pr-checkout"] === true || str(w["allow-unsafe-pr-checkout"]) === "true";
        if (PR_CODE_EXPR.test(ref) || PR_CODE_EXPR.test(repo) || mentionsTainted(ref + "\n" + repo, tainted)) {
          prCodeAt ??= i;
          findings.push({
            code: "pr-checkout",
            severity: "medium",
            job: jobId,
            line,
            message: `"${label}" checks out the pull request's code (${ref || repo})${unsafeFlag ? ", with allow-unsafe-pr-checkout: true" : ""}.`,
          });
        } else if (unsafeFlag) {
          findings.push({
            code: "unsafe-checkout-flag",
            severity: "medium",
            job: jobId,
            line,
            message: `"${label}" sets allow-unsafe-pr-checkout: true.`,
          });
        }
      } else if (run && fetchesPrCode(run, tainted)) {
        prCodeAt ??= i;
        findings.push({
          code: "pr-checkout",
          severity: "medium",
          job: jobId,
          line,
          message: `"${label}" fetches the pull request's code with git or gh.`,
        });
      } else if (prCodeAt !== undefined && i > prCodeAt) {
        if ((run || uses.startsWith("./")) && !reportedRun) {
          reportedRun = true;
          findings.push({
            code: "runs-pr-code",
            severity: "high",
            job: jobId,
            line,
            message: `"${label}" runs commands after the pull request's code is checked out. Unless every command only reads those files as data, a fork can run code here with this repository's token${
              /secrets\./.test(JSON.stringify(job)) ? " and secrets" : ""
            }.${envNote}`,
          });
        } else if (uses && !uses.startsWith("./") && !reportedRun && !reportedMaybe) {
          reportedMaybe = true;
          findings.push({
            code: "may-run-pr-code",
            severity: "medium",
            job: jobId,
            line,
            message: `"${label}" runs after the pull request's code is checked out. Check that it doesn't build, install or execute files from it.`,
          });
        }
      }

      const scripted = run || (/^actions\/github-script@/i.test(uses) ? str(w.script) : "");
      const m = scripted ? UNTRUSTED_TEXT.exec(scripted) : null;
      if (m) {
        findings.push({
          code: "script-injection",
          severity: "high",
          job: jobId,
          line,
          message: `"${label}" puts \${{ ${m[1]} }} straight into a script. A PR author controls that text and can inject commands. Pass it through env: instead.`,
        });
      }
    });
  }

  if (SECRET_REF.test(source) || SECRETS_INHERIT.test(source)) {
    findings.push({ code: "uses-secrets", severity: "info", message: "Uses repository secrets." });
  }
  if (anyWrite) {
    findings.push({ code: "write-permissions", severity: "info", message: "Asks for write access with the GITHUB_TOKEN." });
  } else if (anyDefault) {
    findings.push({
      code: "default-permissions",
      severity: "info",
      message: "Has no permissions: block, so the token's access depends on the repository's default setting.",
    });
  }

  return { ...base, findings, ...verdict(findings) };
}

export function verdict(findings: Finding[]): { risk: Risk; fix: Fix } {
  const has = (c: FindingCode) => findings.some((f) => f.code === c);
  const risk: Risk =
    has("runs-pr-code") || has("script-injection")
      ? "unsafe"
      : has("pr-checkout") || has("may-run-pr-code") || has("unsafe-checkout-flag") || has("reusable-workflow")
        ? "review"
        : "safe";
  const privileged = has("uses-secrets") || has("write-permissions") || has("default-permissions");
  const fix: Fix = !privileged ? (risk === "safe" ? "switch-or-allow" : "switch") : risk === "safe" ? "split-or-allow" : "split";
  return { risk, fix };
}

function parseFailure(path: string, source: string, error: string): WorkflowAnalysis {
  // If we can't parse it but it clearly mentions the trigger, say so rather than staying silent.
  const usesPrTarget = /\bpull_request_target\b/.test(source);
  return {
    path,
    triggers: usesPrTarget ? ["pull_request_target"] : [],
    usesPrTarget,
    risk: "review",
    fix: "split",
    findings: [],
    error: `Couldn't parse this file: ${error}`,
  };
}

// Exported for tests.
export const _internal = { PR_CODE_EXPR, UNTRUSTED_TEXT, fetchesPrCode };
