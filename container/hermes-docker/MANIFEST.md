# Hermes default Docker backend bootstrap ledger

This ledger tracks host-independent setup needed inside the Hermes **default** profile Docker backend. The companion script is the source of truth:

```text
Host:      ~/.dotfiles/container/hermes-docker/setup.sh
Container: /workspace/.dotfiles/container/hermes-docker/setup.sh
```

Run it after a Docker backend refresh/rebuild:

```bash
bash /workspace/.dotfiles/container/hermes-docker/setup.sh
```

## Boundary / persistence model

- `default` profile terminal backend: Docker.
- Container image: **`hermes-worker:latest`** — a derived image built from `Dockerfile` in this directory, which bakes the slow/stable toolchain (apt base, Go, Node/pnpm, gh) on top of `nikolaik/python-nodejs:python3.11-nodejs20`. Build with `docker build -t hermes-worker:latest .` from this directory. Rebuild after bumping GO/NODE/PNPM versions in `setup.sh` or when the base image publishes a new digest.
- Container user/home observed: `root`, `/root`.
- Host-backed mounts observed from an active Hermes container:
  - `~/.dotfiles` → `/workspace/.dotfiles`
  - `~/dev` → `/workspace/dev`
  - `~/notes` → `/workspace/notes`
  - `~/.hermes/sandboxes/docker/default/home` → `/root`
  - `~/.hermes/agent-teams-skills` → `/root/.hermes/external_skills/0` read-only
  - `~/.hermes/skills` → `/root/.hermes/skills` read-only
- apt-installed binaries and toolchains baked into `hermes-worker:latest` are durable **for the life of that image**; they are re-baked by rebuilding the image, not re-installed at runtime. A fresh container from the derived image already has them. Runtime `setup.sh` (default mode) is now a fast self-healing fallback: baked steps become instant `[skip]`s, and only mount/secret-dependent steps (Go cache dirs, git email, gh auth) do real work.
- Files under `/workspace/.dotfiles`, `/workspace/dev`, `/workspace/notes`, and `/root` are host-backed and should survive normal container refreshes.
- **Cross-process container reuse differs by profile.** `default`/admin-orchestration keeps `docker_persist_across_processes: true` (long-lived container; background processes survive across sessions). The six `at-*` workers set `docker_persist_across_processes: false` so every dispatch gets a fresh container off the current image+config — this structurally prevents the stale-container class of bug (see the "Stale persistent container" troubleshooting note). Trade-off: `at-*` no longer keep background processes between runs (irrelevant for bounded one-artifact tasks) and the idle reaper is active for them.

## Setup inventory

