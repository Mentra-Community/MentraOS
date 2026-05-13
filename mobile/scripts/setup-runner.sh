#!/bin/bash
#
# MentraOS Mac mini self-hosted runner bootstrap.
#
# Bootstraps a fresh Mac mini into a working GitHub Actions runner host for
# the MentraOS iOS + Android pipelines. Run once per new machine. Re-running
# is safe — every step is idempotent.
#
# Manual prerequisites (do these once before running this script):
#   1. Sign in to the Mac with the dedicated CI Apple ID.
#   2. Install Xcode from the App Store, launch it once, accept the license.
#      (sudo xcodebuild -license accept will be run by this script too.)
#   3. Generate the secrets below (only if you want this script to register
#      runners — pass --runners 0 to skip runner registration entirely if
#      you've already set them up by hand).
#
# Required env vars (only when registering runners):
#   GH_RUNNER_TOKEN   - short-lived registration token from
#                       Repo > Settings > Actions > Runners > New self-hosted runner
#
# Optional env vars:
#   GH_RUNNER_URL     - defaults to https://github.com/Mentra-Community/MentraOS
#   RUNNER_NAME       - base name; multiple runners get -1, -2 suffixes.
#                       Defaults to the machine's hostname.
#   RUNNER_LABELS     - comma-separated extra labels (in addition to the
#                       default self-hosted,macOS,ARM64 set)
#   RUNNER_VERSION    - actions/runner version. Defaults to the latest stable
#                       release fetched from GitHub at runtime.
#   SKIP_ANDROID      - set to 1 to skip Android Studio + SDK install
#   ENABLE_TAILSCALE  - set to 1 to install Tailscale and join the tailnet.
#                       Off by default.
#   TAILSCALE_AUTHKEY - required when ENABLE_TAILSCALE=1. Ephemeral, single-
#                       use, tagged tag:ci.
#                       https://login.tailscale.com/admin/settings/keys
#
# Flags:
#   --runners N       Create N runner instances. Default 2. Pass 0 to skip
#                     runner registration entirely (useful when runners are
#                     already configured manually). If any runner is already
#                     configured under ~/mentra/actions-runner-* the runner
#                     registration step is skipped automatically.
#
# Usage:
#   GH_RUNNER_TOKEN=ghs_xxx ./mobile/scripts/setup-runner.sh
#   GH_RUNNER_TOKEN=ghs_xxx ./mobile/scripts/setup-runner.sh --runners 3
#   ENABLE_TAILSCALE=1 TAILSCALE_AUTHKEY=tskey-auth-xxx \
#     GH_RUNNER_TOKEN=ghs_xxx ./mobile/scripts/setup-runner.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()  { echo -e "${RED}[ERR]${NC} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

RUNNER_COUNT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --runners)
            RUNNER_COUNT="${2:-}"
            shift 2
            ;;
        --runners=*)
            RUNNER_COUNT="${1#*=}"
            shift
            ;;
        -h|--help)
            sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; $d'
            exit 0
            ;;
        *)
            fail "Unknown argument: $1"
            ;;
    esac
done

if [[ -n "$RUNNER_COUNT" && ! "$RUNNER_COUNT" =~ ^[0-9]+$ ]]; then
    fail "--runners must be a non-negative integer (got '$RUNNER_COUNT')"
fi

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

[[ "$(uname -s)" == "Darwin" ]] || fail "This script only runs on macOS."
[[ "$(uname -m)" == "arm64" ]]  || fail "Apple Silicon required (arm64)."

GH_RUNNER_URL="${GH_RUNNER_URL:-https://github.com/Mentra-Community/MentraOS}"

if [[ "${ENABLE_TAILSCALE:-0}" == "1" ]]; then
    : "${TAILSCALE_AUTHKEY:?Set TAILSCALE_AUTHKEY when ENABLE_TAILSCALE=1}"
fi

RUNNER_NAME_BASE="${RUNNER_NAME:-$(scutil --get LocalHostName 2>/dev/null || hostname -s)}"
RUNNER_LABELS_EXTRA="${RUNNER_LABELS:-}"

