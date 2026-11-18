# Security policy

pr-target-check reads workflow files from repositories you may not control, and people use its
verdicts to decide whether a `pull_request_target` workflow is safe to keep. Both make security
reports important.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately with GitHub's
[private vulnerability reporting](https://github.com/ifurs/pr-target-check/security/advisories/new)
(Security → Advisories → Report a vulnerability).

Please include the workflow file (or repository) that shows the problem, the command you ran, and
what went wrong.

You'll get an acknowledgement within a week.

## In scope

- **A wrong "Looks safe" verdict** for a workflow that runs pull request code or injects PR text
  into a script, so the tool offers an allow command for it. This is the most important class.
- Content from a scanned repository (file names, step names, YAML) that breaks out of the printed
  `gh api` command, writes terminal escape sequences, or injects links or HTML into `--markdown`
  output.
- Sending the GitHub token anywhere other than `api.github.com`.
- Any way the tool changes something on GitHub. It's meant to be read-only.

## Out of scope

- Workflows the tool marks *Likely unsafe* or *Check it* that turn out to be fine. False
  positives are bugs; please open a normal issue.
- Patterns listed under *Limits* in the README, like reusable workflows it doesn't follow.

## Supported versions

Only the latest version gets fixes.
