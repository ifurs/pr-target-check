# pr-target-check

Find the GitHub Actions workflows that stop running on **December 2, 2026**, and get a safe fix for each one.

```sh
npx github:ifurs/pr-target-check owner/repo
```

## What's changing

From December 2, 2026, GitHub blocks workflows triggered by `pull_request_target` in **public** repositories, unless an Actions event policy allows them ([changelog](https://github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2/)).

- Labelers, welcome bots, CLA checks and preview builds often use `pull_request_target`.
- When they're blocked, they don't fail loudly. They just stop running.
- Private and internal repositories, and GitHub Enterprise Server, aren't affected.

## Quick start

You need Node.js 22 or newer.

```sh
npx github:ifurs/pr-target-check                  # the repo in the current directory
npx github:ifurs/pr-target-check owner/repo       # one repo on GitHub
npx github:ifurs/pr-target-check --owner my-org   # every public repo of an org or user
```

To run a fixed release instead of the latest `main`, add the tag: `npx github:ifurs/pr-target-check#v0.1.0`. Release tags can't be moved or deleted.

The tool is **read-only**. It never changes anything on GitHub. When a fix needs a change on GitHub, it prints a command for you to review and run yourself.

## What it tells you

For each workflow that uses `pull_request_target`, you get three answers.

| Question | Possible answers |
|---|---|
| **1. Will it stop running?** | **Stops running on December 2**: no event policy allows it.<br>**Keeps running**: a policy allows it.<br>**Blocked now**: a policy already blocks it.<br>**Not affected**: the repository is private or internal. |
| **2. Is it safe?** | **Likely unsafe**: it checks out the pull request's code and runs it, or puts PR text into a script.<br>**Check it**: it touches PR code, or calls code the tool can't see.<br>**Looks safe**: it doesn't check out or run PR code. |
| **3. What's the fix?** | **Switch** to `pull_request`.<br>**Split** into `pull_request` + `workflow_run`.<br>**Allow** only this file with an event policy (offered only for files that look safe). |

## Example

```text
$ npx github:ifurs/pr-target-check nodejs/node
nodejs/node  (public)
  ✗ .github/workflows/commit-lint.yml
      Stops running on December 2, unless an event policy allows it (couldn't check: reading
      Actions policies needs admin access to the repository).
      Looks safe: it doesn't check out or run pull request code.
      Fix:
        Change `pull_request_target` to `pull_request`. It uses no secrets and asks for no
        write access, so fork PRs can run it with a read-only token. …
        Or keep it as it is and allow only this file:
          echo '{"name":"Allow pull_request_target for commit-lint.yml", …}' | gh api --method POST …
  …
6 pull_request_target workflows in 1 repository, 6 stop running on December 2.
```

A workflow that checks out the pull request's code and then runs it gets this instead:

```text
  ✗ .github/workflows/pwn-request.yml
      Stops running on December 2, unless an event policy allows it (couldn't check: …).
      Likely unsafe: it looks like it can run code from a pull request with this repository's token or secrets.
        - line 7: "actions/checkout@v6" checks out the pull request's code (${{ github.event.pull_request.head.sha }}).
        - line 10: "Install" runs commands after the pull request's code is checked out. …
      Fix:
        Don't allow this file as it is.
        Split it into two workflows: …
```

## Which fix to use

| If the workflow… | Do this |
|---|---|
| uses no secrets and needs no write access | **Switch** the trigger to `pull_request`. Fork PRs then get a read-only token, which is what you want for code you haven't reviewed. |
| needs secrets or write access (comments, labels, tokens) | **Split** it: a `pull_request` workflow does the untrusted part, then a `workflow_run` workflow does the privileged part without running PR code. [Guide and copy-paste example](docs/migrate.md). |
| looks safe and you want to keep it as it is | **Allow** only that file. The tool prints the `gh api` command that creates the policy. |
| looks unsafe | **Fix it first.** The tool never suggests allowing an unsafe file. |

There's one catch with switching. Depending on your fork-PR approval setting, `pull_request` runs from outside contributors may wait for a maintainer to click **Approve and run**. If the workflow has to run before that, and it never touches PR code, allow it instead.

The full guide covers all three fixes, with the mistakes people often make: [docs/migrate.md](docs/migrate.md).

## Tokens and access

| Situation | What happens |
|---|---|
| No token | Public repos still work, up to 60 GitHub API requests an hour. Policies aren't checked. |
| Token without admin access | Workflows are checked. Policies can't be read, so the result says *couldn't check* and assumes the default block. |
| Token with admin access to the repo | Everything is checked, including org and enterprise policies that apply to the repo. |

The tool looks for a token in `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`.

## Options

| Option | What it does |
|---|---|
| `[path]` | Scan a local checkout (default: current directory). |
| `owner/repo …` | Scan repositories on GitHub (their default branch). |
| `--owner NAME` | Scan every public, non-archived repository of an org or user. `--org` works too. |
| `--markdown` | Print a Markdown report, for an issue or `$GITHUB_STEP_SUMMARY`. |
| `--json` | Print JSON (see [JSON output](#json-output)). |
| `--offline` | Local scan only. Don't ask GitHub about visibility or policies. |
| `--verbose` | Show every finding, and repositories with nothing to report. |
| `-h`, `--help` / `-v`, `--version` | Help and version. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Nothing to do. |
| `1` | A workflow stops running, is blocked, or looks unsafe. |
| `2` | Error: bad arguments, or a repository couldn't be scanned. This wins over `1`. |

## Run it in CI

This workflow checks the repository every Monday and writes the report to the job summary. It fails while something still needs action.

```yaml
name: pr-target-check
on:
  workflow_dispatch:
  schedule:
    - cron: "0 6 * * 1"
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - run: npx -y github:ifurs/pr-target-check#v0.1.0 "$GITHUB_REPOSITORY" --markdown >> "$GITHUB_STEP_SUMMARY"
        env:
          GH_TOKEN: ${{ github.token }}
```

The job's token can't read Actions policies, because that needs admin access. So files you've already allowed still show as *couldn't check*. To check policies too, use a token with admin access to the repository.

## JSON output

`--json` prints `{ "results": [ … ] }`, with one entry per repository. This is the stable way for scripts and AI agents to read the output.

```jsonc
{
  "results": [
    {
      "name": "owner/repo",
      "slug": "owner/repo",            // missing for a local folder without a GitHub remote
      "visibility": "public",          // public | private | internal, when known
      "scanned": 12,                   // workflow files read
      "note": "…",                     // optional: archived repo, fork, local-vs-remote source
      "error": "…",                    // optional: the repo couldn't be scanned
      "files": [                       // only files that use pull_request_target
        {
          "analysis": {
            "path": ".github/workflows/labeler.yml",
            "triggers": ["pull_request_target", "workflow_dispatch"],
            "risk": "safe",            // unsafe | review | safe
            "fix": "split-or-allow",   // switch | switch-or-allow | split | split-or-allow
            "findings": [
              { "code": "write-permissions", "severity": "info", "message": "…", "job": "…", "line": 7 }
            ],
            "error": "…"               // optional: the file couldn't be parsed
          },
          "policy": { "kind": "blocked-by-default" },
          "stopsRunning": true,        // it won't run on pull_request_target after December 2
          "needsAction": true,         // it stops running, is unsafe, or a policy blocks one of its triggers
          "allowPolicy": { … }         // only when allowing is reasonable: the request body for the policy
        }
      ]
    }
  ]
}
```

`policy.kind` is one of:

| `kind` | Meaning | Extra fields |
|---|---|---|
| `allowed` | Every policy that targets the file allows `pull_request_target`. | `policies`, optional `otherBlocked` (the file's other triggers that the policy leaves out) |
| `blocked-by-policy` | A policy that targets the file doesn't allow it. | `policies`, optional `otherBlocked` |
| `blocked-by-default` | No policy targets the file, so GitHub's default block applies. | |
| `not-affected` | The repository isn't public. | `reason` |
| `unknown` | Policies couldn't be read. | `reason`, `isPublic` |

`findings[].code` is one of:

| `code` | Severity | Meaning |
|---|---|---|
| `runs-pr-code` | high | A `run:` step or local action (`uses: ./…`) runs after the PR's code is checked out, in the same job. |
| `script-injection` | high | PR text (`title`, `body`, `head.ref`, `github.head_ref`, …) is put straight into `run:` or `actions/github-script`. |
| `pr-checkout` | medium | `actions/checkout`, `git fetch` or `gh pr checkout` gets the PR's code. `env:` indirection is followed. |
| `may-run-pr-code` | medium | A third-party action runs after the PR's code is checked out. |
| `unsafe-checkout-flag` | medium | `actions/checkout` sets `allow-unsafe-pr-checkout: true`. |
| `reusable-workflow` | medium | A job calls another workflow. The tool doesn't follow it. |
| `uses-secrets` | info | The workflow uses repository secrets. |
| `write-permissions` | info | It asks for write access with the `GITHUB_TOKEN`. |
| `default-permissions` | info | It has no `permissions:` block, so access depends on the repository's default setting. |

Risk comes from the findings. Any high finding makes a file `unsafe`. Any medium finding makes it `review`. Otherwise it's `safe`. Secrets or write access make the fix `split` instead of `switch`.

## Limits

- These are pattern checks, not a full analysis. They catch the common "check out the PR's code, then build it" pattern without flagging bots that only read the event data.
- A step that runs after a PR checkout but only reads files is still flagged, so read the finding.
- For wider Actions security checks, use [zizmor](https://docs.zizmor.sh/) or [CodeQL for Actions](https://docs.github.com/en/code-security/code-scanning) alongside this tool.
- How several event policies combine is inferred from GitHub's docs: every active policy that targets the file must allow `pull_request_target`. GitHub's policy **Insights**, which show the runs a policy would block, are the final word.
- The printed policy command was tested against the live GitHub API on 2026-11-18. GitHub accepted it, and the tool then reported the file as allowed. Whether allowed runs go through can only be seen after December 2.

## Security

See [SECURITY.md](SECURITY.md) to report a problem privately. The most serious kind of bug here is a wrong *Looks safe*.

## License

MIT
