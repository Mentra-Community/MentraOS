#!/usr/bin/env bash
# Flash a pre-built nRF5340 BLE Simulator firmware distribution.
#
# ── First-time setup (macOS) ─────────────────────────────────────────────
#
#   bash install-deps.sh
#
# Installs nrfutil 8.0.0, the nrfutil device 2.12.8 plugin, and SEGGER
# J-Link V8.42 — the exact pins this firmware was validated against.
# (The 2.12.8 device-plugin pin matters: 2.17.0+ trips a TrustZone error on
# nRF5340 QSPI for this firmware. Do not upgrade it.)
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
    echo "ERROR: nrfutil not found. Run the bundled installer first:"
    echo "  bash install-deps.sh"
    exit 1
}

nrfutil device --version &>/dev/null || {
    echo ""
    echo "ERROR: nrfutil 'device' plugin not installed. Run the bundled installer:"
    echo "  bash install-deps.sh"
    exit 1
}

[ -f "${APP_HEX}" ] || { echo "ERROR: ${APP_HEX} not found"; exit 1; }
[ -f "${NET_HEX}" ] || { echo "ERROR: ${NET_HEX} not found"; exit 1; }

# VERIFY_READ (read-back compare) instead of VERIFY_HASH because the
# probe-plugin backend (Probe-RS, used when the SEGGER J-Link backend
# isn't picked up) doesn't support hash verify. Read-back works on every
# backend and gives the same correctness guarantee, just a touch slower.
PROG_OPTS="chip_erase_mode=ERASE_ALL,verify=VERIFY_READ"

# ── flash ──────────────────────────────────────────────────────────────────

echo ""
echo "Flashing nRF5340 BLE Simulator..."
echo ""

# Recover both cores first — clears any prior firmware, AP-Protect, or
# UICR state. Equivalent to the old `nrfjprog --recover` for each core.
# App core MUST go first: the network core's CTRL-AP is gated by the
# application core's lock state on nRF5340, so recovering Network first
# often fails to detect CTRL-AP. App-then-Network mirrors the order
# `nrfjprog --recover` uses by default.
echo "  [1/5] Recovering app core..."
nrfutil device recover --core Application ${SNR_ARG}

echo "  [2/5] Recovering network core..."
nrfutil device recover --core Network ${SNR_ARG}

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
