#!/bin/sh
set -eu

# Cloud and data CLIs that repositories shell out to directly: AWS SSO logins,
# kubectl/Helm for cluster-backed dev flows, Doppler for secret-injected dev
# servers, and DuckDB for local analytics commands.

DOPPLER_VERSION="${DOPPLER_VERSION:-3.76.5}"
DUCKDB_VERSION="${DUCKDB_VERSION:-1.5.5}"
HELM_VERSION="${HELM_VERSION:-3.21.4}"

architecture="$(dpkg --print-architecture)"
case "$architecture" in
  amd64)
    aws_arch=x86_64
    go_arch=amd64
    kubectl_arch=amd64
    ;;
  arm64)
    aws_arch=aarch64
    go_arch=arm64
    kubectl_arch=arm64
    ;;
  *)
    echo "Unsupported architecture for the cloud CLIs: $architecture" >&2
    exit 1
    ;;
esac

curl --fail --location --retry 5 \
  "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip" \
  --output /tmp/awscliv2.zip
rm -rf /tmp/aws
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install --update --install-dir /opt/aws-cli --bin-dir /usr/local/bin

kubectl_version="$(curl --fail --location --retry 5 --silent https://dl.k8s.io/release/stable.txt)"
kubectl_release="https://dl.k8s.io/release/${kubectl_version}/bin/linux/${kubectl_arch}"
curl --fail --location --retry 5 "${kubectl_release}/kubectl" --output /tmp/kubectl
curl --fail --location --retry 5 "${kubectl_release}/kubectl.sha256" \
  --output /tmp/kubectl.sha256
printf '%s  %s\n' "$(cat /tmp/kubectl.sha256)" /tmp/kubectl | sha256sum --check --status
install -m 755 /tmp/kubectl /usr/local/bin/kubectl

helm_archive="helm-v${HELM_VERSION}-linux-${kubectl_arch}.tar.gz"
curl --fail --location --retry 5 "https://get.helm.sh/${helm_archive}" \
  --output "/tmp/${helm_archive}"
curl --fail --location --retry 5 "https://get.helm.sh/${helm_archive}.sha256sum" \
  --output /tmp/helm.sha256sum
printf '%s  %s\n' "$(awk '{ print $1; exit }' /tmp/helm.sha256sum)" "/tmp/${helm_archive}" \
  | sha256sum --check --status
tar -C /tmp -xzf "/tmp/${helm_archive}"
install -m 755 "/tmp/linux-${kubectl_arch}/helm" /usr/local/bin/helm

doppler_asset="doppler_${DOPPLER_VERSION}_linux_${go_arch}.tar.gz"
doppler_release="https://github.com/DopplerHQ/cli/releases/download/${DOPPLER_VERSION}"
curl --fail --location --retry 5 "${doppler_release}/${doppler_asset}" \
  --output "/tmp/${doppler_asset}"
curl --fail --location --retry 5 "${doppler_release}/checksums.txt" \
  --output /tmp/doppler-checksums.txt
doppler_checksum="$(awk -v asset="$doppler_asset" '$2 == asset { print $1 }' /tmp/doppler-checksums.txt)"
if [ -z "$doppler_checksum" ]; then
  echo "No official Doppler checksum found for ${doppler_asset}" >&2
  exit 1
fi
printf '%s  %s\n' "$doppler_checksum" "/tmp/${doppler_asset}" | sha256sum --check --status
tar -C /tmp -xzf "/tmp/${doppler_asset}" doppler
install -m 755 /tmp/doppler /usr/local/bin/doppler

duckdb_asset="duckdb_cli-linux-${go_arch}.zip"
curl --fail --location --retry 5 \
  "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/${duckdb_asset}" \
  --output "/tmp/${duckdb_asset}"
unzip -q -o "/tmp/${duckdb_asset}" duckdb -d /tmp
install -m 755 /tmp/duckdb /usr/local/bin/duckdb

rm -rf /tmp/aws "/tmp/linux-${kubectl_arch}"
rm -f /tmp/awscliv2.zip /tmp/doppler /tmp/doppler-checksums.txt /tmp/duckdb \
  /tmp/helm.sha256sum /tmp/kubectl /tmp/kubectl.sha256 \
  "/tmp/${doppler_asset}" "/tmp/${duckdb_asset}" "/tmp/${helm_archive}"
rm -rf /root/.cache
