#!/bin/bash
#
# MentraOS self-hosted runner cache cleanup.
#
# Frees disk on a runner by deleting cacheable artifacts. Designed to be
# scheduled weekly via launchd (macOS) or systemd timer (Linux); set up by
# mobile/scripts/setup-runner.sh.
#
# Tiers (cumulative — Tier 2 includes Tier 1):
#   Tier 1 — Cheap caches that re-fill from local computation or fast
#            downloads on the next build:
#              * ~/.bun/install/cache/*
#              * ~/.gradle/caches/build-cache-* and transforms-*
#              * Android emulator system images (we don't run emulators in CI)
#              * stale _work checkouts older than 7 days
#   Tier 2 — Expensive caches; first build after wipe costs 5-15 min:
#              * everything in Tier 1
#              * ~/.gradle/caches in full (Maven deps re-download)
#              * ~/Library/Caches/* (macOS) / ~/.cache/* (Linux), minus dirs
#                we know are not safe to wipe (gh, dotnet)
#              * ~/.android/avd (any configured emulators)
#              * ~/Library/Developer/Xcode/DerivedData/Mentra-* (macOS only)
#
# Concurrency: if a build is running (gradle, xcodebuild, Xcode, bun, node
# processes owned by the current user) the cleanup defers and exits 0. The
# scheduler retries on its normal cadence (weekly) so no spinning.
#
# Logs to ~/mentra/runner-cleanup.log, self-trimmed to last 500 lines.
#
# Usage:
#   runner-cleanup.sh                # default: --tier all
#   runner-cleanup.sh --tier 1       # quick cleanup
#   runner-cleanup.sh --tier 2       # deep cleanup (includes Tier 1)
#   runner-cleanup.sh --tier all     # same as --tier 2
#   runner-cleanup.sh --dry-run      # print what would be deleted, change nothing
#   runner-cleanup.sh --force        # skip the build-process check

set -u
LC_ALL=C

# --- Parse args --------------------------------------------------------------

TIER="all"
DRY_RUN=0
FORCE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tier)
            TIER="${2:-}"
            shift 2
            ;;
        --tier=*)
            TIER="${1#*=}"
            shift
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --force)
            FORCE=1
            shift
            ;;
        -h|--help)
            sed -n '2,/^set -u/p' "$0" | sed 's/^# \{0,1\}//; $d'
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

case "$TIER" in
    1|2|all) ;;
    *) echo "Invalid --tier '$TIER' (expected 1, 2, or all)" >&2; exit 2 ;;
esac

# --- Logging -----------------------------------------------------------------

LOG_DIR="$HOME/mentra"
LOG_FILE="$LOG_DIR/runner-cleanup.log"
mkdir -p "$LOG_DIR"

# All output (stdout + stderr) goes to the log file AND to the terminal.
exec > >(tee -a "$LOG_FILE") 2>&1

trim_log() {
    # Trim the log to the most recent 500 lines so it can't grow unbounded.
    if [[ -f "$LOG_FILE" ]]; then
        local tmp
        tmp=$(mktemp)
        tail -n 500 "$LOG_FILE" > "$tmp" && mv "$tmp" "$LOG_FILE"
    fi
}
# Trim on exit, success or failure.
trap trim_log EXIT

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*"; }

# --- Platform detection ------------------------------------------------------

case "$(uname -s)" in
    Darwin) PLATFORM=mac ;;
    Linux)  PLATFORM=linux ;;
    *)      log "ERROR: unsupported platform '$(uname -s)' — exiting."; exit 1 ;;
esac

log "Starting cleanup tier=$TIER platform=$PLATFORM dry_run=$DRY_RUN force=$FORCE"

# --- Build-in-progress check -------------------------------------------------

# `pgrep -u "$USER"` matches processes owned by the current user only, so
# we don't trip on system services with similar names.
BUILD_PROCS_REGEX="gradle|xcodebuild|Xcode|bun|node|java|cmake"

if [[ "$FORCE" -ne 1 ]]; then
    if pgrep -u "$USER" -fl "$BUILD_PROCS_REGEX" >/dev/null 2>&1; then
        log "Build process detected (pgrep matched against /$BUILD_PROCS_REGEX/) — deferring cleanup."
        log "Active processes:"
        pgrep -u "$USER" -fl "$BUILD_PROCS_REGEX" | sed 's/^/  /' | head -20
        # Exit 0 so the scheduler doesn't treat this as a failure that should
        # be retried immediately. Cleanup just runs at its next regular slot.
        exit 0
    fi
fi

# --- Disk usage helpers ------------------------------------------------------

# Return free bytes on the root filesystem. Cross-platform: BSD `df` (mac) and
# GNU `df` (linux) both support `-k` (1KiB blocks). We multiply by 1024.
free_bytes() {
    local kib
    kib=$(df -k / | awk 'NR==2 {print $4}')
    echo "$(( kib * 1024 ))"
}

human_bytes() {
    # 18446744073709551615 → 16 EiB; awk handles up to ~10^15 fine.
    awk -v b="$1" 'BEGIN {
        units[0]="B"; units[1]="KiB"; units[2]="MiB"; units[3]="GiB"; units[4]="TiB";
        v=b; i=0;
        while (v >= 1024 && i < 4) { v /= 1024; i++ }
        printf "%.2f %s\n", v, units[i];
    }'
}

START_FREE=$(free_bytes)
log "Before cleanup: $(human_bytes "$START_FREE") free on /"

# --- rm helper that respects --dry-run ---------------------------------------

