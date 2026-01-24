#!/usr/bin/env bash
set -euo pipefail

if [ -f /etc/os-release ]; then
  . /etc/os-release
else
  echo "No /etc/os-release found, aborting"
  exit 1
fi

echo "Detected: ${ID:-unknown} ${VERSION_ID:-unknown}"

case "${ID:-}" in
  ubuntu|debian)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    if apt-get -y install podman; then
      echo "Podman installed via apt"
    else
      if command -v lsb_release >/dev/null 2>&1; then
        codename=$(lsb_release -cs)
        echo "Attempting backports for ${codename}..."
        apt-get -y -t "${codename}-backports" install podman || true
      fi
      apt-get -y install podman || { echo "Install failed. See https://podman.io/getting-started/installation"; exit 2; }
    fi
    ;;

  fedora)
    dnf -y install podman
    ;;

  centos|rhel)
    yum -y module enable container-tools:3.0 || true
    yum -y install podman || { dnf -y install podman || true; }
    ;;

  rocky|almalinux)
    dnf -y install podman
    ;;

  *)
    echo "Unsupported/unknown distro: ${ID:-}. Follow upstream docs: https://podman.io/getting-started/installation"
    exit 3
    ;;
esac


echo "\n--- Verification ---"
podman --version || true
podman info 2>/dev/null || true

echo "\n--- Test run (hello-world) ---"
# Attempt to pull and run hello-world; may fail on restricted networks
podman run --rm docker.io/library/hello-world || echo "Test run failed; check network or registry access"
