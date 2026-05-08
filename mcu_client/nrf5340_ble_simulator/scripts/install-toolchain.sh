#!/usr/bin/env bash
# Install everything needed to build and flash the nRF5340 BLE Simulator.
# Run once on a new machine: make install
# Safe to re-run — every step checks whether it's already done before running.
set -euo pipefail

NCS_VERSION="${NCS_VERSION:-v3.0.0}"
NCS_BASE="${NCS_BASE:-/opt/nordic/ncs}"

SDK_DIR="${NCS_BASE}/${NCS_VERSION}"
ZEPHYR_DIR="${SDK_DIR}/zephyr"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCHES_DIR="${SCRIPT_DIR}/../patches"

# ── helpers ────────────────────────────────────────────────────────────────

info()  { echo "  [+] $*"; }
skip()  { echo "  [~] $* — already done, skipping"; }
step()  { echo ""; echo "==> $*"; }
die()   { echo ""; echo "ERROR: $*" >&2; exit 1; }

command -v brew &>/dev/null || die "Homebrew not found — install it first: https://brew.sh"

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

INSTALLED_NRFUTIL_VERSION=$(nrfutil --version 2>/dev/null | awk 'NR==1 {print $2; exit}')

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

INSTALLED_DEVICE_VERSION=$(nrfutil device --version 2>/dev/null | awk '/nrfutil-device/ {print $2; exit}')

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
    | awk '/SEGGER J-Link Commander/ {sub(/^V/, "", $4); print $4; exit}')

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

# ── 4. nanopb ─────────────────────────────────────────────────────────────

step "nanopb"

if command -v protoc-gen-nanopb &>/dev/null; then
    skip "nanopb $(protoc-gen-nanopb --version 2>/dev/null)"
else
    info "Installing nanopb..."
    brew install nanopb
fi

# ── 5. nrfutil toolchain-manager plugin ────────────────────────────────────
#
# `toolchain-manager` is itself an installable nrfutil plugin — without it,
# `nrfutil toolchain-manager install` (used in step 6) errors out.

step "nrfutil toolchain-manager plugin"

if nrfutil toolchain-manager --version &>/dev/null; then
    skip "toolchain-manager $(nrfutil toolchain-manager --version 2>/dev/null | awk '/nrfutil-toolchain-manager/ {print $2; exit}')"
else
    info "Installing nrfutil toolchain-manager..."
    nrfutil install toolchain-manager
fi

# ── 6. NCS toolchain (compiler, CMake, Ninja, Python, west) ───────────────
#
# `nrfutil toolchain-manager install` downloads ~2GB. We resolve the bundle
# hash for our NCS_VERSION from toolchains.json (multiple NCS versions can
# coexist, each at its own hash) and skip if it's already on disk.

step "NCS toolchain ${NCS_VERSION}"

resolve_toolchain_hash() {
    python3 -c "import json; \
print(next((t['identifier']['bundle_id'] \
    for c in json.load(open('${NCS_BASE}/toolchains/toolchains.json')) \
    for t in c['toolchains'] \
    if '${NCS_VERSION}' in t['ncs_versions']), ''))" 2>/dev/null
}

TOOLCHAIN_HASH=$(resolve_toolchain_hash)

if [ -n "${TOOLCHAIN_HASH}" ] && [ -f "${NCS_BASE}/toolchains/${TOOLCHAIN_HASH}/bin/west" ]; then
    skip "toolchain ${TOOLCHAIN_HASH} (NCS ${NCS_VERSION})"
else
    info "Downloading and installing NCS toolchain (this is ~2GB, may take a while)..."
    nrfutil toolchain-manager install --ncs-version "${NCS_VERSION}"
    TOOLCHAIN_HASH=$(resolve_toolchain_hash)
    [ -z "${TOOLCHAIN_HASH}" ] && die "Toolchain install failed — no entry for ${NCS_VERSION} in toolchains.json"
fi

WEST="${NCS_BASE}/toolchains/${TOOLCHAIN_HASH}/bin/west"
[ -f "${WEST}" ] || die "west not found at ${WEST}"

info "Toolchain: ${TOOLCHAIN_HASH}"

# ── 7. SDK source — west init ─────────────────────────────────────────────

step "SDK source — west init"

if [ -d "${SDK_DIR}/.west" ]; then
    skip "west workspace at ${SDK_DIR}"
else
    info "Initialising west workspace at ${SDK_DIR}..."
    "${WEST}" init \
        -m https://github.com/nrfconnect/sdk-nrf \
        --mr "${NCS_VERSION}" \
        "${SDK_DIR}"
fi

# ── 8. SDK source — west update ───────────────────────────────────────────
#
# west update clones/fetches ~20+ repos. It is resumable — if you abort and
# re-run, it skips repos that are already up to date and retries the rest.

step "SDK source — west update (resumable if interrupted)"

cd "${SDK_DIR}"
"${WEST}" update

# ── 9. Zephyr CMake package ───────────────────────────────────────────────

step "Zephyr CMake package"
"${WEST}" zephyr-export
info "Exported"

# ── 10. Apply Zephyr patches ──────────────────────────────────────────────
#
# Patches live in ../patches/ and apply against the zephyr/ subtree (a git
# repo populated by `west update`):
#   - zephyr-nrf_qspi_nor.patch: boost the nRF53X HFCLK192M divider during
#     QSPI transfers; needed for reliable external flash access on this board.
#   - zephyr-lvgl.patch: shrink lvgl_set_mono_conversion_buffer by 8 bytes
#     to avoid an off-by-one overwrite in the monochrome conversion path.

step "Zephyr patches"

apply_patch() {
    local patch_file="$1"
    local name
    name=$(basename "${patch_file}")
    [ -f "${patch_file}" ] || die "patch not found: ${patch_file}"
    if git -C "${ZEPHYR_DIR}" apply --reverse --check "${patch_file}" 2>/dev/null; then
        skip "${name} already applied"
    elif git -C "${ZEPHYR_DIR}" apply --check "${patch_file}" 2>/dev/null; then
        info "Applying ${name}..."
        git -C "${ZEPHYR_DIR}" apply "${patch_file}"
    else
        die "${name} does not apply cleanly to ${ZEPHYR_DIR} — SDK version mismatch?"
    fi
}

apply_patch "${PATCHES_DIR}/zephyr-nrf_qspi_nor.patch"
apply_patch "${PATCHES_DIR}/zephyr-lvgl.patch"

# ── Done ───────────────────────────────────────────────────────────────────

echo ""
echo "================================================================"
echo " Setup complete!"
echo "   NCS_VERSION  = ${NCS_VERSION}"
echo "   NCS_BASE     = ${NCS_BASE}"
echo "   TOOLCHAIN_ID = ${TOOLCHAIN_HASH}"
echo ""
echo " Next steps:"
echo "   make keygen   # generate firmware signing key (once per machine)"
echo "   make build    # compile firmware"
echo "   make flash    # build + flash to connected board"
echo "================================================================"
