# Moving off `pull_request_target`

From **December 2, 2026**, GitHub blocks workflows triggered by `pull_request_target` in public
repositories unless an Actions event policy allows them
([changelog](https://github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2/),
[docs](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)).
Private and internal repositories, and GitHub Enterprise Server, aren't affected.

`pr-target-check` tells you which of three fixes fits each workflow.

## 1. Switch to `pull_request`

**When:** the workflow uses no secrets and needs no write access. Tests, linters and
read-only checks usually fit.

Change the trigger:

```diff
 on:
-  pull_request_target:
+  pull_request:
```

and keep (or add) a read-only `permissions:` block. Fork PRs then run with a read-only token
and no secrets, which is exactly what you want for code you haven't reviewed.

One difference to know about: `pull_request_target` runs without waiting, but `pull_request`
runs from outside contributors may need a maintainer to click **Approve and run**, depending on
your repository's fork-PR approval setting. If the workflow exists precisely to run before that
approval (some triage bots do), and it never touches PR code, use option 3 instead.

If the workflow checked out `github.event.pull_request.head.sha` or `refs/pull/N/merge`, you can
drop that: `pull_request` already checks out the merge commit.

## 2. Split into two workflows

**When:** the workflow needs write access or secrets: commenting, labelling, posting results,
uploading coverage with a token.

1. A `pull_request` workflow does anything that touches PR code, with no secrets, and saves what
   part 2 needs (results, the PR number) as an artifact.
2. A `workflow_run` workflow runs from the default branch after part 1 finishes. It has secrets
   and write access, reads the artifact **as data**, and never runs anything from the PR.

Copy-paste example that labels fork PRs:
[`examples/pr-info.yml`](examples/pr-info.yml) and [`examples/pr-label.yml`](examples/pr-label.yml).

Things that bite people:

- `github.event.workflow_run.pull_requests` is **empty for PRs from forks**. Pass the number in
  the artifact (or look the PR up by `github.event.workflow_run.head_sha`).
- The artifact is written by the PR, so it's untrusted. Validate its format, check the number
  against the API (the example does), and never `source`, `eval` or execute it.
- `workflow_run` only fires for workflows on the default branch, and part 2's `workflows:` must
  match part 1's `name:` exactly.

## 3. Keep it and allow only that file

**When:** the workflow never checks out or runs PR code, and never puts PR text (title, body,
branch name) straight into a script. `pr-target-check` marks these as *Looks safe* and prints
the command.

Create a repository Actions event policy that targets just that file, through **Settings →
Actions → Policies**, or the
[REST API](https://docs.github.com/en/rest/actions/policies):

```sh
echo '{
  "name": "Allow pull_request_target for labeler.yml",
  "enforcement": "active",
  "conditions": { "workflow_path": { "include": [".github/workflows/labeler.yml"], "exclude": [] } },
  "rules": [{ "type": "restrict_action_events",
              "parameters": { "allowed_events": ["pull_request_target", "workflow_dispatch"] } }]
}' | gh api --method POST repos/OWNER/REPO/actions/policies \
     -H "X-GitHub-Api-Version: 2026-03-10" --input -
```

List **every** event the file uses in `allowed_events`, not just `pull_request_target`: the policy
limits that workflow to the events it lists. `pr-target-check` fills this in for you.

Don't allow the trigger for all workflows (`~ALL`). A new workflow added later would get it too.

## Checking your work

- Run `npx github:ifurs/pr-target-check` again. Allowed files show *Keeps running*.
- **Settings → Actions → Policy insights** shows runs that were blocked or would have been.
