// Minimal read-only GitHub REST client. The tool never writes to GitHub.
import { execFileSync } from "node:child_process";
import { API_VERSION, type ApiPolicy } from "./policy";

export interface RepoInfo {
  full_name: string;
  visibility?: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  default_branch: string;
}

export interface Response<T> {
  status: number;
  data?: T;
  text?: string;
}

export type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export function findToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.GH_TOKEN) return env.GH_TOKEN;
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  try {
    const t = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

export class GitHub {
  constructor(
    private readonly token: string | undefined,
    private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
    private readonly base = "https://api.github.com",
  ) {}

  get authenticated() {
    return Boolean(this.token);
  }

  async get<T>(path: string, accept = "application/vnd.github+json"): Promise<Response<T>> {
    const headers: Record<string, string> = {
      Accept: accept,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "pr-target-check",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(`${this.base}/${path.replace(/^\//, "")}`, { headers });
    const text = await res.text();
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      throw new Error(
        this.token
          ? "GitHub API rate limit reached. Try again later."
          : "GitHub API rate limit reached (60 requests an hour without a token). Set GH_TOKEN or run `gh auth login`.",
      );
    }
    if (res.status >= 200 && res.status < 300) {
      if (accept.includes("raw")) return { status: res.status, text };
      return { status: res.status, data: text ? (JSON.parse(text) as T) : undefined };
    }
    return { status: res.status, text };
  }

  async repo(fullName: string): Promise<RepoInfo> {
    const r = await this.get<RepoInfo>(`repos/${fullName}`);
    if (!r.data) throw new Error(`Couldn't read ${fullName} (HTTP ${r.status}).`);
    return r.data;
  }

  /** Workflow files on a branch. Empty when the repo has none. */
  async workflowFiles(fullName: string, ref: string): Promise<{ path: string; source: string }[]> {
    const r = await this.get<{ name: string; path: string; type: string }[]>(
      `repos/${fullName}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`,
    );
    if (r.status === 404) return [];
    if (!Array.isArray(r.data)) throw new Error(`Couldn't list workflows in ${fullName} (HTTP ${r.status}).`);
    const files = r.data.filter((f) => f.type === "file" && /\.ya?ml$/i.test(f.name));
    return mapLimit(files, 6, async (f) => {
      const c = await this.get<never>(
        `repos/${fullName}/contents/${f.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
        "application/vnd.github.raw+json",
      );
      if (c.text === undefined) throw new Error(`Couldn't read ${f.path} in ${fullName} (HTTP ${c.status}).`);
      return { path: f.path, source: c.text };
    });
  }

  /** Repository policies including inherited org/enterprise ones. Undefined if we can't read them. */
  async policies(fullName: string): Promise<{ policies?: ApiPolicy[]; reason?: string }> {
    if (!this.token) return { reason: "no GitHub token, so policies weren't checked" };
    const all: ApiPolicy[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = await this.get<{ policies?: ApiPolicy[] }>(
        `repos/${fullName}/actions/policies?has_parents=true&per_page=100&page=${page}`,
      );
      if (r.status === 403 || r.status === 404) return { reason: "reading Actions policies needs admin access to the repository" };
      if (!r.data) return { reason: `couldn't read Actions policies (HTTP ${r.status})` };
      const batch = r.data.policies ?? [];
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return { policies: all };
  }

  /** Public, non-archived repositories of an organization or user. */
  async publicRepos(owner: string): Promise<RepoInfo[]> {
    const out: RepoInfo[] = [];
    let kind: "orgs" | "users" = "orgs";
    for (let page = 1; page <= 50; page++) {
      const q = kind === "orgs" ? "type=public" : "type=owner";
      let r = await this.get<RepoInfo[]>(`${kind}/${owner}/repos?${q}&per_page=100&page=${page}`);
      if (r.status === 404 && kind === "orgs" && page === 1) {
        kind = "users";
        r = await this.get<RepoInfo[]>(`users/${owner}/repos?type=owner&per_page=100&page=1`);
      }
      if (!Array.isArray(r.data)) throw new Error(`Couldn't list repositories of ${owner} (HTTP ${r.status}).`);
      out.push(...r.data.filter((x) => !x.private && !x.archived));
      if (r.data.length < 100) break;
    }
    return out;
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