# Resolve a glob safely. Bash with nullglob/nocaseglob can produce
# unexpected results; we use `find` + `-prune` for predictable behaviour.
nuke() {
    local target="$1"
    if [[ ! -e "$target" && ! -L "$target" ]]; then
        log "  skip (not present): $target"
        return 0
    fi
    if [[ "$DRY_RUN" -eq 1 ]]; then
        local size
        size=$(du -sk "$target" 2>/dev/null | awk '{print $1*1024}')
        log "  would delete: $target ($(human_bytes "${size:-0}"))"
        return 0
    fi
    local size
    size=$(du -sk "$target" 2>/dev/null | awk '{print $1*1024}')
    rm -rf -- "$target"
    log "  deleted: $target ($(human_bytes "${size:-0}"))"
}

# Like nuke but accepts a glob pattern and operates on each match.
# Logs one aggregate line per pattern instead of per match, so a cache with
# thousands of entries doesn't drown the log.
nuke_glob() {
    local pattern="$1"
    local matches=()
    # shellcheck disable=SC2206
    matches=( $pattern )
    if [[ ${#matches[@]} -eq 0 || ( ${#matches[@]} -eq 1 && ! -e "${matches[0]}" ) ]]; then
        log "  skip (no matches): $pattern"
        return 0
    fi

    # Sum sizes of all matches.
    local total_kb=0
    for m in "${matches[@]}"; do
        local kb
        kb=$(du -sk "$m" 2>/dev/null | awk '{print $1}')
        total_kb=$(( total_kb + ${kb:-0} ))
    done
    local total_bytes=$(( total_kb * 1024 ))

    if [[ "$DRY_RUN" -eq 1 ]]; then
        log "  would delete: $pattern (${#matches[@]} entries, $(human_bytes "$total_bytes"))"
        return 0
    fi

    for m in "${matches[@]}"; do
        rm -rf -- "$m"
    done
    log "  deleted: $pattern (${#matches[@]} entries, $(human_bytes "$total_bytes"))"
}

# --- Tier 1 ------------------------------------------------------------------

log "Running Tier 1 (cheap caches)..."

# Bun's install cache — re-fetched from the registry on next bun install.
nuke_glob "$HOME/.bun/install/cache/*"

# Gradle build cache + transforms. modules-2 (downloaded Maven deps) is
# deliberately NOT here; that's Tier 2.
nuke_glob "$HOME/.gradle/caches/build-cache-*"
nuke_glob "$HOME/.gradle/caches/transforms-*"

# Android emulator system images. We don't run emulators in CI; setup-runner.sh
# doesn't install AVDs by default. If a future developer sshs in and creates
# one this will nuke it, which is acceptable for a build server.
if [[ "$PLATFORM" == "mac" ]]; then
    nuke_glob "$HOME/Library/Android/sdk/system-images"
else
    nuke_glob "$HOME/Android/Sdk/system-images"
fi

# Stale per-runner workdirs. Each runner-N has a _work dir containing one
# subdir per repo it's checked out. We don't try to nuke a runner's currently
# active checkout — the build-process guard above already excludes that case.
# Anything older than 7 days that we wouldn't touch on a typical week.
if [[ -d "$HOME/mentra" ]]; then
    while IFS= read -r dir; do
        nuke "$dir"
    done < <(find "$HOME/mentra"/actions-runner-*/_work -mindepth 2 -maxdepth 2 -type d -mtime +7 2>/dev/null)
fi

# --- Tier 2 ------------------------------------------------------------------

if [[ "$TIER" == "2" || "$TIER" == "all" ]]; then
    log "Running Tier 2 (expensive caches)..."

    # Gradle: everything. Modules-2 (downloaded JARs/AARs) is the big one;
    # next build will re-download from Maven Central (~hundreds of MB,
    # 2-5 min on a fast pipe).
    nuke "$HOME/.gradle/caches"

    # User-level cache dir. On Mac this is ~/Library/Caches; on Linux ~/.cache.
    # We explicitly skip a few subdirs that aren't really caches:
    #   - gh: GH CLI auth state ("hosts.yml" → re-auth required if nuked)
    #   - rbenv: holds downloaded Ruby tarballs but also build dirs in progress
    if [[ "$PLATFORM" == "mac" ]]; then
        CACHE_ROOT="$HOME/Library/Caches"
    else
        CACHE_ROOT="$HOME/.cache"
    fi
    if [[ -d "$CACHE_ROOT" ]]; then
        # find ... -prune to skip whitelisted dirs.
        while IFS= read -r entry; do
            nuke "$entry"
        done < <(find "$CACHE_ROOT" -mindepth 1 -maxdepth 1 \
                    ! -name "gh" \
                    ! -name "rbenv" \
                    2>/dev/null)
    fi

    # Android emulators (state, snapshots, custom AVD configs).
    nuke "$HOME/.android/avd"

    # macOS-only: Xcode DerivedData for the Mentra project. Major disk hog
    # (~20-50 GB after a few builds). Next iOS archive is slow (~10 min cold
    # compile) but that's what a deep clean is for.
    if [[ "$PLATFORM" == "mac" ]]; then
        nuke_glob "$HOME/Library/Developer/Xcode/DerivedData/Mentra-*"
    fi
fi

# --- Summary -----------------------------------------------------------------

END_FREE=$(free_bytes)
DELTA=$(( END_FREE - START_FREE ))

log "After cleanup: $(human_bytes "$END_FREE") free on /"
if [[ "$DELTA" -ge 0 ]]; then
    log "Freed: $(human_bytes "$DELTA")"
else
    # Possible if a build wrote new files during cleanup. Rare but real.
    log "Net change: -$(human_bytes "$(( -DELTA ))") (disk shrank during cleanup — likely build wrote new artifacts)"
fi

log "Done."
