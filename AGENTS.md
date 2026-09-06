# Repository rules

- Never push directly to main.
- One task equals one branch and one pull request.
- Read docs/api-contract.md before changing shared contracts. Y01 will create it; do not invent contracts before Y01 is merged.
- Do not modify another team member’s owned folder silently. Coordinate with the owner and open an issue for cross-owner changes.
- Never commit secrets or private keys.
- Never use TypeScript any to hide errors.
- Do not implement fake payment or fake verification success.
- Run validation before requesting review: `npm run validate`.
- Do not add production dependencies without explaining why.
- Implement only the task explicitly authorized by the current request. Later playbook tasks are context only.
- Stop after the initial implementation and validation for human diff review. Do not commit, push, or create a pull request without explicit authorization.

## Ownership

- Yhlas: root configuration, `packages/shared/`, `apps/api/`, `apps/service/`, `.github/`.
- Tugrahan: `apps/agent/`, `recipes/`, `docs/bazantic-*`.
- Ilham: `apps/web/`, `docs/wireframes/`, `docs/demo-*`, `docs/world-feedback.md`.

The team playbook lives in `docs/ProofServe-Team-Build-Playbook.md`.
