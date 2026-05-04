#!/usr/bin/env bash
# Install everything needed to build and flash the nRF5340 BLE Simulator.
# Run once on a new machine: make install
# Safe to re-run — every step checks whether it's already done before running.
set -euo pipefail

NCS_VERSION="${NCS_VERSION:-v3.0.0}"
NCS_BASE="${NCS_BASE:-/opt/nordic/ncs}"

SDK_DIR="${NCS_BASE}/${NCS_VERSION}"
LVGL_C="${SDK_DIR}/zephyr/modules/lvgl/lvgl.c"

# ── helpers ────────────────────────────────────────────────────────────────

info()  { echo "  [+] $*"; }
skip()  { echo "  [~] $* — already done, skipping"; }
step()  { echo ""; echo "==> $*"; }
die()   { echo ""; echo "ERROR: $*" >&2; exit 1; }

command -v brew &>/dev/null || die "Homebrew not found — install it first: https://brew.sh"

# ── 1. nrfutil ─────────────────────────────────────────────────────────────

step "nrfutil"

if ! command -v nrfutil &>/dev/null; then
    info "Installing nrfutil..."
    brew install nrfutil
else
    skip "nrfutil $(nrfutil --version 2>/dev/null | head -1)"
fi

# ── 2. nrfutil device plugin ───────────────────────────────────────────────

step "nrfutil device plugin"

if nrfutil device --version &>/dev/null; then
    skip "nrfutil device plugin"
else
    info "Installing nrfutil device plugin..."
    nrfutil install device
fi

# ── 3. SEGGER J-Link ───────────────────────────────────────────────────────

step "SEGGER J-Link"

if command -v JLinkExe &>/dev/null; then
    skip "J-Link"
else
    info "Installing SEGGER J-Link..."
    brew install --cask segger-jlink
fi

# ── 4. nanopb ─────────────────────────────────────────────────────────────

step "nanopb"

if command -v protoc-gen-nanopb &>/dev/null; then
    skip "nanopb $(protoc-gen-nanopb --version 2>/dev/null)"
else
    info "Installing nanopb..."
    brew install nanopb
fi

# ── 5. NCS toolchain (compiler, CMake, Ninja, Python, west) ───────────────
#
# nrfutil toolchain-manager install downloads ~2GB. We skip it if the
# toolchains directory already has an entry for this NCS version.

step "NCS toolchain ${NCS_VERSION}"

TOOLCHAIN_HASH=$(ls "${NCS_BASE}/toolchains/" 2>/dev/null | head -1)

if [ -n "${TOOLCHAIN_HASH}" ] && [ -f "${NCS_BASE}/toolchains/${TOOLCHAIN_HASH}/bin/west" ]; then
    skip "toolchain ${TOOLCHAIN_HASH}"
else
    info "Downloading and installing NCS toolchain (this is ~2GB, may take a while)..."
    nrfutil toolchain-manager install --ncs-version "${NCS_VERSION}"
    TOOLCHAIN_HASH=$(ls "${NCS_BASE}/toolchains/" 2>/dev/null | head -1)
    [ -z "${TOOLCHAIN_HASH}" ] && die "Toolchain install failed — ${NCS_BASE}/toolchains/ is empty"
fi

WEST="${NCS_BASE}/toolchains/${TOOLCHAIN_HASH}/bin/west"
[ -f "${WEST}" ] || die "west not found at ${WEST}"

info "Toolchain: ${TOOLCHAIN_HASH}"

# ── 6. SDK source — west init ─────────────────────────────────────────────

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

# ── 7. SDK source — west update ───────────────────────────────────────────
#
# west update clones/fetches ~20+ repos. It is resumable — if you abort and
# re-run, it skips repos that are already up to date and retries the rest.

step "SDK source — west update (resumable if interrupted)"

cd "${SDK_DIR}"
"${WEST}" update

# ── 8. Zephyr CMake package ───────────────────────────────────────────────

step "Zephyr CMake package"
"${WEST}" zephyr-export
info "Exported"

# ── 9. Patch LVGL ─────────────────────────────────────────────────────────
#
# lvgl_set_mono_conversion_buffer must use BUFFER_SIZE - 8 to avoid an
# off-by-one overwrite in the monochrome conversion path on this display.

step "LVGL patch"

if [ ! -f "${LVGL_C}" ]; then
    die "lvgl.c not found at ${LVGL_C} — did west update complete?"
fi

if grep -q "BUFFER_SIZE - 8" "${LVGL_C}"; then
    skip "lvgl.c already patched"
else
    info "Patching ${LVGL_C}..."
    python3 - "${LVGL_C}" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path) as f:
    content = f.read()
old = '\tlvgl_set_mono_conversion_buffer(mono_vtile_buf, BUFFER_SIZE);'
new = ('\t// lvgl_set_mono_conversion_buffer(mono_vtile_buf, BUFFER_SIZE);\n'
       '\tlvgl_set_mono_conversion_buffer(mono_vtile_buf, BUFFER_SIZE - 8);')
if old not in content:
    print("ERROR: expected line not found — SDK version mismatch?", file=sys.stderr)
    sys.exit(1)
with open(path, 'w') as f:
    f.write(content.replace(old, new))
PYEOF
    info "Patched"
fi

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
