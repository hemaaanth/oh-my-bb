FROM node:22-bookworm-slim

# Node 22 supplies the shared runtime for BB and development tools.

ARG BB_APP_VERSION=latest
# Lets the plugin read the bb-app a CI-built image carries without pulling it.
LABEL bb.app.version="${BB_APP_VERSION}"
ARG GO_VERSION=1.27.1
ARG RUST_VERSION=1.99.0
ARG OP_VERSION=2.33.0-beta.02
ARG BUN_VERSION=1.4.2
ARG DENO_VERSION=2.9.7

COPY install-toolchain.sh /tmp/install-toolchain.sh
RUN chmod 755 /tmp/install-toolchain.sh \
  && GO_VERSION="${GO_VERSION}" RUST_VERSION="${RUST_VERSION}" \
     OP_VERSION="${OP_VERSION}" BUN_VERSION="${BUN_VERSION}" DENO_VERSION="${DENO_VERSION}" \
     /tmp/install-toolchain.sh \
  && rm /tmp/install-toolchain.sh

# bb:extra-packages

COPY install-containers.sh /tmp/install-containers.sh
RUN chmod 755 /tmp/install-containers.sh \
  && /tmp/install-containers.sh \
  && rm /tmp/install-containers.sh

COPY install-env-managers.sh /tmp/install-env-managers.sh
RUN chmod 755 /tmp/install-env-managers.sh \
  && /tmp/install-env-managers.sh \
  && rm /tmp/install-env-managers.sh

COPY install-cloud-clis.sh /tmp/install-cloud-clis.sh
RUN chmod 755 /tmp/install-cloud-clis.sh \
  && /tmp/install-cloud-clis.sh \
  && rm /tmp/install-cloud-clis.sh

COPY install-agent-clis.sh /tmp/install-agent-clis.sh
RUN chmod 755 /tmp/install-agent-clis.sh \
  && /tmp/install-agent-clis.sh \
  && rm /tmp/install-agent-clis.sh

COPY install-visual-capture.sh /tmp/install-visual-capture.sh
RUN chmod 755 /tmp/install-visual-capture.sh \
  && /tmp/install-visual-capture.sh \
  && rm /tmp/install-visual-capture.sh

# Empty means the pin in install-harnesses.sh, whose `${VAR:-pin}` treats an
# empty value as unset. Declared here rather than at the top so a harness bump
# only rebuilds the layers from this point on.
ARG OMP_VERSION=
ARG CLAUDE_CODE_VERSION=
ARG CODEX_VERSION=
ARG FX_VERSION=
ARG PI_VERSION=1.2.0
ARG PRIME_AGENT_VERSION=0.10.0
ARG ADAPTERS_REF=55bc645da12c679fb4c1f8ac569a07be44a75914
ARG FX_ACP_SHA256=
ARG NANOCODEX_ACP_SHA256=
ARG PRIME_AGENT_ACP_SHA256=
COPY install-gateway-harnesses.sh /usr/local/lib/bb-sandbox/install-gateway-harnesses.sh
RUN sh /usr/local/lib/bb-sandbox/install-gateway-harnesses.sh
COPY install-harnesses.sh /tmp/
RUN chmod 755 /tmp/install-harnesses.sh \
  && BB_APP_VERSION="${BB_APP_VERSION}" /tmp/install-harnesses.sh \
  && rm /tmp/install-harnesses.sh \
  && rm -rf /root/.cache /root/.npm
RUN npm install --global pnpm@latest \
  && pnpm --version \
  && npm cache clean --force \
  && rm -rf /root/.cache /root/.npm

