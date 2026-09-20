#!/usr/bin/env bash
# Make ccache available for mentra-app-ios-build.yml.
#
# If ccache is already on PATH or in a Homebrew prefix, print its path and
# exit 0. Otherwise install it with `brew install ccache` (the same formula
# setup-runner.sh uses), serializing concurrent installs on this host so two
# runner processes cannot corrupt Homebrew. Exit 1 if ccache is still missing;
# the workflow then compiles without it.
set -euo pipefail

log() { echo "$*" >&2; }

candidate_paths() {
  if [ -n "${MENTRA_IOS_CCACHE_CANDIDATES:-}" ]; then
    echo "$MENTRA_IOS_CCACHE_CANDIDATES" | tr ':' '\n'
    return
  fi
  printf '%s\n' /opt/homebrew/bin/ccache /usr/local/bin/ccache
}

find_ccache() {
  if command -v ccache >/dev/null 2>&1; then
    command -v ccache
    return 0
  fi
  local candidate
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done < <(candidate_paths)
  return 1
}

if path="$(find_ccache)"; then
  echo "$path"
  exit 0
fi

if [ "${MENTRA_IOS_CCACHE_AUTO_INSTALL:-1}" != "1" ]; then
  log "ccache is not installed and MENTRA_IOS_CCACHE_AUTO_INSTALL=${MENTRA_IOS_CCACHE_AUTO_INSTALL}"
  exit 1
fi

brew_bin="${MENTRA_IOS_CCACHE_BREW:-brew}"
if [ ! -x "$brew_bin" ] && ! command -v "$brew_bin" >/dev/null 2>&1; then
  log "ccache is not installed and Homebrew is not available"
  exit 1
fi

lock_dir="${MENTRA_IOS_CCACHE_LOCK_DIR:-$HOME/.ccache-mentra-ci}"
mkdir -p "$lock_dir"
lock_path="$lock_dir/.brew-install.lock"

log "ccache is not installed; installing via Homebrew (serialized)"

# Candidate paths are passed in so a waiting process can see an install that
# wrote to a test prefix, not only the real Homebrew locations.
python3 - "$lock_path" "$brew_bin" "$(candidate_paths | paste -sd: -)" <<'PY'
import fcntl, os, subprocess, sys, time

lock_path, brew_bin, candidates = sys.argv[1], sys.argv[2], sys.argv[3]
deadline = time.time() + 10 * 60


def already_installed():
    for p in candidates.split(":"):
        if p and os.path.isfile(p) and os.access(p, os.X_OK):
            return True
    return False


os.makedirs(os.path.dirname(lock_path) or ".", exist_ok=True)
with open(lock_path, "a+") as fh:
    while True:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.time() > deadline:
                sys.stderr.write("timed out waiting for ccache brew install lock\n")
                sys.exit(1)
            time.sleep(2)
    if already_installed():
        sys.exit(0)
    env = os.environ.copy()
    env.setdefault("HOMEBREW_NO_AUTO_UPDATE", "1")
    env.setdefault("HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK", "1")
    sys.exit(subprocess.call([brew_bin, "install", "ccache"], env=env))
PY

if path="$(find_ccache)"; then
  log "Installed ccache: $path"
  echo "$path"
  exit 0
fi

log "brew install ccache finished but ccache is still not available"
exit 1
