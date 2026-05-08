#!/usr/bin/env bash
# Flash a pre-built nRF5340 BLE Simulator firmware distribution.
#
# ── Requirements (macOS) ─────────────────────────────────────────────────
#
# 1. nrfutil — Nordic's command-line tool, with the `device` plugin
#
#      sudo curl -fL https://files.nordicsemi.com/artifactory/swtools/external/nrfutil/executables/universal-apple-darwin/nrfutil \
#          -o /usr/local/bin/nrfutil
#      sudo chmod +x /usr/local/bin/nrfutil
#      sudo chown $(id -un) /usr/local/bin/nrfutil
#      nrfutil self-upgrade --to-version 8.0.0 --force
#      nrfutil install device=2.12.8 --force
#
#    The 2.12.8 plugin pin matters: 2.17.0+ trips a TrustZone error on
#    nRF5340 QSPI for this firmware. Do not upgrade it.
#
# 2. SEGGER J-Link V8.42 — download universal-mac pkg from segger.com
#
#      https://www.segger.com/downloads/jlink/JLink_MacOSX_V842_universal.pkg
#      (POST with accept_license_agreement=accepted&non_emb_ctr=confirmed&submit=Download+software)
#
# ── Usage ────────────────────────────────────────────────────────────────
#
#   bash flash.sh                  # flash single connected board
#   bash flash.sh --snr 123456789  # flash specific board by serial
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_HEX="${SCRIPT_DIR}/merged.hex"
NET_HEX="${SCRIPT_DIR}/merged_CPUNET.hex"
SNR_ARG=""

# ── parse args ─────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
    case "$1" in
        --snr) SNR_ARG="--serial-number $2"; shift 2 ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

# ── checks ─────────────────────────────────────────────────────────────────

command -v nrfutil &>/dev/null || {
    echo ""
    echo "ERROR: nrfutil not found. See the install instructions at the top of this script."
    exit 1
}

nrfutil device --version &>/dev/null || {
    echo ""
    echo "ERROR: nrfutil 'device' plugin not installed."
    echo "  nrfutil install device=2.12.8 --force"
    exit 1
}

[ -f "${APP_HEX}" ] || { echo "ERROR: ${APP_HEX} not found"; exit 1; }
[ -f "${NET_HEX}" ] || { echo "ERROR: ${NET_HEX} not found"; exit 1; }

PROG_OPTS="chip_erase_mode=ERASE_ALL,verify=VERIFY_HASH"

# ── flash ──────────────────────────────────────────────────────────────────

echo ""
echo "Flashing nRF5340 BLE Simulator..."
echo ""

# Recover both cores first — clears any prior firmware, AP-Protect, or
# UICR state. Equivalent to the old `nrfjprog --recover` for each core.
echo "  [1/5] Recovering network core..."
nrfutil device recover --core Network ${SNR_ARG}

echo "  [2/5] Recovering app core..."
nrfutil device recover --core Application ${SNR_ARG}

# Program network core first, then app core — this is the order
# `west flash` uses by default for nrf5340dk.
echo "  [3/5] Programming network core (radio)..."
nrfutil device program --firmware "${NET_HEX}" --core Network --options "${PROG_OPTS}" ${SNR_ARG}

echo "  [4/5] Programming app core (MCUboot + app)..."
nrfutil device program --firmware "${APP_HEX}" --core Application --options "${PROG_OPTS}" ${SNR_ARG}

echo "  [5/5] Resetting board..."
nrfutil device reset ${SNR_ARG}

echo ""
echo "Done! Board is running."
