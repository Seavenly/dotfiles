#!/usr/bin/env bash
#
# Idempotent bootstrap for Hermes' default-profile Docker backend.
#
# Host path:      ~/.dotfiles/container/hermes-docker/setup.sh
# Container path: /workspace/.dotfiles/container/hermes-docker/setup.sh
#
# Why this exists: the default Hermes profile runs tools inside an ephemeral
# Debian Docker container. apt-installed binaries disappear when the container
# is recreated. Host-backed mounts such as /workspace/.dotfiles and /workspace/dev
# persist; keep the recovery recipe here and re-run it after refreshes.

set -euo pipefail

GO_VERSION="${HERMES_DOCKER_GO_VERSION:-go1.26.4}"
NODE_VERSION="${HERMES_DOCKER_NODE_VERSION:-v24.18.0}"
PNPM_VERSION="${HERMES_DOCKER_PNPM_VERSION:-11.0.6}"

log()  { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ ok ]\033[0m %s\n' "$*"; }
skip() { printf '\033[1;33m[skip]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;31m[warn]\033[0m %s\n' "$*"; }

load_env_if_present() {
  # Hermes normally injects ~/.hermes/.env into the tool process on session start.
  # This fallback makes manual docker exec runs behave similarly without printing secrets.
  for env_file in \
    "${HERMES_HOME:-$HOME/.hermes}/.env" \
    "/workspace/.dotfiles/hermes/.env"; do
    if [ -f "$env_file" ]; then
      set -a
      # shellcheck disable=SC1090
      . "$env_file"
      set +a
      ok "loaded env file: $env_file"
      return 0
    fi
  done
  skip "no Hermes .env file found; GitHub auth will rely on already-exported GH_TOKEN/GITHUB_TOKEN"
}

ensure_base_apt() {
  local pkgs=(ca-certificates curl gpg git jq less procps tar gzip xz-utils)
  local missing=()
  for p in "${pkgs[@]}"; do
    dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    skip "base apt packages present"
    return 0
  fi
  log "installing base apt packages: ${missing[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
  ok "base apt packages installed"
}

dpkg_arch_to_toolchain_arch() {
  case "$(dpkg --print-architecture)" in
    amd64) echo "amd64" ;;
    arm64) echo "arm64" ;;
    *)
      warn "unsupported architecture for official Go/Node tarballs: $(dpkg --print-architecture)"
      return 1
      ;;
  esac
}

ensure_go_toolchain() {
  local current=""
  current="$(go version 2>/dev/null | awk '{print $3}' || true)"
  if [ "$current" = "$GO_VERSION" ]; then
    skip "Go present: $(go version)"
  else
    local arch tmpdir tarball
    arch="$(dpkg_arch_to_toolchain_arch)"
    tmpdir="$(mktemp -d)"
    tarball="${GO_VERSION}.linux-${arch}.tar.gz"
    log "installing Go ${GO_VERSION} for linux/${arch}"
    curl -fsSLo "${tmpdir}/${tarball}" "https://go.dev/dl/${tarball}"
    rm -rf /usr/local/go
    tar -C /usr/local -xzf "${tmpdir}/${tarball}"
    ln -sf /usr/local/go/bin/go /usr/local/bin/go
    ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
    rm -rf "$tmpdir"
    ok "Go installed: $(go version)"
  fi
}

# Runtime-only: the Go cache/tmp dirs live on the host-backed /workspace/dev mount,
# which does not exist at image-build time. In the derived image these paths are set
# via ENV (GOTMPDIR/GOCACHE/GOMODCACHE) so they are not shadowed by the $HOME bind
# mount the way `go env -w` would be. Here we (a) create the dirs once the mount is
# present, and (b) also write them to the go env file as a self-healing fallback for
# containers started from the bare base image (no baked ENV).
ensure_go_cache_dirs() {
  if [ ! -d /workspace/dev ]; then
    skip "/workspace/dev not mounted; leaving Go caches at defaults"
    return 0
  fi
  # Some Hermes Docker backends mount /tmp with noexec. Keep Go's executable
  # test/build temp directory and caches on the host-backed /workspace/dev mount.
  mkdir -p /workspace/dev/.cache/go-tmp /workspace/dev/.cache/go-build /workspace/dev/.cache/gomod
  go env -w \
    GOTMPDIR=/workspace/dev/.cache/go-tmp \
    GOCACHE=/workspace/dev/.cache/go-build \
    GOMODCACHE=/workspace/dev/.cache/gomod >/dev/null
  ok "Go env uses executable, host-backed caches under /workspace/dev/.cache"
}

