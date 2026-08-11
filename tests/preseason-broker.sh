#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

bash -n "$repo_root/bin/install-preseason-broker"
bash -n "$repo_root/bin/fpl-preseason-broker"
bash -n "$repo_root/bin/fpl-preseason-wrapper"
node --check "$repo_root/scripts/fetch-preseason-data.mjs"
node --check "$repo_root/scripts/run-preseason-data.mjs"

if output="$($repo_root/bin/fpl-preseason-broker unexpected-argument 2>&1)"; then
  echo "broker unexpectedly accepted an argument" >&2
  exit 1
fi
[[ "$output" == *"accepts no arguments"* ]] || {
  echo "argument rejection was not explicit" >&2
  exit 1
}

# Simulate an absent sudo installation without invoking sudo or touching a
# secret. The normal entrypoint must fail closed and show the one install step.
cat > "$tmpdir/sudo" <<'SUDO'
#!/usr/bin/env bash
echo "sudo: a password is required" >&2
exit 1
SUDO
chmod 0755 "$tmpdir/sudo"
if output="$(PATH="$tmpdir:$PATH" node "$repo_root/scripts/run-preseason-data.mjs" 2>&1)"; then
  echo "normal entrypoint unexpectedly succeeded without broker" >&2
  exit 1
fi
[[ "$output" == *"no direct or interactive fallback"* ]] || {
  echo "missing-installation failure was not fail-closed" >&2
  exit 1
}
[[ "$output" == *"sudo ./bin/install-preseason-broker"* ]] || {
  echo "missing-installation command was not documented" >&2
  exit 1
}
[[ "$output" != *"/etc/agent-secrets"* && "$output" != *"api-football.secret"* ]] || {
  echo "missing-installation diagnostic disclosed a secret path" >&2
  exit 1
}

sudoers_line="$(grep 'NOPASSWD:' "$repo_root/bin/install-preseason-broker")"
[[ "$sudoers_line" == *'NOPASSWD: $WRAPPER'* ]] || {
  echo "sudoers rule does not target the fixed wrapper" >&2
  exit 1
}
[[ "$sudoers_line" != *'*'* ]] || {
  echo "sudoers rule contains an argument wildcard" >&2
  exit 1
}
! grep -q 'spawnSync.*sudo\|secret global\|secret fpl' "$repo_root/scripts/fetch-preseason-data.mjs"

echo "preseason broker checks passed"
