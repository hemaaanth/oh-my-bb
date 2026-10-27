#!/bin/sh
set -eu

# Docker Engine, Compose v2, and Buildx from Docker's official Debian
# repository. Sandbox providers differ in what their kernel allows: Daytona
# documents Docker-in-Docker, E2B and Freestyle run microVMs with a real
# kernel, and Modal only permits a daemon under its VM runtime. The image
# ships the daemon unconditionally; bb-sandbox-docker decides at runtime
# whether it can actually start and which storage driver works.

export DEBIAN_FRONTEND=noninteractive

install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error --location --retry 5 \
  https://download.docker.com/linux/debian/gpg \
  --output /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

codename="$(. /etc/os-release && printf '%s' "$VERSION_CODENAME")"
architecture="$(dpkg --print-architecture)"
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${codename}
Components: stable
Architectures: ${architecture}
Signed-By: /etc/apt/keyrings/docker.asc
EOF

apt-get update
apt-get install --yes --no-install-recommends \
  containerd.io \
  docker-buildx-plugin \
  docker-ce \
  docker-ce-cli \
  docker-compose-plugin

apt-get clean
rm -rf /var/lib/apt/lists/*
