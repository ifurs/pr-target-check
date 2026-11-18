import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { _internal, analyzeWorkflow, triggersOf } from "../src/workflow";

const fixture = (name: string) => analyzeWorkflow(`.github/workflows/${name}`, readFileSync(join(__dirname, "fixtures", name), "utf8"));
const codes = (name: string) => fixture(name).findings.map((f) => f.code);

describe("triggersOf", () => {
  it("handles string, list and map forms", () => {
    expect(triggersOf("pull_request_target")).toEqual(["pull_request_target"]);
    expect(triggersOf(["push", "pull_request_target", 3])).toEqual(["push", "pull_request_target"]);
    expect(triggersOf({ push: null, pull_request_target: { types: ["opened"] } })).toEqual(["push", "pull_request_target"]);
    expect(triggersOf(undefined)).toEqual([]);
  });
});

describe("analyzeWorkflow", () => {
  it("ignores workflows without pull_request_target", () => {
    const a = fixture("push-only.yml");
    expect(a.usesPrTarget).toBe(false);
    expect(a.findings).toEqual([]);
  });

  it("labeler with write access: safe, can be allowed or split", () => {
    const a = fixture("labeler.yml");
    expect(a.usesPrTarget).toBe(true);
    expect(a.triggers).toEqual(["pull_request_target", "workflow_dispatch"]);
    expect(a.risk).toBe("safe");
    expect(a.fix).toBe("split-or-allow");
    expect(codes("labeler.yml")).toEqual(["write-permissions"]);
  });

  it("classic pwn request: checkout of head sha then npm ci, with secrets", () => {
    const a = fixture("pwn-request.yml");
    expect(a.risk).toBe("unsafe");
    expect(a.fix).toBe("split");
    expect(codes("pwn-request.yml")).toEqual(["pr-checkout", "runs-pr-code", "uses-secrets", "default-permissions"]);
    const run = a.findings.find((f) => f.code === "runs-pr-code")!;
    expect(run.line).toBe(10);
    expect(run.job).toBe("test");
    expect(run.message).toContain("and secrets");
  });

  it("script injection through the PR title, but not through env", () => {
    const a = fixture("injection.yml");
    expect(a.risk).toBe("unsafe");
    const inj = a.findings.filter((f) => f.code === "script-injection");
    expect(inj).toHaveLength(1);
    expect(inj[0]!.message).toContain("github.event.pull_request.title");
    expect(inj[0]!.line).toBe(8);
  });

  it("injection inside actions/github-script", () => {
    expect(codes("github-script-injection.yml")).toContain("script-injection");
  });

  it("read-only tests on the merge ref: unsafe, but switching to pull_request fixes it", () => {
    const a = fixture("readonly-tests.yml");
    expect(a.risk).toBe("unsafe");
    expect(a.fix).toBe("switch");
  });

  it("follows env indirection into git fetch, and local actions run PR code", () => {
    const a = fixture("env-fetch.yml");
    expect(codes("env-fetch.yml")).toEqual(["pr-checkout", "runs-pr-code", "write-permissions"]);
    expect(a.findings[0]!.message).toContain("fetches");
    expect(a.risk).toBe("unsafe");
  });

  it("reusable workflows need review", () => {
    const a = fixture("reusable.yml");
    expect(a.risk).toBe("review");
    expect(codes("reusable.yml")).toEqual(["reusable-workflow", "uses-secrets", "default-permissions"]);
  });

  it("third-party action after a fork checkout and the unsafe flag", () => {
    const a = fixture("third-party-after-checkout.yml");
    expect(codes("third-party-after-checkout.yml")).toEqual(["pr-checkout", "may-run-pr-code", "write-permissions"]);
    expect(a.findings[0]!.message).toContain("with allow-unsafe-pr-checkout: true");
    expect(a.risk).toBe("review");
    expect(a.fix).toBe("split");
  });

  it("flags allow-unsafe-pr-checkout on its own and notes environments", () => {
    const flag = analyzeWorkflow(
      "x.yml",
      ["on: pull_request_target", "permissions: {}", "jobs:", "  a:", "    steps:", "      - uses: actions/checkout@v7", "        with:", "          allow-unsafe-pr-checkout: 'true'"].join("\n"),
    );
    expect(flag.findings.map((f) => f.code)).toEqual(["unsafe-checkout-flag"]);
    expect(flag.risk).toBe("review");
    for (const env of ["environment: external", "environment:\n      name: external"]) {
      const a = analyzeWorkflow(
        "x.yml",
        ["on: pull_request_target", "jobs:", "  a:", `    ${env}`, "    steps:", "      - run: gh pr checkout 1", "      - run: make"].join("\n"),
      );
      expect(a.findings.find((f) => f.code === "runs-pr-code")!.message).toContain('the "external" environment');
    }
  });

  it("no permissions block and no secrets: safe, but token access is unknown", () => {
    const a = fixture("no-permissions.yml");
    expect(a.risk).toBe("safe");
    expect(codes("no-permissions.yml")).toEqual(["default-permissions"]);
    expect(a.fix).toBe("split-or-allow");
  });

  it("reports parse errors instead of skipping the file", () => {
    const a = fixture("broken.yml");
    expect(a.usesPrTarget).toBe(true);
    expect(a.error).toMatch(/Couldn't parse/);
    expect(a.risk).toBe("review");
  });

  it("handles non-mapping documents and empty jobs", () => {
    expect(analyzeWorkflow("x.yml", "- a\n- b\n").error).toMatch(/not a workflow/);
    const a = analyzeWorkflow("x.yml", "on: pull_request_target\npermissions: {}\njobs:\n  a: 1\n  b:\n    steps: [1, {run: ls}]\n");
    expect(a.risk).toBe("safe");
    expect(a.fix).toBe("switch-or-allow");
  });

  it("uses the read level of string permissions", () => {
    const a = analyzeWorkflow("x.yml", "on: pull_request_target\npermissions: read-all\njobs:\n  a:\n    steps: [{run: ls}]\n");
    expect(a.fix).toBe("switch-or-allow");
  });
});

describe("fetchesPrCode", () => {
  const f = (s: string) => _internal.fetchesPrCode(s, new Set(["SHA"]));
  it.each([
    "gh pr checkout 12",
    "git fetch origin pull/12/head:pr",
    "git fetch origin refs/pull/12/merge",
    "git checkout ${{ github.event.pull_request.head.sha }}",
    "git clone ${{ github.event.pull_request.head.repo.clone_url }}",
    "git switch ${SHA}",
    "git worktree add ../pr ${{ env.SHA }}",
  ])("flags %s", (s) => expect(f(s)).toBe(true));
  it.each(["git fetch origin main", "echo pull/1/head", "git log -1", "gh pr diff 12"])("ignores %s", (s) => expect(f(s)).toBe(false));
});