ENV JAVA_HOME="/opt/java"
ENV CARGO_HOME="/opt/rust/cargo"
ENV RUSTUP_HOME="/opt/rust/rustup"
ENV UV_PYTHON_INSTALL_DIR="/opt/python"
ENV UV_PYTHON_BIN_DIR="/usr/local/bin"
ENV BUN_INSTALL="/opt/bun"
ENV DENO_INSTALL="/opt/deno"
# omp's browser tool and anything else on Puppeteer would download a second
# Chromium without this, and plain agent-browser would look for Chrome; both
# use Brave instead. VHS's own headless browser cannot sandbox itself as root;
# cua defaults to sending telemetry and checking for updates.
ENV PUPPETEER_EXECUTABLE_PATH="/usr/local/bin/chromium"
ENV AGENT_BROWSER_EXECUTABLE_PATH="/usr/bin/brave-browser"
ENV VHS_NO_SANDBOX="true"
ENV CUA_DRIVER_RS_TELEMETRY_ENABLED="false"
ENV CUA_DRIVER_RS_UPDATE_CHECK="false"
ENV NIX_CONFIG="experimental-features = nix-command flakes"
ENV PATH="/opt/bb-agent-shims:/usr/local/go/bin:/opt/rust/cargo/bin:/opt/java/bin:/opt/bun/bin:/opt/deno/bin:/nix/var/nix/profiles/default/bin:${PATH}"
RUN mkdir --parents /root/.bb /workspace
COPY entrypoint.sh /usr/local/bin/bb-sandbox-entrypoint
COPY preview-supervisor.mjs /usr/local/bin/bb-sandbox-preview
COPY browser-runtime.tar /tmp/browser-runtime.tar
RUN mkdir -p /opt/bb-browser && tar -xf /tmp/browser-runtime.tar -C /opt/bb-browser \
  && ln -s /opt/bb-browser/docker/trusted-browser.mjs /usr/local/bin/bb-browser \
  && rm /tmp/browser-runtime.tar
COPY docker-start.sh /usr/local/bin/bb-sandbox-docker
COPY display-start.sh /usr/local/bin/bb-sandbox-display
COPY computer-start.sh /usr/local/bin/bb-sandbox-computer
COPY capture.sh /usr/local/bin/bb-sandbox-capture
COPY attach.sh /usr/local/bin/bb-sandbox-attach
COPY smoke-test.sh /usr/local/bin/bb-sandbox-smoke-test
COPY agent-guard.sh /usr/local/bin/bb-sandbox-agent-guard
COPY agent-shim.sh /usr/local/bin/bb-sandbox-agent-shim
RUN chmod 755 /usr/local/bin/bb-sandbox-entrypoint /usr/local/bin/bb-sandbox-preview \
  /usr/local/bin/bb-sandbox-docker /usr/local/bin/bb-sandbox-display \
  /usr/local/bin/bb-sandbox-computer /usr/local/bin/bb-sandbox-capture \
  /usr/local/bin/bb-sandbox-attach /usr/local/bin/bb-sandbox-smoke-test \
  /usr/local/bin/bb-sandbox-agent-guard /usr/local/bin/bb-sandbox-agent-shim \
  /usr/local/bin/bb-browser
# Worker agents run through a shim that hands the kernel a victim other than
# the host daemon. Only the names that exist get one, so a CLI dropping out of
# the image cannot break every launch.
RUN mkdir --parents /opt/bb-agent-shims \
  && for name in omp claude codex fx; do \
       if [ -e "/usr/local/bin/$name" ]; then \
         ln -sf /usr/local/bin/bb-sandbox-agent-shim "/opt/bb-agent-shims/$name"; \
       fi; \
     done

# `bb sandbox upgrade` reads these without pulling the image. CI always passes
# the resolved versions, so an empty label means a build outside that path.
LABEL bb.harness.omp="${OMP_VERSION}" \
  bb.harness.claude-code="${CLAUDE_CODE_VERSION}" \
  bb.harness.codex="${CODEX_VERSION}" \
  bb.harness.fx="${FX_VERSION}" \
  bb.harness.pi="${PI_VERSION}" \
  bb.harness.prime-agent="${PRIME_AGENT_VERSION}" \
  bb.harness.fx-acp="${FX_ACP_SHA256}" \
  bb.harness.nanocodex-acp="${NANOCODEX_ACP_SHA256}" \
  bb.harness.prime-agent-acp="${PRIME_AGENT_ACP_SHA256}" \
  bb.adapters.ref="${ADAPTERS_REF}"

CMD ["bb-sandbox-entrypoint"]
