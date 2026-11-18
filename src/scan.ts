// Turns repositories (local or remote) into results. All GitHub access goes through `GitHub`.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mapLimit, type GitHub, type RepoInfo } from "./github";
import { evaluatePolicies, type ApiPolicy, type PolicyStatus } from "./policy";
import { analyzeWorkflow, type WorkflowAnalysis } from "./workflow";

export interface FileResult {
  analysis: WorkflowAnalysis;
  policy: PolicyStatus;
}

export interface RepoResult {
  /** owner/name, or the local path when the remote is unknown. */
  name: string;
  /** owner/name when known, for API commands. */
  slug?: string;
  visibility?: string;
  files: FileResult[];
  /** Workflow files scanned, including ones without pull_request_target. */
  scanned: number;
  note?: string;
  error?: string;
}

type Ctx = { visibility?: string; policies?: ApiPolicy[]; reason?: string };

function statusFor(ctx: Ctx, file: string): PolicyStatus {
  if (ctx.visibility && ctx.visibility !== "public") return { kind: "not-affected", reason: `${ctx.visibility} repository` };
  if (ctx.policies) return evaluatePolicies(ctx.policies, file);
  return { kind: "unknown", reason: ctx.reason ?? "policies weren't checked", isPublic: ctx.visibility === "public" || undefined };
}

function analyzeAll(sources: { path: string; source: string }[], ctx: Ctx): FileResult[] {
  return sources
    .map((s) => analyzeWorkflow(s.path, s.source))
    .filter((a) => a.usesPrTarget)
    .map((analysis) => ({ analysis, policy: statusFor(ctx, analysis.path) }));
}

export function readLocalWorkflows(dir: string): { path: string; source: string }[] {
  const wfDir = join(dir, ".github", "workflows");
  let names: string[];
  try {
    names = readdirSync(wfDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /\.ya?ml$/i.test(n) && statSync(join(wfDir, n)).isFile())
    .sort()
    .map((n) => ({ path: `.github/workflows/${n}`, source: readFileSync(join(wfDir, n), "utf8") }));
}

/** owner/name from the local checkout's origin remote, if it's on github.com. */
export function githubSlugFromGit(dir: string): string | undefined {
  try {
    const url = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return parseGithubUrl(url);
  } catch {
    return undefined;
  }
}

export function parseGithubUrl(url: string): string | undefined {
  const m = /github\.com[:/]+([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

export async function scanLocal(dir: string, gh: GitHub | undefined): Promise<RepoResult> {
  const sources = readLocalWorkflows(dir);
  const slug = githubSlugFromGit(dir);
  const ctx: Ctx = {};
  let note: string | undefined;
  const needsContext = sources.some((s) => /\bpull_request_target\b/.test(s.source));
  if (needsContext && gh && slug) {
    try {
      const info = await gh.repo(slug);
      ctx.visibility = info.visibility ?? (info.private ? "private" : "public");
      if (ctx.visibility === "public") Object.assign(ctx, await gh.policies(slug));
      note = `Local files from ${dir}; visibility and policies from ${slug}.`;
    } catch (e) {
      ctx.reason = `couldn't reach ${slug}: ${(e as Error).message}`;
    }
  } else if (needsContext) {
    ctx.reason = !gh ? "offline mode" : "no github.com remote found";
  }
  return { name: slug ?? dir, slug, visibility: ctx.visibility, files: analyzeAll(sources, ctx), scanned: sources.length, note };
}

export async function scanRemote(gh: GitHub, slugOrInfo: string | RepoInfo): Promise<RepoResult> {
  const name = typeof slugOrInfo === "string" ? slugOrInfo : slugOrInfo.full_name;
  try {
    const info = typeof slugOrInfo === "string" ? await gh.repo(slugOrInfo) : slugOrInfo;
    const visibility = info.visibility ?? (info.private ? "private" : "public");
    const sources = await gh.workflowFiles(info.full_name, info.default_branch);
    const ctx: Ctx = { visibility };
    if (visibility === "public" && sources.some((s) => /\bpull_request_target\b/.test(s.source))) {
      Object.assign(ctx, await gh.policies(info.full_name));
    }
    return {
      name: info.full_name,
      slug: info.full_name,
      visibility,
      files: analyzeAll(sources, ctx),
      scanned: sources.length,
      note: info.archived
        ? "Archived: workflows don't run."
        : info.fork
          ? "Fork: these files probably come from the upstream repository, and Actions are often disabled in forks."
          : undefined,
    };
  } catch (e) {
    return { name, slug: name, files: [], scanned: 0, error: (e as Error).message };
  }
}

export async function scanOwner(gh: GitHub, owner: string, onProgress?: (done: number, total: number) => void): Promise<RepoResult[]> {
  const repos = await gh.publicRepos(owner);
  let done = 0;
  return mapLimit(repos, 4, async (r) => {
    const res = await scanRemote(gh, r);
    onProgress?.(++done, repos.length);
    return res;
  });
}
