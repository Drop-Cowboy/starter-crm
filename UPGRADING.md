# Upgrading

## What is supported

Security fixes go into the latest minor release. Older minors are not patched,
so upgrade to the latest before reporting a problem that a newer release may
already fix. Releases follow [semantic versioning](https://semver.org): a patch
release fixes bugs, a minor release adds features and changes nothing you
depend on, and a major release may break something and says so in
[`CHANGELOG.md`](CHANGELOG.md) under **Upgrading**. Read that section before you
move across a major version.

If you run a published image, upgrading is changing the tag (see
[`HOSTING.md`](HOSTING.md)). Deploy `:1.2.3`, not `:latest`, so a rollback is
deploying the previous number.

## Pulling upstream into your copy

Keep your own code where it is easy to separate from ours. The starter is built
so most changes go in provider files and, from a later release, in a `modules/`
folder, which upstream never touches:

| You change | Where | Upstream touches it? |
|---|---|---|
| Who the user is, secrets, rate limits, logs, observers | A provider file you point `DC_IDENTITY`, `DC_SECRETS`, `DC_RATE_LIMIT`, `DC_LOG`, `DC_OBSERVER` at | No |
| Settings | `.env`, your host's environment | No |
| Everything else in `server/`, `shared/`, `vanilla/`, `react/` | In place | Yes: expect conflicts |

To take a new release, add this repository as a second remote once, fetch its
tags, and merge the one you want:

```sh
git remote add upstream https://github.com/Drop-Cowboy/starter-crm.git
git fetch upstream --tags
git merge v1.3.0            # or: git rebase v1.3.0
```

Resolve conflicts in the files you changed, then run the checks:

```sh
npm test                    # unit, contract, browser and container tests
npm run test:leaks
```

`npm test` includes the server contract suite, so a change that breaks the
contract shows up there, not in production.

## Moving the Building Blocks version

The page loads Drop Cowboy Building Blocks from a pinned release, and checks
each file against the integrity hash that release publishes. To move to a newer
release, change one line in `.env` or your host's environment:

```sh
DC_CDN_VERSION=3.33.16
```

The page refuses a file whose hash does not match, so a wrong or tampered
bundle fails closed, with a plain message, instead of running. Open the app and
check each page (a call, a text, the Setup page) before you change it on a
production host. `latest` is refused, because integrity hashes need a fixed
release.

## Base images and dependencies

The Dockerfiles pin their base images by digest, and Dependabot proposes the
bumps. Rebuild and redeploy after merging one; the weekly image scan fails when
a high or critical vulnerability with a fix reaches a published image.
