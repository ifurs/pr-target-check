import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { GitHub, findToken, type Fetch } from "../src/github";
import { renderJson, renderMarkdown, renderText, ansi } from "../src/report";
import { parseGithubUrl, readLocalWorkflows, scanLocal, scanOwner, scanRemote } from "../src/scan";

const fx = (n: string) => readFileSync(join(__dirname, "fixtures", n), "utf8");

/** Fake GitHub API: path (without query for contents) → [status, body]. */
function fakeFetch(routes: Record<string, [number, unknown]>, seen: string[] = []): Fetch {
  return async (url, init) => {
    const path = url.replace("https://api.github.com/", "");
    seen.push(`${init.headers.Authorization ? "auth " : ""}${path}`);
    const hit = routes[path] ?? routes[path.split("?")[0]!];
    const [status, body] = hit ?? [404, { message: "Not Found" }];
    return {
      status,
      headers: { get: () => null },
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
}

const repo = (full_name: string, extra = {}) => ({ full_name, private: false, visibility: "public", archived: false, fork: false, default_branch: "main", ...extra });

function sandboxRoutes(policies: unknown[] | [number, unknown] = []): Record<string, [number, unknown]> {
  return {
    "repos/o/r": [200, repo("o/r")],
    "repos/o/r/contents/.github/workflows": [
      200,
      [
        { name: "labeler.yml", path: ".github/workflows/labeler.yml", type: "file" },
        { name: "pwn-request.yml", path: ".github/workflows/pwn-request.yml", type: "file" },
        { name: "push-only.yml", path: ".github/workflows/push-only.yml", type: "file" },
        { name: "README.md", path: ".github/workflows/README.md", type: "file" },
        { name: "sub", path: ".github/workflows/sub", type: "dir" },
      ],
    ],
    "repos/o/r/contents/.github/workflows/labeler.yml": [200, fx("labeler.yml")],
    "repos/o/r/contents/.github/workflows/pwn-request.yml": [200, fx("pwn-request.yml")],
    "repos/o/r/contents/.github/workflows/push-only.yml": [200, fx("push-only.yml")],
    "repos/o/r/actions/policies": Array.isArray(policies) && typeof policies[0] === "number" ? (policies as [number, unknown]) : [200, { total_count: policies.length, policies }],
  };
}

describe("scanRemote", () => {
  it("finds pull_request_target workflows and applies the default block", async () => {
    const seen: string[] = [];
    const gh = new GitHub("t", fakeFetch(sandboxRoutes(), seen));
    const r = await scanRemote(gh, "o/r");
    expect(r.scanned).toBe(3);
    expect(r.files.map((f) => [f.analysis.path, f.policy.kind, f.analysis.risk])).toEqual([
      [".github/workflows/labeler.yml", "blocked-by-default", "safe"],
      [".github/workflows/pwn-request.yml", "blocked-by-default", "unsafe"],
    ]);
    expect(seen).toContain("auth repos/o/r/actions/policies?has_parents=true&per_page=100&page=1");
    expect(seen.some((s) => s.includes("contents/.github/workflows/labeler.yml?ref=main"))).toBe(true);
  });

  it("recognises an allow policy for one file", async () => {
    const policy = {
      name: "Allow labeler",
      enforcement: "active",
      conditions: { workflow_path: { include: [".github/workflows/labeler.yml"] } },
      rules: [{ type: "restrict_action_events", parameters: { allowed_events: ["pull_request_target", "workflow_dispatch"] } }],
    };
    const r = await scanRemote(new GitHub("t", fakeFetch(sandboxRoutes([policy]))), "o/r");
    expect(r.files.map((f) => f.policy.kind)).toEqual(["allowed", "blocked-by-default"]);
  });

  it("says when policies can't be read", async () => {
    const r = await scanRemote(new GitHub("t", fakeFetch(sandboxRoutes([403, {}]))), "o/r");
    expect(r.files[0]!.policy).toEqual({ kind: "unknown", reason: "reading Actions policies needs admin access to the repository", isPublic: true });
    expect(renderText([r])).toContain("Stops running on December 2, unless an event policy allows it (couldn't check: reading");
    const r2 = await scanRemote(new GitHub(undefined, fakeFetch(sandboxRoutes())), "o/r");
    expect(r2.files[0]!.policy.kind).toBe("unknown");
    const r3 = await scanRemote(new GitHub("t", fakeFetch(sandboxRoutes([500, "boom"]))), "o/r");
    expect(r3.files[0]!.policy).toMatchObject({ reason: "couldn't read Actions policies (HTTP 500)" });
  });

  it("private repositories are not affected and skip the policy call", async () => {
    const routes = sandboxRoutes();
    routes["repos/o/r"] = [200, repo("o/r", { private: true, visibility: "private" })];
    const seen: string[] = [];
    const r = await scanRemote(new GitHub("t", fakeFetch(routes, seen)), "o/r");
    expect(r.files[0]!.policy.kind).toBe("not-affected");
    expect(seen.some((s) => s.includes("policies"))).toBe(false);
  });

  it("repositories without workflows and errors", async () => {
    const fork = await scanRemote(new GitHub("t", fakeFetch({ "repos/o/f": [200, repo("o/f", { fork: true })] })), "o/f");
    expect(fork.note).toMatch(/^Fork:/);
    const routes = { "repos/o/r": [200, repo("o/r", { archived: true })] as [number, unknown] };
    const r = await scanRemote(new GitHub("t", fakeFetch(routes)), "o/r");
    expect(r).toMatchObject({ scanned: 0, files: [], note: "Archived: workflows don't run." });
    const missing = await scanRemote(new GitHub("t", fakeFetch({})), "o/nope");
    expect(missing.error).toBe("Couldn't read o/nope (HTTP 404).");
    const bad = await scanRemote(new GitHub("t", fakeFetch({ ...routes, "repos/o/r/contents/.github/workflows": [500, {}] })), "o/r");
    expect(bad.error).toMatch(/Couldn't list workflows/);
  });

  it("explains rate limits", async () => {
    const f: Fetch = async () => ({ status: 403, headers: { get: () => "0" }, text: async () => "{}" });
    await expect(new GitHub(undefined, f).repo("o/r")).rejects.toThrow(/without a token/);
    await expect(new GitHub("t", f).repo("o/r")).rejects.toThrow(/rate limit reached\. Try/);
  });
});

describe("scanOwner", () => {
  it("falls back from orgs to users and skips private and archived repos", async () => {
    const routes = {
      ...sandboxRoutes(),
      "users/o/repos": [200, [repo("o/r"), repo("o/old", { archived: true }), repo("o/secret", { private: true })]] as [number, unknown],
    };
    const progress: string[] = [];
    const res = await scanOwner(new GitHub("t", fakeFetch(routes)), "o", (d, t) => progress.push(`${d}/${t}`));
    expect(res.map((r) => r.name)).toEqual(["o/r"]);
    expect(progress).toEqual(["1/1"]);
  });

  it("errors when the owner doesn't exist", async () => {
    await expect(scanOwner(new GitHub("t", fakeFetch({})), "ghost")).rejects.toThrow(/Couldn't list repositories of ghost/);
  });
});

describe("local scans", () => {
  const dir = mkdtempSync(join(tmpdir(), "prt-"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "labeler.yml"), fx("labeler.yml"));
  writeFileSync(join(dir, ".github", "workflows", "injection.yaml"), fx("injection.yml"));
  writeFileSync(join(dir, ".github", "workflows", "notes.txt"), "pull_request_target");

  it("reads only YAML files", () => {
    expect(readLocalWorkflows(dir).map((s) => s.path)).toEqual([".github/workflows/injection.yaml", ".github/workflows/labeler.yml"]);
    expect(readLocalWorkflows(join(dir, "nope"))).toEqual([]);
  });

  it("offline and no-remote modes leave the policy unknown", async () => {
    const off = await scanLocal(dir, undefined);
    expect(off.files.map((f) => f.policy)).toEqual([
      { kind: "unknown", reason: "offline mode" },
      { kind: "unknown", reason: "offline mode" },
    ]);
    const noRemote = await scanLocal(dir, new GitHub("t", fakeFetch({})));
    expect(noRemote.files[0]!.policy).toEqual({ kind: "unknown", reason: "no github.com remote found" });
  });

  it("parses GitHub remote URLs", () => {
    expect(parseGithubUrl("https://github.com/ifurs/gateway-sandbox.git")).toBe("ifurs/gateway-sandbox");
    expect(parseGithubUrl("git@github.com:o/r.js")).toBe("o/r.js");
    expect(parseGithubUrl("ssh://git@github.com/o/r/")).toBe("o/r");
    expect(parseGithubUrl("https://gitlab.com/o/r")).toBeUndefined();
  });

  it("CLI: offline local scan, exit code 1, text/markdown/json", async () => {
    const run = async (...args: string[]) => {
      let out = "";
      let err = "";
      const io = { out: { write: (s: string) => ((out += s), true) }, err: { write: (s: string) => ((err += s), true) }, env: {} };
      const code = await main(args, io as never);
      return { code, out, err };
    };
    const text = await run("--offline", dir);
    expect(text.code).toBe(1);
    expect(text.out).toContain("Stops running on December 2 if the repository is public, unless an event policy allows it (couldn't check: offline mode)");
    expect(text.out).toContain("2 pull_request_target workflows in 1 repository, 2 stop running on December 2, 1 unsafe.");
    expect(text.out).toContain("echo '{\"name\":\"Allow pull_request_target for labeler.yml\"");
    expect(text.out).toContain("Don't allow this file as it is.");
    expect((await run("--offline", "--markdown", dir)).out).toContain("#### ❌ `.github/workflows/labeler.yml`");
    const json = JSON.parse((await run("--offline", "--json", dir)).out);
    expect(json.results[0].files[1].allowPolicy.rules[0].parameters.allowed_events).toEqual(["pull_request_target", "workflow_dispatch"]);
    expect((await run("--help")).out).toContain("Usage:");
    expect((await run("-v")).out).toBe("dev\n");
    expect((await run("--bogus")).code).toBe(2);
    expect((await run("--offline", "not a target")).err).toContain("neither a directory nor owner/repo");
    expect((await run("--offline", "o/r")).code).toBe(2);
    expect((await run("--offline", "--owner", "o")).err).toContain("--owner needs GitHub access");
    const clean = mkdtempSync(join(tmpdir(), "prt-clean-"));
    const ok = await run("--offline", clean);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("No pull_request_target workflows in 1 repository. Nothing to do.");
  });
});

describe("report rendering", () => {
  it("covers every status and colors", async () => {
    const routes = sandboxRoutes([
      { name: "Only push", enforcement: "active", rules: [{ type: "restrict_action_events", parameters: { allowed_events: ["push"] } }] },
    ]);
    const blocked = await scanRemote(new GitHub("t", fakeFetch(routes)), "o/r");
    const errored = { name: "o/x", files: [], scanned: 0, error: "nope" };
    const empty = { name: "o/e", files: [], scanned: 2 };
    const text = renderText([blocked, errored, empty], ansi, true);
    expect(text).toContain('Blocked now: "Only push" doesn\'t allow pull_request_target.');
    expect(text).toContain("\x1b[31m");
    expect(text).toContain("o/e");
    expect(text).toContain("1 couldn't be scanned");
    expect(renderMarkdown([blocked, errored])).toContain("Couldn't scan: nope");
    expect(JSON.parse(renderJson([empty])).results[0].name).toBe("o/e");

    const allowAll = sandboxRoutes([
      { name: "All", enforcement: "active", rules: [{ type: "restrict_action_events", parameters: { allowed_events: ["pull_request_target"] } }] },
    ]);
    const allowed = renderText([await scanRemote(new GitHub("t", fakeFetch(allowAll)), "o/r")]);
    expect(allowed).toContain('Keeps running: allowed by "All".');
    expect(allowed).toContain("stays exploitable");
    expect(allowed).toContain("none stop running");
  });

  it("caps findings per file unless --verbose", () => {
    const steps = Array.from({ length: 6 }, (_, i) => `      - uses: actions/checkout@v6
        with: { ref: "\${{ github.head_ref }}" }
      - run: make t${i}`).join("\n");
    const src = `on: pull_request_target
permissions: {}
jobs:
  a:
    steps:
${steps}
`;
    const dir = mkdtempSync(join(tmpdir(), "prt-cap-"));
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "big.yml"), src);
    return scanLocal(dir, undefined).then((r) => {
      expect(renderText([r])).toContain("… and 3 more like these (--verbose shows all)");
      expect(renderText([r], undefined, true)).not.toContain("more like these");
    });
  });

  it("findToken prefers env vars", () => {
    expect(findToken({ GH_TOKEN: "a", GITHUB_TOKEN: "b" })).toBe("a");
    expect(findToken({ GITHUB_TOKEN: "b" })).toBe("b");
  });
});