ensure_node_toolchain() {
  local current=""
  current="$(node --version 2>/dev/null || true)"
  if [ "$current" = "$NODE_VERSION" ]; then
    skip "Node present: ${current}"
  else
    local arch tmpdir tarball
    arch="$(dpkg_arch_to_toolchain_arch)"
    tmpdir="$(mktemp -d)"
    tarball="node-${NODE_VERSION}-linux-${arch}.tar.xz"
    log "installing Node ${NODE_VERSION} for linux/${arch}"
    curl -fsSLo "${tmpdir}/${tarball}" "https://nodejs.org/dist/${NODE_VERSION}/${tarball}"
    tar -C /usr/local --strip-components=1 -xJf "${tmpdir}/${tarball}"
    rm -rf "$tmpdir"
    ok "Node installed: $(node --version)"
  fi

  corepack enable
  corepack prepare "pnpm@${PNPM_VERSION}" --activate >/dev/null
  ok "pnpm prepared: $(COREPACK_ENABLE_PROJECT_SPEC=0 pnpm --version)"
}

ensure_gh_cli() {
  if command -v gh >/dev/null 2>&1; then
    skip "gh present: $(gh --version | head -1)"
  else
    log "installing GitHub CLI"
    mkdir -p -m 755 /usr/share/keyrings
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y gh
    ok "gh installed: $(gh --version | head -1)"
  fi
}

ensure_git_identity() {
  # Override these via env if a repo needs something else:
  #   HERMES_GIT_USER_NAME="..." HERMES_GIT_USER_EMAIL="..." bash setup.sh
  local name="${HERMES_GIT_USER_NAME:-Nathan Schott}"
  local email="${HERMES_GIT_USER_EMAIL:-}"

  if [ -z "$(git config --global user.name 2>/dev/null || true)" ]; then
    git config --global user.name "$name"
    ok "git user.name set"
  else
    skip "git user.name already set: $(git config --global user.name)"
  fi

  if [ -n "$email" ]; then
    if [ -z "$(git config --global user.email 2>/dev/null || true)" ]; then
      git config --global user.email "$email"
      ok "git user.email set"
    else
      skip "git user.email already set: $(git config --global user.email)"
    fi
  else
    warn "HERMES_GIT_USER_EMAIL unset; leaving git user.email unchanged"
  fi
}

ensure_github_auth() {
  # gh auto-detects GH_TOKEN/GITHUB_TOKEN. We prefer env-token auth so a fresh
  # container does not require interactive gh auth login.
  local token_present="no"
  if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ]; then
    token_present="yes"
  fi

  if [ "$token_present" = "yes" ]; then
    ok "GitHub token env is present (value intentionally hidden)"
    # setup-git configures git to use gh as credential helper; it is safe to retry.
    gh auth setup-git >/dev/null 2>&1 || warn "gh auth setup-git failed; gh API commands may still work via token env"
    if gh auth status >/dev/null 2>&1; then
      ok "gh auth status succeeds"
    else
      warn "gh auth status did not succeed; verify token scopes and env injection"
      gh auth status 2>&1 | sed 's/[A-Za-z0-9_][A-Za-z0-9_\-]*_TOKEN=.*/TOKEN=<redacted>/' || true
    fi
  else
    warn "No GH_TOKEN/GITHUB_TOKEN in env. Private PRs will be inaccessible until ~/.hermes/.env defines one and the default profile session is restarted."
  fi
}

verify_mounts() {
  log "runtime boundary"
  printf '  user: %s\n' "$(whoami)"
  printf '  home: %s\n' "$HOME"
  printf '  pwd:  %s\n' "$PWD"
  for p in /workspace/.dotfiles /workspace/dev /workspace/notes /root; do
    if [ -e "$p" ]; then
      printf '  mount candidate exists: %s\n' "$p"
    fi
  done
}

main() {
  local mode="${1:-runtime}"

  case "$mode" in
    --build|build)
      # Image-build time: bake the slow, stable, secret-free, mount-independent
      # toolchain into the derived image. No mounts exist yet, so skip anything
      # that touches /workspace or needs forwarded secrets (git email, gh auth,
      # Go cache dirs). git user.name is a generic, non-secret default and is safe
      # to bake; email stays env-driven at runtime.
      log "starting Hermes Docker image bake (build mode)"
      ensure_base_apt
      ensure_go_toolchain
      ensure_node_toolchain
      ensure_gh_cli
      HERMES_GIT_USER_EMAIL="" ensure_git_identity
      ok "image bake complete"
      ;;
    *)
      # Runtime: full idempotent pass. Baked steps become instant skips; the
      # mount- and secret-dependent steps (Go caches, git email, gh auth) do the
      # real work here. Safe to run against either the derived image or the bare
      # base image.
      log "starting Hermes Docker backend bootstrap (runtime mode)"
      verify_mounts
      load_env_if_present
      ensure_base_apt
      ensure_go_toolchain
      ensure_go_cache_dirs
      ensure_node_toolchain
      ensure_gh_cli
      ensure_git_identity
      ensure_github_auth
      ok "bootstrap complete"
      ;;
  esac
}

main "$@"
