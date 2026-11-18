import { describe, expect, it } from "vitest";
import { allowPolicyBody, allowPolicyCommand, evaluatePolicies, globToRegExp, matchesPath, targetsFile, type ApiPolicy } from "../src/policy";

const F = ".github/workflows/labeler.yml";
const events = (name: string, allowed: string[], extra: Partial<ApiPolicy> = {}): ApiPolicy => ({
  name,
  enforcement: "active",
  rules: [{ type: "restrict_action_events", parameters: { allowed_events: allowed } }],
  ...extra,
});

describe("globs", () => {
  it.each([
    [".github/workflows/*.yml", F, true],
    [".github/workflows/*.yml", ".github/workflows/sub/x.yml", false],
    [".github/**/*.yml", F, true],
    ["**", F, true],
    ["**/labeler.yml", F, true],
    [".github/workflows/label?r.yml", F, true],
    [".github/workflows/[lm]abeler.yml", F, true],
    [".github/workflows/[!l]abeler.yml", F, false],
    ["./.github/workflows/labeler.yml", F, true],
    ["/.github/workflows/labeler.yml", F, true],
    [".github/workflows/labeler.yaml", F, false],
    ["~ALL", F, true],
    ["a[b", "a[b", true],
    ["a+b.yml", "a+b.yml", true],
  ])("%s vs %s → %s", (g, f, want) => expect(matchesPath(f, g)).toBe(want));

  it("escapes regex characters", () => {
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("targetsFile", () => {
  it("no workflow_path targets everything", () => expect(targetsFile({}, F)).toBe(true));
  it("include and exclude", () => {
    expect(targetsFile({ conditions: { workflow_path: { include: [".github/workflows/*"], exclude: [F] } } }, F)).toBe(false);
    expect(targetsFile({ conditions: { workflow_path: { include: [".github/workflows/other.yml"] } } }, F)).toBe(false);
    expect(targetsFile({ conditions: { workflow_path: { exclude: [] } } }, F)).toBe(true);
  });
});

describe("evaluatePolicies", () => {
  it("no event policy: GitHub's default block applies", () => {
    expect(evaluatePolicies([], F)).toEqual({ kind: "blocked-by-default" });
    const actorsOnly: ApiPolicy = { name: "actors", enforcement: "active", rules: [{ type: "restrict_actions_actors" }] };
    expect(evaluatePolicies([actorsOnly], F).kind).toBe("blocked-by-default");
  });

  it("ignores disabled and evaluate-only policies", () => {
    const p = [events("off", ["pull_request_target"], { enforcement: "disabled" }), events("eval", ["pull_request_target"], { enforcement: "evaluate" })];
    expect(evaluatePolicies(p, F).kind).toBe("blocked-by-default");
  });

  it("reports other triggers a policy leaves out", () => {
    const p = [events("Allow labeler", ["pull_request_target", "workflow_dispatch"])];
    expect(evaluatePolicies(p, F, ["pull_request_target", "workflow_dispatch", "issue_comment", "schedule"])).toEqual({
      kind: "allowed",
      policies: ["Allow labeler"],
      otherBlocked: ["issue_comment", "schedule"],
    });
    expect(evaluatePolicies([events("Push only", ["push"])], F, ["pull_request_target", "push", "schedule"])).toEqual({
      kind: "blocked-by-policy",
      policies: ["Push only"],
      otherBlocked: ["schedule"],
    });
    expect(evaluatePolicies([], F, ["pull_request_target", "schedule"])).toEqual({ kind: "blocked-by-default" });
  });

  it("allowed when every applicable event policy allows it", () => {
    const p = [
      events("Allow labeler", ["pull_request_target", "workflow_dispatch"], { conditions: { workflow_path: { include: [F] } } }),
      events("Org", ["push", "pull_request_target"], { source_type: "Organization" }),
      events("Other file", ["push"], { conditions: { workflow_path: { include: [".github/workflows/ci.yml"] } } }),
    ];
    expect(evaluatePolicies(p, F)).toEqual({ kind: "allowed", policies: ["Allow labeler", "Org (organization)"] });
  });

  it("blocked when any applicable event policy leaves it out", () => {
    const p = [events("Allow labeler", ["pull_request_target"]), events("Org", ["push"], { source_type: "Organization" }), { id: 7, enforcement: "active", rules: [{ type: "restrict_action_events" }] }];
    expect(evaluatePolicies(p, F)).toEqual({ kind: "blocked-by-policy", policies: ["Org (organization)", "#7"] });
  });
});

describe("allow policy", () => {
  it("targets only the file and keeps every trigger it uses", () => {
    expect(allowPolicyBody(F, ["workflow_dispatch", "pull_request_target", "workflow_dispatch"])).toEqual({
      name: "Allow pull_request_target for labeler.yml",
      enforcement: "active",
      conditions: { workflow_path: { include: [F], exclude: [] } },
      rules: [{ type: "restrict_action_events", parameters: { allowed_events: ["pull_request_target", "workflow_dispatch"] } }],
    });
  });

  it("builds a gh api command", () => {
    const cmd = allowPolicyCommand("o/r", F, ["pull_request_target"]);
    expect(cmd).toMatch(/^echo '\{.*\}' \| gh api --method POST repos\/o\/r\/actions\/policies -H "X-GitHub-Api-Version: 2026-03-10" --input -$/);
    expect(JSON.parse(cmd.slice(6, cmd.indexOf("' |")))).toEqual(allowPolicyBody(F, ["pull_request_target"]));
  });
});
