#!/usr/bin/env bash
# Install dependencies needed to FLASH a pre-built nRF5340 BLE Simulator
# firmware (subset of the full build toolchain — no NCS, no compiler).
#
# Run once on a new machine:
#   bash install-flash-deps.sh
#
# Then flash with:
#   bash flash.sh
#
# Re-running is safe — every step checks whether it's already done.
set -euo pipefail

info()  { echo "  [+] $*"; }
skip()  { echo "  [~] $* — already done, skipping"; }
step()  { echo ""; echo "==> $*"; }
die()   { echo ""; echo "ERROR: $*" >&2; exit 1; }

# ── 1. nrfutil + completion plugin ─────────────────────────────────────────
#
# Follows the official Nordic install flow:
# https://docs.nordicsemi.com/bundle/nrfutil/page/guides/installing.html
# i.e. download the binary into /usr/local/bin and install the completion
# plugin. We avoid `brew install nrfutil` so versions track Nordic's releases
# directly.
#
# Pinned to 8.0.0 — Nordic publishes only one binary at the universal-mac
# URL (the latest), so we download whatever is current and then use
# `nrfutil self-upgrade --to-version` (which supports downgrading) to land
# on the pinned version. Newer 8.x have not been validated for our flow.

NRFUTIL_VERSION="8.0.0"
NRFUTIL_BIN="/usr/local/bin/nrfutil"
NRFUTIL_URL="https://files.nordicsemi.com/artifactory/swtools/external/nrfutil/executables/universal-apple-darwin/nrfutil"

step "nrfutil (pinned ${NRFUTIL_VERSION})"

# `|| true` because on a fresh machine nrfutil doesn't exist yet — pipefail
# would propagate the 127 and errexit would silently kill the script.
INSTALLED_NRFUTIL_VERSION=$(nrfutil --version 2>/dev/null | awk 'NR==1 {print $2; exit}' || true)

if [ "${INSTALLED_NRFUTIL_VERSION}" = "${NRFUTIL_VERSION}" ]; then
    skip "nrfutil ${INSTALLED_NRFUTIL_VERSION}"
else
    if [ -z "${INSTALLED_NRFUTIL_VERSION}" ]; then
        info "Downloading nrfutil from Nordic..."
        sudo curl -fL "${NRFUTIL_URL}" -o "${NRFUTIL_BIN}"
        sudo chmod +x "${NRFUTIL_BIN}"
        # `nrfutil self-upgrade` rewrites the binary in place — must be
        # writable by the invoking user so we don't need sudo afterwards
        # (which would route plugin state into root's home dir).
        sudo chown "$(id -un)" "${NRFUTIL_BIN}"
        info "Installed nrfutil $(nrfutil --version 2>/dev/null | head -1)"
    else
        info "Found nrfutil ${INSTALLED_NRFUTIL_VERSION}, pinning to ${NRFUTIL_VERSION}..."
    fi
    nrfutil self-upgrade --to-version "${NRFUTIL_VERSION}" --force
fi

step "nrfutil completion plugin"

# `nrfutil install completion` is safe to re-run; it no-ops if already installed.
info "Installing nrfutil completion..."
nrfutil install completion

# ── 2. nrfutil device plugin ───────────────────────────────────────────────
#
# Pinned to 2.12.8 — 2.17.0 and 2.18.1 (latest) both trip
# "TrustZone Peripheral access error" on nRF5340 during QSPI font flashing.

NRFUTIL_DEVICE_VERSION="2.12.8"

step "nrfutil device plugin (pinned ${NRFUTIL_DEVICE_VERSION})"

INSTALLED_DEVICE_VERSION=$(nrfutil device --version 2>/dev/null | awk '/nrfutil-device/ {print $2; exit}' || true)

if [ "${INSTALLED_DEVICE_VERSION}" = "${NRFUTIL_DEVICE_VERSION}" ]; then
    skip "nrfutil device ${INSTALLED_DEVICE_VERSION}"
else
    if [ -n "${INSTALLED_DEVICE_VERSION}" ]; then
        info "Found nrfutil device ${INSTALLED_DEVICE_VERSION}, replacing with ${NRFUTIL_DEVICE_VERSION}..."
    else
        info "Installing nrfutil device ${NRFUTIL_DEVICE_VERSION}..."
    fi
    nrfutil install "device=${NRFUTIL_DEVICE_VERSION}" --force
fi

# ── 3. SEGGER J-Link ───────────────────────────────────────────────────────
#
# Pinned to V8.42 — SEGGER validated this release against nrfutil device
# v2.12.4–v2.12.10, the band our pinned 2.12.8 sits in. Newer J-Link
# releases have not been verified end-to-end for our flashing flow.
#
# Installed by downloading SEGGER's universal-mac pkg directly (the way
# Nordic's docs advise) instead of via Homebrew, so the version is exact.

JLINK_VERSION="8.42"
JLINK_PKG_URL="https://www.segger.com/downloads/jlink/JLink_MacOSX_V842_universal.pkg"

step "SEGGER J-Link (pinned V${JLINK_VERSION})"

JLINK_INSTALLED_VERSION=$(JLinkExe -nogui 1 < /dev/null 2>/dev/null \
    | awk '/SEGGER J-Link Commander/ {sub(/^V/, "", $4); print $4; exit}' || true)

if [ "${JLINK_INSTALLED_VERSION}" = "${JLINK_VERSION}" ]; then
    skip "J-Link V${JLINK_INSTALLED_VERSION}"
else
    if [ -n "${JLINK_INSTALLED_VERSION}" ]; then
        info "Found J-Link V${JLINK_INSTALLED_VERSION}, replacing with V${JLINK_VERSION}..."
    else
        info "Installing J-Link V${JLINK_VERSION}..."
    fi
    JLINK_PKG="$(mktemp -d)/JLink_V${JLINK_VERSION//./}_universal.pkg"
    info "Downloading from SEGGER (accepting EULA programmatically)..."
    curl -fL -X POST "${JLINK_PKG_URL}" \
        --data "accept_license_agreement=accepted&non_emb_ctr=confirmed&submit=Download+software" \
        -o "${JLINK_PKG}"
    info "Running installer (sudo required)..."
    sudo installer -pkg "${JLINK_PKG}" -target /
    rm -f "${JLINK_PKG}"
fi

# Final banner only when run directly — install-toolchain.sh sources this
# script and prints its own banner at the end of the full setup.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    echo ""
    echo "================================================================"
    echo " Flash dependencies installed!"
    echo ""
    echo " Next:  bash flash.sh"
    echo "        bash flash.sh --snr 123456789   (if multiple boards)"
    echo "================================================================"
fi