| Date | Item | Why | Rebuild mechanism | Verification |
| --- | --- | --- | --- | --- |
| 2026-07-01 | Base apt packages: `ca-certificates`, `curl`, `gpg`, `git`, `jq`, `less`, `procps`, `tar`, `gzip`, `xz-utils` | Needed by bootstrap, GitHub CLI repo setup, official Go/Node tarball installs, diagnostics, and normal review work. | `ensure_base_apt` in `setup.sh` | `dpkg -s <pkg>` |
| 2026-07-01 | GitHub CLI `gh` | `at-review` validates PRs, fetches diffs, clones repos, and can prepare pending reviews through GitHub. | `ensure_gh_cli` in `setup.sh` | `gh --version` |
| 2026-07-01 | Git identity defaults | Prevents commits from failing in worker/review flows when a global identity is needed. Email is intentionally env-driven. | `ensure_git_identity` in `setup.sh` | `git config --global user.name`, `git config --global user.email` |
| 2026-07-01 | GitHub token env detection / `gh auth setup-git` | Private PR access should be driven by `GH_TOKEN`/`GITHUB_TOKEN` from the default profile `.env`, not one-off interactive login inside a disposable container. | `ensure_github_auth` in `setup.sh`; define token in `~/.hermes/.env`; restart default profile session/container. | `gh auth status`, `gh pr view <num> --repo <owner/name>` |
| 2026-07-01 | Worker profile Docker mounts/env forwarding | `at-review` fans out to `at-*` Docker workers that must see the same `/workspace/.dotfiles`, `/workspace/dev`, `/workspace/notes`, and GitHub token env as the default profile. | Added `docker_volumes`, `docker_forward_env`, `docker_image`, and `docker_mount_cwd_to_workspace: false` to all six `profiles/at-*/config.yaml` files. Restart worker containers/sessions after config changes. | In a fresh worker container: `test -d /workspace/dev && test -d /workspace/.dotfiles`; `command -v gh` after bootstrap; token present after `.env` restart. |
| 2026-07-02 | Go toolchain `go1.26.4` from official linux tarball | The base Docker image has no Go, and Go repos with `go 1.26.x` cannot build/test without a matching modern toolchain. Debian trixie apt only offered Go 1.24 at inspection time. | `ensure_go_toolchain` in `setup.sh`; override with `HERMES_DOCKER_GO_VERSION=goX.Y.Z` if needed. | `go version`; package tests in a Go repo. |
| 2026-07-02 | Go executable temp/cache config under `/workspace/dev/.cache` | This container's `/tmp` can be non-executable for Go test binaries (`fork/exec /tmp/go-build... permission denied`). Host-backed `/workspace/dev` is executable and survives refreshes. | Baked as `ENV GOTMPDIR/GOCACHE/GOMODCACHE` in the derived image (ENV is not shadowed by the `$HOME` bind mount the way a build-time `go env -w` file would be); `ensure_go_cache_dirs` in `setup.sh` (runtime) pre-creates the dirs once `/workspace/dev` is mounted and re-writes them via `go env -w` as a bare-base fallback. | `go env GOTMPDIR GOCACHE GOMODCACHE`; `go test ./...` no longer fails with `/tmp/go-build` permission errors. |
| 2026-07-02 | **Derived worker image `hermes-worker:latest`** | Hermes has no post-create/init hook and `at-*` workers are bounded one-artifact tasks that won't reliably stop to re-bootstrap Go/Node mid-run (a review run's tests/correctness workers reported "go toolchain not installed; static review only"). Baking the toolchain makes every fresh container immediately usable with no runtime install delay. | `Dockerfile` in this dir: `FROM nikolaik/python-nodejs:python3.11-nodejs20`, `COPY setup.sh`, `RUN bash setup.sh --build` (bakeable steps only), bakes Go-cache ENV, verifies tools. Build: `docker build -t hermes-worker:latest .`. `setup.sh` remains the single source of truth (build + runtime consumers). Rebuild on toolchain/base bumps. | `docker run --rm -v ~/dev:/workspace/dev hermes-worker:latest bash -lc 'go version; node --version; pnpm --version; gh --version; go env GOCACHE'` — all present, cache points at `/workspace/dev/.cache`. |
| 2026-07-02 | **Per-profile `docker_persist_across_processes`** | Cross-process container reuse + no auto-recreate-on-config-change = silently stale containers (a pre-config-change `at-critic` container survived every gateway restart and kept failing a review run with no `/workspace/dev` mount). Workers need freshness over background-process survival. | `at-*` profiles: `docker_persist_across_processes: false` (fresh container per dispatch, always current image+config). `default`: explicit `true` (keeps long-lived container for background processes). admin is `backend: local` — unaffected. | `docker inspect <at-* container>`: born after the last config/image change; `/workspace/dev` present in Mounts. `default` container persists across `/quit`. |
| 2026-07-02 | Anthropic auth for all six `at-*` worker profiles (`ANTHROPIC_TOKEN` in each profile `.env`) | Dispatched `at-review` workers first crashed with "No inference provider configured" (empty Anthropic credential pool, no key in `.env` — only the default profile carried the Claude OAuth credential). After adding a key they then crashed with `HTTP 401: invalid x-api-key`. Root cause of the 401: a Claude subscription **OAuth/setup token** (`sk-ant-oat*`) must be sent as `Authorization: *** + `anthropic-beta: oauth-2025-04-20`, but at runtime a value placed in `ANTHROPIC_API_KEY` is routed down the `x-api-key` path and rejected. Hermes persists OAuth/setup tokens in **`ANTHROPIC_TOKEN`**, not `ANTHROPIC_API_KEY`. | Put the `sk-ant-oat*` token in `ANTHROPIC_TOKEN=<token>` (NOT `ANTHROPIC_API_KEY`) in `profiles/at-{builder,critic,diagrammer,planner,researcher,synthesizer}/.env`. Reserve `ANTHROPIC_API_KEY` for real Console API keys (`sk-ant-api*`). `.env` files are gitignored. | Per profile: `grep -c '^ANTHROPIC_TOKEN=sk-ant-oat' .env` = 1 and `ANTHROPIC_API_KEY` absent. Live token check: `curl -H "authorization: Bearer ***" -H "anthropic-version: 2023-06-01" -H "anthropic-beta: oauth-2025-04-20" https://api.anthropic.com/v1/messages -d '{...}'` returns 200 or 429 (valid; 429=rate-limited), NOT 401. Sending the same token as `x-api-key` returns 401 — that is the failure signature to watch for. |

## GitHub auth policy

Preferred: put a fine-grained or classic PAT in the **default profile** env file:

```text
~/.hermes/.env
GH_TOKEN=<token>
# or GITHUB_TOKEN=<token>
```

Notes:

- `~/.hermes` is symlinked into `.dotfiles/hermes`; `.env` is ignored by git.
- Use the least scopes that support the intended work. For private PR review, read access to repository contents/pull requests is enough for viewing/diffing; posting pending reviews requires pull-request write permission.
- After adding/changing `.env`, restart the default-profile Hermes session/container so the process env is injected.
- Do not commit tokens, `auth.json`, `hosts.yml`, or `~/.config/gh` files.

