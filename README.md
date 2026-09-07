# ProofServe

ProofServe is planned as a registry where autonomous agents discover and pay for AI services operated by recently verified, live humans.

This repository currently implements **Y00: repository foundation only**. Each workspace contains an empty TypeScript module and an import smoke test. There are no frontend pages, servers, shared domain contracts, payments, verification, AI, recipes, or database features yet.

## Setup

Use Node.js **22**, at least 22.18.0, and npm **10 or 11**. With nvm, run `nvm install` and `nvm use` from this directory.

```sh
npm install
npm run validate
```

For reproducible installation after cloning, use `npm ci`. The root lockfile covers all five npm workspaces. No environment variables or credentials are needed for Y00; `.env.example` is intentionally comments only. No production dependencies are installed.

## Commands

Run these from the repository root:

| Command                | Purpose                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `npm run lint`         | ESLint across source, tests, and JavaScript configuration; explicit `any` is an error             |
| `npm run typecheck`    | Strict TypeScript checking of source and tests in every workspace                                 |
| `npm test`             | Vitest import smoke tests in every workspace; missing tests fail                                  |
| `npm run build`        | Compile each workspace source to ESM JavaScript and declarations in its ignored `dist/` directory |
| `npm run format`       | Apply Prettier formatting                                                                         |
| `npm run format:check` | Check formatting without writing                                                                  |
| `npm run validate`     | Run formatting check, lint, typecheck, tests, and build in sequence; stop on failure              |

Root `npm run typecheck`, `npm test`, `npm run build`, and `npm run validate` automatically rebuild the shared package before consumers run. Use these documented root commands instead of directly invoking `npm run <command> --workspaces`.

Before running a single consumer workspace's typecheck, test, or build command from a fresh checkout, run `npm run prepare:shared`. For example, follow it with `npm run typecheck --workspace=@proofserve/api` (replace `api` as needed). Yhlas must rerun shared preparation after changing `packages/shared/src/**` before using consumer-only commands. Generated `dist` files remain ignored and must not be committed.

Build emits only source modules, not tests. The web workspace is a TypeScript placeholder; a frontend framework and pages are deferred. Smoke tests check entry-point loading without environment configuration and do not claim to test product behavior.

## Repository structure

```text
apps/
  web/                         Ilham: frontend workspace placeholder
  api/                         Yhlas: registry API workspace placeholder
  service/                     Yhlas: service workspace placeholder
  agent/                       Tugrahan: buyer-agent workspace placeholder
packages/
  shared/                      Yhlas: shared workspace; contracts deferred to Y01
recipes/                       Tugrahan: reserved recipe documentation
docs/                          Team context and documentation
.github/
  workflows/ci.yml             Node.js 22, npm ci, npm run validate
  pull_request_template.md     Task scope, checks, and review evidence
AGENTS.md                      Repository rules and ownership
CONTRIBUTING.md                 Development and review workflow
ATTRIBUTIONS.md                 Tooling and Codex disclosure
.env.example                   Environment documentation without secrets
.gitignore                     Dependencies, output, local env files, and key files
.editorconfig                  Shared editor conventions
.nvmrc                         Node.js 22 selection
package.json                   Root scripts and npm workspaces
package-lock.json              Reproducible dependency graph
tsconfig.base.json             Shared strict TypeScript settings
eslint.config.mjs              ESLint flat configuration
.prettierrc.json                Formatter settings
.prettierignore                Generated files and verbatim playbook exclusion
README.md                      Setup and repository map
```

Each workspace has `package.json`, `tsconfig.json`, `tsconfig.build.json`, `src/index.ts`, and `test/workspace.test.ts`. All packages are private. Strict checks include unchecked indexed access and exact optional property types. The supplied playbook is preserved verbatim and excluded from formatting.

## Team workflow

Read [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and the [team playbook](docs/ProofServe-Team-Build-Playbook.md). Later tasks are context only. Y01 must define `docs/api-contract.md` and shared contracts before dependent feature work starts.

CI runs validation on pull requests and pushes to `main`. Branch protection and collaborator invitations require manual GitHub setup by Yhlas. CODEOWNERS awaits confirmed teammate handles. Initial implementation requires human diff review before any commit, push, or pull request.
