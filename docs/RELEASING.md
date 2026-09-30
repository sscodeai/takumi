# Releasing Takumi

Takumi is not published to npm yet. This file records exactly what is already prepared,
what is still blocked, and on what.

## The two blockers (both are human decisions, not code)

### 1. The CLI's npm name is taken

```
$ npm view takumi version
0.8.2          # published by somebody else
```

So the CLI cannot ship as `takumi`. Two options:

- **`@sscodeai/takumi`** (recommended): create the free npm organisation `sscodeai`, then
  rename the root package to `@sscodeai/takumi` and keep the `bin` name `takumi`. Publishing a
  scoped package needs `--access public`, which the workflow already passes.
- **`takumi-cli`**: unscoped, no organisation needed — check availability before you commit to
  it (`npm view takumi-cli version`).

The ~20 workspace packages under the `@takumi/*` scope are unaffected: the scope has no
published packages (`npm view @takumi/core` is a 404), but it must still be created as an
organisation or user scope before the first publish.

### 2. An npm token, as the repository secret `NPM_TOKEN`

Create an automation token for the account that owns the scope, then add it as
`NPM_TOKEN` under *Settings → Secrets and variables → Actions*. The workflow fails with a
named error if it is missing.

## What is already prepared

- Every publishable package carries `license`, `repository` (with `directory`), `homepage`,
  `bugs`, `files` and `publishConfig.access: public` — 20 packages in total.
- `.github/workflows/release.yml`: a `v*` tag always **verifies** the tagged tree (install,
  build, test, typecheck), and a separate `publish` job stays **inert** until the repository
  variable `PUBLISH_ENABLED` is `true`. When it does run it refuses to publish at all if the
  root package is still `private` (half a workspace is worse than none). So tagging today
  produces a green verification and a skipped publish, never a false release.
- The root package keeps `private: true` on purpose, so nothing can be published by accident
  before the name decision is made.

## The release flow (once both blockers are cleared)

```bash
# 1. one decision: the CLI's name (see above), then
#    - rename "name" in package.json, drop "private": true

# 2. the whole workspace moves together: pnpm rewrites `workspace:*` at pack time
pnpm -r exec npm version 1.0.0 --no-git-tag-version
git commit -am "chore(release): 1.0.0"
git push

# 3. tag the tree you tested
git tag -a v1.0.0 -m "Takumi 1.0.0"
git push origin v1.0.0          # -> release.yml runs tests, then publishes

# 4. verify from the outside, not from the log
npm view @sscodeai/takumi version
npx @sscodeai/takumi --help
```

A local dry run packing every package without publishing:

```bash
pnpm -r publish --access public --no-git-checks --dry-run
```

## Versioning rules

- Every package in the workspace shares one version. `pnpm -r publish` refuses a package
  whose dependencies are already published at a different version, which is what keeps the
  set consistent.
- The tag is the release: `vX.Y.Z` on a commit that exists on `dev` (or `main`).
- A fix that only touches a leaf package still moves the whole set — the alternative
  (independent versions) buys nothing at this size.