## Current reconstructed state

On 2026-07-01, inspection found multiple active `hermes-*` containers:

- One had `gh` installed but no auth.
- Others did not have `gh` installed.
- No active container had `GH_TOKEN`/`GITHUB_TOKEN` in env.
- Default profile `.env` did not exist yet.
- Host `~/.config/gh/hosts.yml` existed, but it did not contain a directly readable `oauth_token`; likely host-keychain-backed or stale for this purpose.

Conclusion: previous work confirmed some pieces of the Docker setup, but the reproducible ledger files were missing. This directory recreates the ledger and bootstrap script.

## Troubleshooting: Kanban worker containers

### Stale duplicate dispatcher spawns unmounted worker containers
**Symptom.** Some `at-*` kanban workers on the same board succeed while others fail or block — inconsistently, task-to-task. A blocked worker reports its container is empty: `/workspace/dev/.agent-teams/runs/.../` (brief, pr.diff, repo/, out/findings/*.json) "does not exist / isn't mounted here," even though the profile `config.yaml` has the correct `docker_volumes` and other workers on the same board clearly wrote those files.

**Root cause.** `kanban.dispatch_in_gateway: true`, so every running gateway process runs its own dispatcher. If an **old gateway is still alive from before a profile config change** (e.g. before `docker_volumes` were added to the `at-*` profiles), there are two dispatchers claiming tasks on the same host. The stale one spawns worker containers with its cached pre-change config (no `/workspace/dev` bind mount); the current one spawns correctly-mounted containers. Which dispatcher claims a given task is a race, so success is intermittent. Tell them apart by the `claimer` field in the task's events (`kanban show <task>`): two distinct `HOST:PID` claimers = two dispatchers. The lower/older PID is usually the stale one.

**Fix.** Restart the gateway so only one dispatcher (with current config) remains:

```bash
hermes gateway restart      # or: hermes gateway stop && hermes gateway start
hermes gateway status       # confirm a single gateway/dispatcher
```

Then `hermes kanban unblock <task_id>` (or re-run the flow). New worker containers pick up the current `docker_volumes` mounts. This is the operational half of the 2026-07-01 ledger note "Restart worker containers/sessions after config changes" — the restart must also clear stale **gateway** processes, not just idle worker containers.

### Stale persistent container ignores config/image changes (gateway restart does NOT fix it)
**Symptom.** One `at-*` role fails *consistently* (not intermittently) while others succeed. The blocked worker's `/proc/mounts` shows only the read-only skills mounts and empty `/workspace` + `/root` — no `/workspace/dev` bind — even though the profile `config.yaml` has correct `docker_volumes`. **A `hermes gateway restart` does not fix it.**

**Root cause.** `docker_persist_across_processes: true` (the old global default) makes Hermes reuse a long-lived container via a label probe, and **Hermes has no "recreate if image/config changed" logic**. A container born *before* a config change (e.g. before `docker_volumes` were added, or before the image was swapped to `hermes-worker:latest`) keeps being reused with its original mounts/image. Because the container outlives the gateway process, restarting the gateway changes nothing. Confirm with `docker inspect <container> --format '{{.Created}}'` (born before the config edit) and its `Mounts` (no `/workspace/dev`). This — not the dual-dispatcher race above — was the actual cause of that review run's `at-critic` failures: its container had been "Up 18h" since before the config edit.

**Fix (now structural).** The `at-*` profiles now set `docker_persist_across_processes: false`, so each dispatch gets a fresh container off the current image+config and this cannot recur. If you ever see a stale container anyway (e.g. on `default`, which keeps persistence), force recreation:

```bash
docker ps -a --filter "label=hermes-profile=<profile>" --format '{{.ID}} {{.Names}} {{.CreatedAt}}'
docker rm -f <stale container id>     # next dispatch/tool-call rebuilds from current image+config
```

Running containers are never auto-reaped (sibling-process safety), so recreation after an image bump or config change on a persistent profile is always a manual `docker rm -f`.

## Maintenance rule

Whenever a new package/tool/config is added inside the Docker backend:

1. Add an idempotent `ensure_*` function to `setup.sh`, and decide bake-vs-runtime: slow/stable/secret-free/mount-independent steps go in the `--build` path (baked into the image); secret/mount/env-dependent steps stay in the runtime path.
2. Add a row to this manifest with date, purpose, rebuild mechanism, and verification.
3. If the step is baked, **rebuild the image**: `docker build -t hermes-worker:latest ~/.dotfiles/container/hermes-docker`. Then recreate persistent containers (`default`) with `docker rm -f`; `at-*` workers pick it up on next dispatch automatically (non-persistent).
4. Run `setup.sh` once in the default Docker backend to confirm the runtime path is clean.
5. Commit the Dockerfile, script, and manifest to `.dotfiles`.
