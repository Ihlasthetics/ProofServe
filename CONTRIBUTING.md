# Contributing

Use Node.js 22 (22.18.0 or newer within 22.x) and npm 10 or 11. Run `npm ci` after cloning and `npm run validate` before requesting review.

Read `AGENTS.md` and the team playbook. Start only the authorized task after its dependencies merge. Start from clean, current `main` and create a branch named `<type>/<task-id>-<description>`. One task uses one branch and one pull request. Never push directly to `main`.

Respect the ownership table in `AGENTS.md`. Coordinate cross-owner work through an issue. Shared contracts require reading `docs/api-contract.md` once Y01 creates it, Yhlas’s approval, and notification to both teammates.

Use `npm run format` to format changes. Review `git status` and the full diff, including new files, for scope and secrets. Initial agent implementation stops for human review before commit, push, or pull-request creation. After authorization, stage only task files and use `<type>(<scope>): <imperative description>` commit messages.

Pull requests use the supplied template, require green CI and a teammate approval, and are squash-merged. GitHub collaborator invitations and branch protection are manual team-lead setup. CODEOWNERS is deferred until real GitHub handles are confirmed.
