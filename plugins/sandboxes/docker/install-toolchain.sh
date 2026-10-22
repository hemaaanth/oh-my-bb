#!/bin/sh
set -eu

GO_VERSION="${GO_VERSION:-1.27.1}"
RUST_VERSION="${RUST_VERSION:-1.99.0}"
OP_VERSION="${OP_VERSION:-2.33.0-beta.02}"
BUN_VERSION="${BUN_VERSION:-1.4.2}"
DENO_VERSION="${DENO_VERSION:-2.9.7}"
NEXTEST_VERSION="${NEXTEST_VERSION:-latest}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends \
  ca-certificates \
  curl \
  gnupg
install -m 0755 -d /etc/apt/keyrings
curl --fail --location --retry 5 \
  https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  --output /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
printf '%s\n' \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt-get update
apt-get install --yes --no-install-recommends \
  bash \
  build-essential \
  clang \
  cmake \
  dnsutils \
  fd-find \
  file \
  fuse-overlayfs \
  fzf \
  gdb \
  gh \
  git \
  git-lfs \
  iproute2 \
  iptables \
  iputils-ping \
  jq \
  less \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdrm2 \
  libfuse2 \
  libgbm1 \
  libnss3 \
  libssl-dev \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  lsof \
  make \
  netcat-openbsd \
  ninja-build \
  openssh-client \
  patch \
  perl \
  pkg-config \
  postgresql-client \
  procps \
  protobuf-compiler \
  python3 \
  python3-pip \
  python3-venv \
  redis-tools \
  ripgrep \
  rsync \
  shellcheck \
  slirp4netns \
  socat \
  sqlite3 \
  strace \
  sudo \
  tmux \
  tree \
  uidmap \
  unzip \
  vim-tiny \
  wget \
  xz-utils \
  zip \
  zsh

architecture="$(dpkg --print-architecture)"
case "$architecture" in
  amd64)
    go_arch=amd64
    java_arch=x64
    bun_arch=x64
    deno_target=x86_64-unknown-linux-gnu
    ;;
  arm64)
    go_arch=arm64
    java_arch=aarch64
    bun_arch=aarch64
    deno_target=aarch64-unknown-linux-gnu
    ;;
  *)
    echo "Unsupported architecture for the bb toolchain: $architecture" >&2
    exit 1
    ;;
esac

go_archive="go${GO_VERSION}.linux-${go_arch}.tar.gz"
curl --fail --location --retry 5 \
  "https://go.dev/dl/${go_archive}" \
  --output "/tmp/${go_archive}"
# include=all keeps superseded patch releases in the feed, so a pinned version
# stays resolvable after a newer patch ships.
curl --fail --location --retry 5 \
  "https://go.dev/dl/?mode=json&include=all" \
  --output /tmp/go-releases.json
go_checksum="$(python3 - "$go_archive" /tmp/go-releases.json <<'PY'
import json
import sys

archive = sys.argv[1]
with open(sys.argv[2], encoding="utf-8") as releases_file:
    releases = json.load(releases_file)
for release in releases:
    for release_file in release["files"]:
        if release_file["filename"] == archive:
            print(release_file["sha256"])
            raise SystemExit(0)
raise SystemExit(f"No official Go checksum found for {archive}")
PY
)"
printf '%s  %s\n' "$go_checksum" "/tmp/${go_archive}" \
  | sha256sum --check --status
rm -rf /usr/local/go
tar -C /usr/local -xzf "/tmp/${go_archive}"

curl --fail --location --retry 5 \
  "https://api.adoptium.net/v3/binary/latest/21/ga/linux/${java_arch}/jdk/hotspot/normal/eclipse?project=jdk" \
  --output /tmp/temurin.tar.gz
rm -rf /opt/java
mkdir -p /opt/java
tar -C /opt/java --strip-components=1 -xzf /tmp/temurin.tar.gz
for executable in jar java javac javadoc javap; do
  ln -sf "/opt/java/bin/$executable" "/usr/local/bin/$executable"
done

export CARGO_HOME=/opt/rust/cargo
export RUSTUP_HOME=/opt/rust/rustup
curl --fail --location --retry 5 https://sh.rustup.rs --output /tmp/rustup.sh
sh /tmp/rustup.sh -y --no-modify-path --profile minimal \
  --default-toolchain "$RUST_VERSION"
