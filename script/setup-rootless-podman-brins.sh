#!/usr/bin/env bash
set -euo pipefail

# setup-rootless-podman-brins.sh
# Idempotent script to create/configure a non-root user `brins` for
# rootless Podman, configure storage, enable podman.socket and
# install a weekly conservative prune timer/service.
#
# Run as root: scp + ssh, or copy the file to server and run as root.

USER_NAME=${1:-brins}

echo "Running rootless Podman setup for user: ${USER_NAME}"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root. Exiting." >&2
  exit 1
fi

# 1) create user if missing
if id -u "${USER_NAME}" >/dev/null 2>&1; then
  echo "User ${USER_NAME} already exists"
else
  useradd -m -s /bin/bash "${USER_NAME}"
  echo "Created user ${USER_NAME}"
fi

# 2) ensure subordinate uid/gid ranges
if ! grep -q "^${USER_NAME}:" /etc/subuid 2>/dev/null; then
  echo "${USER_NAME}:100000:65536" >> /etc/subuid
  echo "Added /etc/subuid entry for ${USER_NAME}"
fi
if ! grep -q "^${USER_NAME}:" /etc/subgid 2>/dev/null; then
  echo "${USER_NAME}:100000:65536" >> /etc/subgid
  echo "Added /etc/subgid entry for ${USER_NAME}"
fi

# 3) enable linger so user services run without interactive login
loginctl enable-linger "${USER_NAME}" || true

# 4) create a conservative storage.conf for the user (rootless storage)
USER_UID=$(id -u "${USER_NAME}")
USER_HOME=$(eval echo ~${USER_NAME})
STORAGE_DIR="${USER_HOME}/.config/containers"
mkdir -p "${STORAGE_DIR}"

cat > "${STORAGE_DIR}/storage.conf" <<EOF
[storage]
  driver = "overlay"
  runroot = "/run/user/${USER_UID}/containers"
  graphroot = "${USER_HOME}/.local/share/containers"

[storage.options]
  mount_program = "/usr/bin/fuse-overlayfs"
EOF

chown -R "${USER_NAME}:${USER_NAME}" "${USER_HOME}/.config" || true
echo "Wrote storage.conf for ${USER_NAME}"

# 5) ensure podman.socket is enabled for the user
su - "${USER_NAME}" -c 'systemctl --user daemon-reload >/dev/null 2>&1 || true'
su - "${USER_NAME}" -c 'systemctl --user enable --now podman.socket >/dev/null 2>&1 || true'
echo "Requested podman.socket enable/start for ${USER_NAME} (may require a user login/session)"

# 6) create conservative weekly prune timer (7 days retention)
USER_SYSTEMD_DIR="${USER_HOME}/.config/systemd/user"
mkdir -p "${USER_SYSTEMD_DIR}"

cat > "${USER_SYSTEMD_DIR}/podman-prune.service" <<'SERVICE'
[Unit]
Description=Podman prune unused objects (conservative: >7 days)

[Service]
Type=oneshot
ExecStart=/usr/bin/podman system prune --filter until=7d --volumes -f

[Install]
WantedBy=default.target
SERVICE

cat > "${USER_SYSTEMD_DIR}/podman-prune.timer" <<'TIMER'
[Unit]
Description=Run podman-prune weekly

[Timer]
OnCalendar=weekly
Persistent=true

[Install]
WantedBy=timers.target
TIMER

chown -R "${USER_NAME}:${USER_NAME}" "${USER_SYSTEMD_DIR}"

# reload and enable timer as the user
su - "${USER_NAME}" -c 'systemctl --user daemon-reload >/dev/null 2>&1 || true'
su - "${USER_NAME}" -c 'systemctl --user enable --now podman-prune.timer >/dev/null 2>&1 || true'
echo "Installed and enabled weekly prune timer for ${USER_NAME}"

# 7) remove temporary installer if present
if [ -f /root/install-podman.sh ]; then
  rm -f /root/install-podman.sh && echo "/root/install-podman.sh removed"
fi

echo "Setup complete. Verify by running as ${USER_NAME}: podman info and systemctl --user status podman.socket" 

exit 0
