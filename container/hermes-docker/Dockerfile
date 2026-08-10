# Derived Hermes Docker-backend worker image.
#
# Purpose: bake the slow, stable, universally-needed toolchain (apt base, Go,
# Node/pnpm, GitHub CLI) into an image so freshly-created worker containers are
# usable immediately with no runtime re-install delay. The companion setup.sh is
# the single source of truth: this image runs `setup.sh --build` (bakeable steps
# only); at container runtime the same script runs in its default mode, where the
# baked steps become instant no-op skips and only the mount/secret/env-dependent
# steps (Go cache dirs, git email, gh auth) do real work.
#
# Build (from this directory):
#   docker build -t hermes-worker:latest .
#
# Rebuild whenever you bump GO/NODE/PNPM versions in setup.sh or the base image
# publishes a new digest. Add a MANIFEST.md row when you do.
#
# Base image matches what the profiles used before deriving, so mount semantics,
# user (root), and /workspace layout are unchanged.
FROM nikolaik/python-nodejs:python3.11-nodejs20

# Toolchain versions are owned by setup.sh defaults; override at build time with
# --build-arg if you need a one-off pin without editing the script.
ARG HERMES_DOCKER_GO_VERSION
ARG HERMES_DOCKER_NODE_VERSION
ARG HERMES_DOCKER_PNPM_VERSION

# Bake the toolchain. Copy only setup.sh first so this layer caches independently
# of any other files in the build context.
COPY setup.sh /opt/hermes-docker/setup.sh
RUN chmod +x /opt/hermes-docker/setup.sh \
    && HERMES_DOCKER_GO_VERSION="${HERMES_DOCKER_GO_VERSION:-}" \
       HERMES_DOCKER_NODE_VERSION="${HERMES_DOCKER_NODE_VERSION:-}" \
       HERMES_DOCKER_PNPM_VERSION="${HERMES_DOCKER_PNPM_VERSION:-}" \
       bash /opt/hermes-docker/setup.sh --build \
    && rm -rf /var/lib/apt/lists/*

# Go cache/tmp config, baked as ENV rather than `go env -w`.
#
# Why ENV and not `go env -w`: with terminal.home_mode=auto the container's $HOME
# is a host-backed bind mount, so a go env file written at build time ($HOME/.config
# /go/env) is shadowed by the mount at runtime. Process ENV is not shadowed, so
# these win. Go auto-creates GOCACHE/GOMODCACHE on first use; setup.sh's runtime
# ensure_go_cache_dirs still pre-creates them (and GOTMPDIR, which Go does NOT
# auto-create) once /workspace/dev is mounted.
ENV GOTMPDIR=/workspace/dev/.cache/go-tmp \
    GOCACHE=/workspace/dev/.cache/go-build \
    GOMODCACHE=/workspace/dev/.cache/gomod

# Sanity: fail the build if any core tool is missing from the baked image.
RUN command -v go >/dev/null && command -v node >/dev/null \
    && command -v gh >/dev/null && command -v git >/dev/null \
    && go version && node --version && gh --version | head -1