# Resolve runner version: prefer env var, otherwise pull latest from GitHub,
# otherwise fall back to a known-good pin so the script still works offline.
RUNNER_VERSION_FALLBACK="2.334.0"
if [[ -z "${RUNNER_VERSION:-}" ]]; then
    RUNNER_VERSION="$(curl -fsSL --max-time 5 \
        https://api.github.com/repos/actions/runner/releases/latest 2>/dev/null \
        | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)"
    RUNNER_VERSION="${RUNNER_VERSION:-$RUNNER_VERSION_FALLBACK}"
fi

RUNNER_BASE_DIR="$HOME/mentra"

# Detect existing runners up front. If any are present, skip registration.
shopt -s nullglob
EXISTING_RUNNERS=("$RUNNER_BASE_DIR"/actions-runner-*)
shopt -u nullglob

if (( ${#EXISTING_RUNNERS[@]} > 0 )); then
    info "Found existing runner(s) under $RUNNER_BASE_DIR — skipping runner registration:"
    for r in "${EXISTING_RUNNERS[@]}"; do
        info "  - $(basename "$r")"
    done
    SKIP_RUNNER_REGISTRATION=1
else
    SKIP_RUNNER_REGISTRATION=0
fi

# Resolve how many runners to create. Only matters when registration isn't
# being skipped. Default 2; --runners overrides; prompt if interactive and
# no flag was passed.
if [[ "$SKIP_RUNNER_REGISTRATION" -eq 0 ]]; then
    if [[ -z "$RUNNER_COUNT" ]]; then
        if [[ -t 0 ]]; then
            read -r -p "How many runners to create? [2]: " RUNNER_COUNT_INPUT
            RUNNER_COUNT="${RUNNER_COUNT_INPUT:-2}"
        else
            RUNNER_COUNT=2
        fi
        if [[ ! "$RUNNER_COUNT" =~ ^[0-9]+$ ]]; then
            fail "Runner count must be a non-negative integer (got '$RUNNER_COUNT')"
        fi
    fi

    if [[ "$RUNNER_COUNT" -gt 0 ]]; then
        : "${GH_RUNNER_TOKEN:?Set GH_RUNNER_TOKEN from $GH_RUNNER_URL/settings/actions/runners/new}"
    fi
fi

# Prime sudo once so the rest of the script runs without prompting mid-way.
# Keep the credential alive in the background until the script exits.
if [[ "$EUID" -ne 0 ]]; then
    info "This script needs sudo for several steps. Caching credentials now."
    sudo -v
    ( while true; do sudo -n true; sleep 60; kill -0 "$$" 2>/dev/null || exit; done ) 2>/dev/null &
    SUDO_KEEPALIVE_PID=$!
    trap '[[ -n "${SUDO_KEEPALIVE_PID:-}" ]] && kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true' EXIT
fi

info "Bootstrapping host '$RUNNER_NAME_BASE'"
info "  GitHub URL:    $GH_RUNNER_URL"
info "  Runner version: $RUNNER_VERSION"
if [[ "$SKIP_RUNNER_REGISTRATION" -eq 0 ]]; then
    info "  Runners to create: $RUNNER_COUNT"
fi

# ---------------------------------------------------------------------------
# Xcode license + CLI tools
# ---------------------------------------------------------------------------

info "Ensuring Xcode CLI tools are installed"
if ! xcode-select -p >/dev/null 2>&1; then
    xcode-select --install || true
    warn "Xcode CLI tools were missing. Re-run this script after the GUI install completes."
    exit 1
fi

if [[ -d "/Applications/Xcode.app" ]]; then
    sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
    sudo xcodebuild -license accept || true
    sudo xcodebuild -runFirstLaunch || true
    ok "Xcode pointed at /Applications/Xcode.app"
else
    fail "Xcode.app not found in /Applications. Install Xcode from the App Store first."
fi

# ---------------------------------------------------------------------------
# Homebrew
# ---------------------------------------------------------------------------

if ! command -v brew >/dev/null 2>&1; then
    info "Installing Homebrew"
    NONINTERACTIVE=1 /bin/bash -c \
        "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# Ensure brew is on PATH for the rest of this script + future shells.
BREW_PREFIX="/opt/homebrew"
eval "$($BREW_PREFIX/bin/brew shellenv)"

ZPROFILE="$HOME/.zprofile"
if ! grep -q 'brew shellenv' "$ZPROFILE" 2>/dev/null; then
    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$ZPROFILE"
fi
ok "Homebrew ready"

# ---------------------------------------------------------------------------
# Core toolchain
# ---------------------------------------------------------------------------

info "Installing core toolchain"
brew update

# applesimutils lives in the wix tap.
brew tap wix/brew >/dev/null 2>&1 || true

brew install \
    git \
    git-lfs \
    gh \
    cocoapods \
    watchman \
    swiftformat \
    openjdk@17 \
    xcbeautify \
    coreutils \
    jq \
    wix/brew/applesimutils \
    xcodesorg/made/xcodes

# Bun: installed via the official script (not in homebrew-core; the oven-sh
# tap exists but the upstream-recommended install path is curl|bash).
if ! command -v bun >/dev/null 2>&1; then
    info "Installing Bun via official installer"
    curl -fsSL https://bun.sh/install | bash
fi
if ! grep -q '\.bun/bin' "$ZPROFILE" 2>/dev/null; then
    cat >> "$ZPROFILE" <<'EOF'

# Bun (added by setup-runner.sh)
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
EOF
fi
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# Maestro is distributed as a single binary, not a brew formula.
if ! command -v maestro >/dev/null 2>&1; then
    info "Installing Maestro"
    curl -fsSL "https://get.maestro.mobile.dev" | bash
fi
# Maestro installs to ~/.maestro/bin — make sure that's on PATH for future shells.
if ! grep -q '\.maestro/bin' "$ZPROFILE" 2>/dev/null; then
    echo 'export PATH="$HOME/.maestro/bin:$PATH"' >> "$ZPROFILE"
fi
export PATH="$HOME/.maestro/bin:$PATH"

# Java 17 needs a symlink to be picked up by /usr/libexec/java_home.
if [[ ! -L "/Library/Java/JavaVirtualMachines/openjdk-17.jdk" ]]; then
    sudo ln -sfn \
        "$BREW_PREFIX/opt/openjdk@17/libexec/openjdk.jdk" \
        "/Library/Java/JavaVirtualMachines/openjdk-17.jdk"
fi

# Ruby for fastlane / cocoapods. Use system Ruby + bundler.
gem install bundler --no-document || true

# fastlane is gem-installed (no longer in homebrew-core).
if ! command -v fastlane >/dev/null 2>&1; then
    info "Installing fastlane via RubyGems"
    gem install fastlane --no-document || sudo gem install fastlane --no-document
fi

ok "Core toolchain installed"

# ---------------------------------------------------------------------------
# Android (optional)
# ---------------------------------------------------------------------------

if [[ "${SKIP_ANDROID:-0}" != "1" ]]; then
    info "Installing Android SDK"
    brew install --cask android-commandlinetools || true

    ANDROID_HOME="$HOME/Library/Android/sdk"
    mkdir -p "$ANDROID_HOME"
    export ANDROID_HOME
    export ANDROID_SDK_ROOT="$ANDROID_HOME"

    SDKMANAGER="$BREW_PREFIX/share/android-commandlinetools/cmdline-tools/latest/bin/sdkmanager"
    if [[ -x "$SDKMANAGER" ]]; then
        yes | "$SDKMANAGER" --sdk_root="$ANDROID_HOME" --licenses >/dev/null || true
        "$SDKMANAGER" --sdk_root="$ANDROID_HOME" \
            "platform-tools" \
            "build-tools;34.0.0" \
            "platforms;android-34" \
            "ndk;26.1.10909125" \
            "cmake;3.22.1" || true
    else
        warn "sdkmanager not found at $SDKMANAGER — install Android tools manually if needed."
    fi

    # Persist Android env vars for future shells + the runner service.
    if ! grep -q "ANDROID_HOME" "$ZPROFILE"; then
        cat >> "$ZPROFILE" <<EOF

# Android SDK (added by setup-runner.sh)
export ANDROID_HOME="\$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="\$ANDROID_HOME"
export PATH="\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/cmdline-tools/latest/bin:\$PATH"
EOF
    fi
    ok "Android SDK installed"
else
    info "Skipping Android SDK (SKIP_ANDROID=1)"
fi

# ---------------------------------------------------------------------------
# Tailscale (opt-in)
# ---------------------------------------------------------------------------

if [[ "${ENABLE_TAILSCALE:-0}" == "1" ]]; then
    info "Installing Tailscale"
    if ! command -v tailscale >/dev/null 2>&1; then
        brew install --cask tailscale
    fi

    # The cask installs the GUI app. Launching it once registers the system
    # extension so the CLI works.
    open -a "Tailscale" || true
    sleep 5

    info "Joining tailnet"
    sudo tailscale up \
        --authkey="$TAILSCALE_AUTHKEY" \
        --hostname="$RUNNER_NAME_BASE" \
        --ssh \
        --accept-routes
    ok "Tailscale up"
else
    info "Skipping Tailscale (set ENABLE_TAILSCALE=1 to install)"
fi

# ---------------------------------------------------------------------------
# Power + auto-login behavior for a headless build box
# ---------------------------------------------------------------------------

info "Disabling sleep and enabling auto-restart"
sudo pmset -a sleep 0
sudo pmset -a disksleep 0
sudo pmset -a displaysleep 30
sudo pmset -a autorestart 1
sudo pmset -a powernap 0
sudo systemsetup -setrestartfreeze on >/dev/null 2>&1 || true
sudo systemsetup -setrestartpowerfailure on >/dev/null 2>&1 || true
ok "Power settings tuned for unattended use"

# Auto-login is set in System Settings > Users & Groups (requires GUI + the
# user's password). The runner uses launchd anyway, so we don't strictly need
# auto-login — but it makes recovering from a power-cut faster.
warn "Auto-login is GUI-only on modern macOS. Set it once in System Settings > Users & Groups."

# ---------------------------------------------------------------------------
# File descriptor limits
# ---------------------------------------------------------------------------
# RN + Metro + watchman + Xcode routinely blow past the macOS default 256 fd
# soft limit, surfacing as flaky EMFILE / "too many open files" errors that
# look like build flakes but are pure config. Bump system-wide limits.

info "Raising file descriptor limits"
sudo tee /Library/LaunchDaemons/limit.maxfiles.plist >/dev/null <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
        "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>limit.maxfiles</string>
    <key>ProgramArguments</key>
    <array>
      <string>launchctl</string>
      <string>limit</string>
      <string>maxfiles</string>
      <string>524288</string>
      <string>524288</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>ServiceIPC</key><false/>
  </dict>
</plist>
PLIST
sudo chown root:wheel /Library/LaunchDaemons/limit.maxfiles.plist
sudo chmod 644 /Library/LaunchDaemons/limit.maxfiles.plist
sudo launchctl load -w /Library/LaunchDaemons/limit.maxfiles.plist 2>/dev/null || true
ok "File descriptor limit raised to 524288 (system-wide)"

# ---------------------------------------------------------------------------
# Spotlight exclusions
# ---------------------------------------------------------------------------
# Spotlight indexing Xcode DerivedData and the runner workspace burns 5-10%
# CPU during builds and contends with the SSD. Exclude them.

info "Excluding build dirs from Spotlight"
mkdir -p "$RUNNER_BASE_DIR"
mkdir -p "$HOME/Library/Developer/Xcode/DerivedData"
sudo mdutil -i off "$RUNNER_BASE_DIR" 2>/dev/null || true
sudo mdutil -i off "$HOME/Library/Developer/Xcode/DerivedData" 2>/dev/null || true
sudo mdutil -i off "$HOME/Library/Caches/CocoaPods" 2>/dev/null || true
ok "Spotlight indexing disabled for build artifact directories"

# ---------------------------------------------------------------------------
# GitHub Actions runner(s)
# ---------------------------------------------------------------------------

if [[ "$SKIP_RUNNER_REGISTRATION" -eq 1 ]]; then
    info "Runner registration skipped — existing runners already configured."
elif [[ "$RUNNER_COUNT" -eq 0 ]]; then
    info "Runner registration skipped (--runners 0)."
else
    LABELS="self-hosted,macOS,ARM64"
    if [[ -n "$RUNNER_LABELS_EXTRA" ]]; then
        LABELS="$LABELS,$RUNNER_LABELS_EXTRA"
    fi

    for i in $(seq 1 "$RUNNER_COUNT"); do
        RUNNER_NAME="${RUNNER_NAME_BASE}-${i}"
        RUNNER_HOME="$RUNNER_BASE_DIR/actions-runner-$RUNNER_NAME"
        WORK_DIR="$RUNNER_HOME/_work"

        info "Installing GitHub Actions runner v$RUNNER_VERSION at $RUNNER_HOME"
        mkdir -p "$RUNNER_HOME"
        cd "$RUNNER_HOME"

        if [[ ! -f ./config.sh ]]; then
            RUNNER_TARBALL="actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz"
            curl -fL -o "$RUNNER_TARBALL" \
                "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_TARBALL}"
            tar xzf "$RUNNER_TARBALL"
            rm -f "$RUNNER_TARBALL"
        fi

        if [[ ! -f ./.runner ]]; then
            ./config.sh \
                --url "$GH_RUNNER_URL" \
                --token "$GH_RUNNER_TOKEN" \
                --name "$RUNNER_NAME" \
                --labels "$LABELS" \
                --work "$WORK_DIR" \
                --unattended \
                --replace
        else
            info "Runner $RUNNER_NAME already configured. Skipping config.sh."
        fi

        # Bake env vars the runner should see at job time. The runner reads
        # ./.env on startup. Keep this in sync with what the workflows expect.
        {
            echo "PATH=$HOME/.bun/bin:$HOME/.maestro/bin:$BREW_PREFIX/bin:$BREW_PREFIX/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            echo "LANG=en_US.UTF-8"
            echo "JAVA_HOME=$BREW_PREFIX/opt/openjdk@17"
            if [[ "${SKIP_ANDROID:-0}" != "1" ]]; then
                echo "ANDROID_HOME=$HOME/Library/Android/sdk"
                echo "ANDROID_SDK_ROOT=$HOME/Library/Android/sdk"
            fi
        } > "$RUNNER_HOME/.env"

        # Install + start the launchd service so the runner survives reboots.
        # svc.sh's plist lives in ~/Library/LaunchAgents — check that rather
        # than relying on `svc.sh status` exit codes (which vary by version).
        SVC_PLIST="$HOME/Library/LaunchAgents/actions.runner.$(printf '%s' "$GH_RUNNER_URL" | sed 's|https://github.com/||; s|/|-|g').${RUNNER_NAME}.plist"
        if [[ ! -f "$SVC_PLIST" ]]; then
            sudo ./svc.sh install "$USER"
        fi
        sudo ./svc.sh start || true
        ok "Runner $RUNNER_NAME registered and running as a launchd service"
    done
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

cat <<EOF

==========================================================================
  Host '$RUNNER_NAME_BASE' bootstrapped.

  GitHub URL: $GH_RUNNER_URL
  Runner home(s): $RUNNER_BASE_DIR/actions-runner-*

  Next steps you should do manually once:
    - System Settings > Users & Groups > set this user to auto-login
    - System Settings > Lock Screen > Require password "Never"
    - Sign in to the Apple Developer account in Xcode (Settings > Accounts)
    - Confirm runner(s) appear at $GH_RUNNER_URL/settings/actions/runners
==========================================================================
EOF
