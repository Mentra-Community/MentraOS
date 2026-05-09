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

# ── 1–3. Flash-only deps (nrfutil + device plugin + J-Link) ───────────────
#
# These are the same prerequisites a flasher (without the SDK) needs, so we
# delegate to scripts/install-flash-deps.sh and reuse the same pinned
# versions. Sourcing keeps `set -euo pipefail` and helpers in scope.

source "${SCRIPT_DIR}/install-flash-deps.sh"

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
