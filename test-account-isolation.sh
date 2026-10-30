#!/usr/bin/env bash
set -euo pipefail
HELPER="/usr/local/libexec/oracle-vm-account-shell"
A="acct-$(cat /proc/sys/kernel/random/uuid)"
B="acct-$(cat /proc/sys/kernel/random/uuid)"
UA="${A#acct-}"; UA="${UA//-/}"
UB="${B#acct-}"; UB="${UB//-/}"
HA="/var/lib/oracle-vm-executor/accounts/$A"
HB="/var/lib/oracle-vm-executor/accounts/$B"
cleanup() {
  sudo userdel --remove "$UA" >/dev/null 2>&1 || true
  sudo userdel --remove "$UB" >/dev/null 2>&1 || true
  sudo rm -rf "$HA" "$HB"
}
trap cleanup EXIT

OUT_A="$(sudo "$HELPER" "$A" "$HA/work" <<'CMD'
id -un
printf '%s\n' account-a-private > "$HOME/private.txt"
CMD
)"
OUT_B="$(sudo "$HELPER" "$B" "$HB/work" <<CMD
id -un
if cat "$HA/private.txt" >/dev/null 2>&1; then
  echo CROSS_ACCOUNT_READ_ALLOWED
  exit 22
else
  echo CROSS_ACCOUNT_READ_BLOCKED
fi
CMD
)"
grep -Fxq "$UA" <<<"$OUT_A"
grep -Fxq "$UB" <<<"$OUT_B"
grep -Fxq "CROSS_ACCOUNT_READ_BLOCKED" <<<"$OUT_B"
echo "PASS: distinct Linux users and private account workspaces."
