// Actions event policies: does one allow pull_request_target for a given workflow file?
// API reference: https://docs.github.com/en/rest/actions/policies
// Pure: no network.

export interface ApiPolicy {
  id?: number;
  name?: string;
  enforcement?: "disabled" | "active" | "evaluate" | string;
  source_type?: string;
  source?: string;
  conditions?: { workflow_path?: { include?: string[]; exclude?: string[] } } & Record<string, unknown>;
  rules?: { type?: string; parameters?: { allowed_events?: string[] } & Record<string, unknown> }[];
}

export type PolicyStatus =
  | { kind: "allowed"; policies: string[] }
  | { kind: "blocked-by-policy"; policies: string[] }
  | { kind: "blocked-by-default" }
  | { kind: "not-affected"; reason: string }
  | { kind: "unknown"; reason: string; isPublic?: boolean };

export const API_VERSION = "2026-03-10";
const EVENT_RULE = "restrict_action_events";

/** GitHub-style glob: `*` within a path segment, `**` across segments, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end > i) {
        re += glob.slice(i, end + 1).replace(/^\[!/, "[^");
        i = end;
      } else re += "\\[";
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesPath(file: string, pattern: string): boolean {
  if (pattern === "~ALL") return true;
  const p = pattern.replace(/^\.?\//, "");
  return globToRegExp(p).test(file);
}

export function targetsFile(policy: ApiPolicy, file: string): boolean {
  const wp = policy.conditions?.workflow_path;
  if (!wp) return true;
  const include = wp.include ?? [];
  const exclude = wp.exclude ?? [];
  const included = include.length === 0 || include.some((g) => matchesPath(file, g));
  return included && !exclude.some((g) => matchesPath(file, g));
}

const policyName = (p: ApiPolicy) => `${p.name ?? `#${p.id ?? "?"}`}${p.source_type && p.source_type !== "Repository" ? ` (${p.source_type.toLowerCase()})` : ""}`;

/**
 * Event policies layer like rulesets: every active one that targets the file must allow the
 * event. With none at all, GitHub's default policy blocks pull_request_target in public repos.
 */
export function evaluatePolicies(policies: ApiPolicy[], file: string): PolicyStatus {
  const applicable = policies.filter(
    (p) => p.enforcement === "active" && (p.rules ?? []).some((r) => r.type === EVENT_RULE) && targetsFile(p, file),
  );
  if (applicable.length === 0) return { kind: "blocked-by-default" };
  const allows = (p: ApiPolicy) =>
    (p.rules ?? []).filter((r) => r.type === EVENT_RULE).every((r) => (r.parameters?.allowed_events ?? []).includes("pull_request_target"));
  const blocking = applicable.filter((p) => !allows(p));
  if (blocking.length > 0) return { kind: "blocked-by-policy", policies: blocking.map(policyName) };
  return { kind: "allowed", policies: applicable.map(policyName) };
}

/**
 * A repository policy that allows exactly this file to run on the events it already uses.
 * The event list must include all of them: the policy restricts the targeted workflow to
 * these events, so leaving out e.g. workflow_dispatch would block that instead.
 */
export function allowPolicyBody(file: string, triggers: string[]) {
  const base = file.split("/").pop() ?? file;
  return {
    name: `Allow pull_request_target for ${base}`,
    enforcement: "active",
    conditions: { workflow_path: { include: [file], exclude: [] as string[] } },
    rules: [{ type: EVENT_RULE, parameters: { allowed_events: [...new Set(triggers)].sort() } }],
  };
}

export function allowPolicyCommand(repo: string, file: string, triggers: string[]): string {
  const body = JSON.stringify(allowPolicyBody(file, triggers));
  return `echo '${body}' | gh api --method POST repos/${repo}/actions/policies -H "X-GitHub-Api-Version: ${API_VERSION}" --input -`;
}
