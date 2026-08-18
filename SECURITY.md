# Security Policy

## Reporting a Vulnerability

Takumi is in early development; please report security issues privately by opening a GitHub issue with the `security` label, or email the maintainers directly. Do **not** open a public issue for active exploits.

## Scope

- Code execution in runtime adapters (Pi, future runtimes) — tasks run with the user's privileges; sandboxing is a roadmap item.
- Secret handling (API keys in `~/.pi/agent/auth.json`, env vars).
- Artifact store path traversal (artifact paths must stay under the store root).

## Safe practices for users

- Run `takumi run` only on projects you trust.
- API keys are read from the environment or `~/.pi/agent/`; never commit keys to a repository.
- `takumi init` creates local `.takumi/` state — add it to `.gitignore` unless you intend to share artifacts.