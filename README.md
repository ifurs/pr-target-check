# pr-target-check

**On December 2, 2026, GitHub starts blocking `pull_request_target` workflows in public repositories**
([changelog](https://github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2/)).
Labelers, welcome bots, CLA checks and preview builds that use it will quietly stop running.

`pr-target-check` finds those workflows and tells you, for each file:

1. **Will it stop running?** It checks your repository's Actions event policies, including org
   and enterprise ones.
2. **Is it safe?** It looks for checkouts of PR code that then get run, and for PR titles or branch
   names put straight into scripts.
3. **What's the fix?** Switch to `pull_request`, split into `pull_request` + `workflow_run`, or keep
   it and allow just that file. For safe files, it prints the exact `gh api` command for the policy.

```sh
npx pr-target-check                  # the repo in the current directory
npx pr-target-check owner/repo       # any repo on GitHub
npx pr-target-check --owner my-org   # every public repo of an org or user
```

## Example

```text
$ npx pr-target-check nodejs/node
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
  ✗ .github/workflows/label-pr.yml
  …
6 pull_request_target workflows in 1 repository, 6 stop running on December 2.
```

A workflow that checks out the pull request's code and then runs it looks like this:

```text
  ✗ .github/workflows/ci.yaml
      Likely unsafe: it looks like it can run code from a pull request with this repository's token or secrets.
        - line 67: "Check out Git repository" checks out the pull request's code
          (${{ github.event.pull_request.head.sha }}), with allow-unsafe-pr-checkout: true.
        - line 101: "Clean Python caches" runs commands after the pull request's code is checked out. …
      Fix:
        Don't allow this file as it is.
        Split it into two workflows: …
```

## What it checks

| Finding | Meaning |
|---|---|
| checks out / fetches PR code | `actions/checkout` with the PR's head SHA, branch, merge ref or fork repo, or `git fetch`/`gh pr checkout` of it. Follows `env:` indirection. |
| runs PR code | A `run:` step or local action (`uses: ./…`) after that checkout, in the same job. |
| script injection | `${{ github.event.pull_request.title }}`, `body`, `head.ref`, `github.head_ref` and similar inside `run:` or `actions/github-script`. |
| reusable workflow | A job that calls another workflow. Its steps aren't followed, so it's marked *Check it*. |
| secrets, write access | Decide whether a plain `pull_request` trigger is enough. |

Then it picks a fix:

- **No secrets, no write access:** switch to `pull_request`.
- **Needs secrets or write access:** split into `pull_request` + `workflow_run`.
  [Guide and copy-paste example](docs/migrate.md).
- **Doesn't touch PR code:** you can also keep it and allow only that file with an event policy.
  The command lists every event the file uses, because the policy limits the workflow to those events.

It never suggests allowing a file that looks unsafe.

## Policies and tokens

- It's **read-only**. It never changes anything on GitHub. It only prints commands you can run.
- Token: `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`. Public repos work without one (60 requests an hour).
- Reading a repository's Actions policies needs **admin** access. Without it, the result says
  *couldn't check* and assumes GitHub's default block.
- Private and internal repositories are reported as not affected.

## In CI

The exit code is `1` when something stops running or looks unsafe, `0` when there's nothing to do,
and `2` on errors. `--markdown` prints a report you can append to `$GITHUB_STEP_SUMMARY` or paste
into an issue. `--json` gives machine-readable output.

## Limits

These are pattern checks, not a full analysis. They're tuned to catch the common
"check out the PR head, then build it" pattern without flagging bots that only read the event payload.
A step that runs after a PR checkout but only reads files will still be flagged, so read the finding.
For broader Actions security checks, use [zizmor](https://docs.zizmor.sh/) or
[CodeQL for Actions](https://docs.github.com/en/code-security/code-scanning) alongside this tool.

How event policies combine is inferred from GitHub's docs: every active event policy that targets
the file must allow `pull_request_target`, and if none target it, the default block applies.
GitHub's **Settings → Actions → Policy insights** page is the final word.

## License

MIT
