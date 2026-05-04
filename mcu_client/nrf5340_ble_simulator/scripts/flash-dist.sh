#!/usr/bin/env bash
# Flash a pre-built nRF5340 BLE Simulator firmware distribution.
#
# Requirements: nrfjprog + SEGGER J-Link
#   brew install nrf-command-line-tools
#   brew install --cask segger-jlink
#
# Usage:
#   bash flash-dist.sh                  # flash single connected board
#   bash flash-dist.sh --snr 123456789  # flash specific board by serial
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_HEX="${SCRIPT_DIR}/merged.hex"
NET_HEX="${SCRIPT_DIR}/merged_CPUNET.hex"
SNR_ARG=""

# ── parse args ─────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
    case "$1" in
        --snr) SNR_ARG="--snr $2"; shift 2 ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

# ── checks ─────────────────────────────────────────────────────────────────

command -v nrfjprog &>/dev/null || {
    echo ""
    echo "ERROR: nrfjprog not found."
    echo "Install: brew install nrf-command-line-tools"
    echo "         brew install --cask segger-jlink"
    exit 1
}

[ -f "${APP_HEX}" ] || { echo "ERROR: ${APP_HEX} not found"; exit 1; }
[ -f "${NET_HEX}" ] || { echo "ERROR: ${NET_HEX} not found"; exit 1; }

# ── flash ──────────────────────────────────────────────────────────────────

echo ""
echo "Flashing nRF5340 BLE Simulator..."
echo ""

echo "  [1/3] Erasing app core..."
nrfjprog --chiperase -f NRF53 ${SNR_ARG}

echo "  [2/3] Flashing app core (MCUboot + app)..."
nrfjprog --program "${APP_HEX}" --verify -f NRF53 ${SNR_ARG}

echo "  [3/3] Flashing network core (radio)..."
nrfjprog --program "${NET_HEX}" --verify -f NRF53 --coprocessor CP_NETWORK ${SNR_ARG}

echo ""
echo "  Resetting board..."
nrfjprog --reset -f NRF53 ${SNR_ARG}

echo ""
echo "Done! Board is running."