"$CARGO_HOME/bin/rustup" component add clippy rustfmt
"$CARGO_HOME/bin/rustup" default "$RUST_VERSION"

nextest_asset="linux"
if [ "$architecture" = arm64 ]; then
  nextest_asset="linux-arm"
fi
curl --fail --location --retry 5 \
  "https://get.nexte.st/${NEXTEST_VERSION}/${nextest_asset}" \
  --output /tmp/cargo-nextest.tar.gz
tar -C "$CARGO_HOME/bin" -xzf /tmp/cargo-nextest.tar.gz cargo-nextest

bun_asset="bun-linux-${bun_arch}.zip"
curl --fail --location --retry 5 \
  "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${bun_asset}" \
  --output "/tmp/${bun_asset}"
curl --fail --location --retry 5 \
  "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/SHASUMS256.txt" \
  --output /tmp/bun-sha256sums.txt
bun_checksum="$(awk -v asset="$bun_asset" '$2 == asset { print $1 }' /tmp/bun-sha256sums.txt)"
if [ -z "$bun_checksum" ]; then
  echo "No official Bun checksum found for ${bun_asset}" >&2
  exit 1
fi
printf '%s  %s\n' "$bun_checksum" "/tmp/${bun_asset}" | sha256sum --check --status
rm -rf /opt/bun
mkdir -p /opt/bun/bin
unzip -q -j "/tmp/${bun_asset}" -d /opt/bun/bin
chmod 755 /opt/bun/bin/bun
ln -sf /opt/bun/bin/bun /opt/bun/bin/bunx

deno_asset="deno-${deno_target}.zip"
curl --fail --location --retry 5 \
  "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/${deno_asset}" \
  --output "/tmp/${deno_asset}"
curl --fail --location --retry 5 \
  "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/${deno_asset}.sha256sum" \
  --output /tmp/deno-sha256sum.txt
deno_checksum="$(awk '{ print $1; exit }' /tmp/deno-sha256sum.txt)"
printf '%s  %s\n' "$deno_checksum" "/tmp/${deno_asset}" | sha256sum --check --status
rm -rf /opt/deno
mkdir -p /opt/deno/bin
unzip -q -j "/tmp/${deno_asset}" -d /opt/deno/bin
chmod 755 /opt/deno/bin/deno

python3 -m pip install --break-system-packages --no-cache-dir uv
UV_PYTHON_INSTALL_DIR=/opt/python UV_PYTHON_BIN_DIR=/usr/local/bin \
  uv python install 3.13 --default --force

MISE_DATA_DIR="${MISE_DATA_DIR:-/opt/mise}"
export MISE_DATA_DIR
curl --fail --location --retry 5 https://mise.run --output /tmp/install-mise.sh
MISE_INSTALL_PATH=/usr/local/bin/mise sh /tmp/install-mise.sh
mise install "1password-cli@${OP_VERSION}"
# mise keeps its tools out of PATH by design; the sandbox needs a plain `op`.
printf '%s\n' \
  '#!/bin/sh' \
  "export MISE_DATA_DIR='$MISE_DATA_DIR'" \
  "exec mise x 1password-cli@${OP_VERSION} -- op \"\$@\"" \
  > /usr/local/bin/op
chmod 755 /usr/local/bin/op

ln -sf /usr/bin/fdfind /usr/local/bin/fd
for executable in cargo cargo-nextest clippy-driver rustc rustfmt rustup; do
  ln -sf "$CARGO_HOME/bin/$executable" "/usr/local/bin/$executable"
done
for executable in go gofmt; do
  ln -sf "/usr/local/go/bin/$executable" "/usr/local/bin/$executable"
done
for executable in bun bunx; do
  ln -sf "/opt/bun/bin/$executable" "/usr/local/bin/$executable"
done
ln -sf /opt/deno/bin/deno /usr/local/bin/deno
git lfs install --system

rm -f /tmp/bun-sha256sums.txt /tmp/cargo-nextest.tar.gz /tmp/deno-sha256sum.txt \
  /tmp/go-releases.json /tmp/install-mise.sh /tmp/omp /tmp/omp-sha256sums.txt \
  /tmp/rustup.sh /tmp/temurin.tar.gz \
  "/tmp/${bun_asset}" "/tmp/${deno_asset}" "/tmp/${go_archive}"
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.cache
