# Security

## Report a Vulnerability

Please report security issues privately. Provide a minimal reproduction so we
can verify and fix before disclosure.

## Known Security Baseline

**Status: Developer Preview — not yet audited for production hardening.**

- **API keys / credentials**: runtime credentials (e.g. `OPENCODE_GO_API_KEY`)
  are read from the process environment, never committed. `.env` and
  `.pi/` are git-ignored. Never put keys in workflow YAML, prompts, artifact
  content, or the audit log.
- **Path traversal**: `ArtifactStore` rejects artifact `kind`/`fileName` that
  resolve outside the store root (Gate 20 test).
- **Artifact/audit writes**: audit logs are best-effort and contain only run
  metadata + event strings; review for sensitive prompts before sharing.
- **Plugins**: plugins (skills/tools/workflows/runtimes) are **trusted local
  code** and run with the same privileges as the user. There is **no
  sandboxing** in this MVP — do not run untrusted extensions (Gate 21).
- **Command injection**: the `cli:<command>` runtime bridge spawns the given
  command directly (shell:false) with the user's env; only bridge commands
  you trust.

## Tools running live agents

Running the real Pi runtime executes an autonomous coding agent that can
read/write files and run shell commands in the project directory. Only run it
on projects, and with prompts, you trust.
