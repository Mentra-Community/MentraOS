# ---------------------------------------------------------------------------
# nRF5340 BLE Simulator — build & flash automation
#
# Usage:
#   make build
#   make flash
#   make flash SNR=123456789          # target a specific board
#   make build BOARD=nrf5340dk/nrf5340/cpuapp/ns CONF_FILE=prj_release.conf
# ---------------------------------------------------------------------------

# Toolchain
NCS_VERSION  ?= v3.0.0
NCS_BASE     ?= /opt/nordic/ncs
# Resolve the toolchain bundle hash for our NCS_VERSION from the manifest
# nrfutil maintains. This is needed because the hash is opaque and a machine
# may have multiple NCS versions installed (e.g. v3.0.0 and v3.2.0 sit at
# different bundle_ids). Override with `make build TOOLCHAIN_ID=<hash>` if
# you need to pin to a specific bundle.
TOOLCHAIN_ID ?= $(shell python3 -c 'import json; print(next((t["identifier"]["bundle_id"] for c in json.load(open("$(NCS_BASE)/toolchains/toolchains.json")) for t in c["toolchains"] if "$(NCS_VERSION)" in t["ncs_versions"]), ""))' 2>/dev/null)
WEST         ?= $(NCS_BASE)/toolchains/$(TOOLCHAIN_ID)/bin/west
IMGTOOL      ?= $(NCS_BASE)/toolchains/$(TOOLCHAIN_ID)/bin/imgtool
NRFJPROG     ?= nrfjprog

# Build
BUILD_DIR    ?= build
BOARD        ?= nrf5340dk/nrf5340/cpuapp/ns
CONF_FILE    ?= prj.conf
DTC_OVERLAY  ?= app.overlay
EXTRA_DTC    ?= npm1300_config.overlay

# Device selection — set SNR=<serial> to target a specific board
SNR          ?=
_SNR_ARG     := $(if $(SNR),--snr $(SNR),)

CMAKE_ARGS := \
	-DCONFIG_DEBUG_THREAD_INFO=y \
	-DCONF_FILE=$(CONF_FILE) \
	-DDTC_OVERLAY_FILE=$(DTC_OVERLAY) \
	-DEXTRA_DTC_OVERLAY_FILE=$(EXTRA_DTC)

# ---------------------------------------------------------------------------

.PHONY: build rebuild flash flash-only clean menuconfig rtt \
        erase recover devices check-device keygen proto dist install check-west help

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

keygen: ## Generate firmware signing key at sysbuild/private.pem (once per machine)
	@if [ -f sysbuild/private.pem ]; then \
		echo "Key already exists at sysbuild/private.pem — delete it first to regenerate"; \
	else \
		$(IMGTOOL) keygen -k sysbuild/private.pem -t rsa-2048; \
		echo "Key generated at sysbuild/private.pem"; \
	fi

proto: ## Recompile proto/mentraos_ble.proto → src/proto/ (run after .proto changes)
	protoc --nanopb_out=src/proto \
	       --nanopb_opt=proto/mentraos_ble.options \
	       proto/mentraos_ble.proto

install: ## Install nRF Connect SDK toolchain (run once on a new machine)
	@chmod +x scripts/install-toolchain.sh
	NCS_VERSION=$(NCS_VERSION) NCS_BASE=$(NCS_BASE) bash scripts/install-toolchain.sh

check-west:
	@if [ ! -f "$(WEST)" ]; then \
		echo ""; \
		echo "ERROR: west not found at $(WEST)"; \
		echo ""; \
		echo "Run the install script to set up the toolchain:"; \
		echo "  make install"; \
		echo ""; \
		echo "Or override the path if installed elsewhere:"; \
		echo "  make build NCS_BASE=<path> TOOLCHAIN_ID=<hash>"; \
		echo ""; \
		exit 1; \
	fi

build: check-west ## Incremental build (fast, no --pristine)
	$(WEST) build \
		--build-dir $(BUILD_DIR) \
		. \
		--board $(BOARD) \
		-- $(CMAKE_ARGS)

rebuild: check-west ## Pristine (clean) build
	$(WEST) build \
		--build-dir $(BUILD_DIR) \
		. \
		--pristine \
		--board $(BOARD) \
		-- $(CMAKE_ARGS)

flash: rebuild ## Pristine build then flash all images
	$(WEST) flash --build-dir $(BUILD_DIR) $(_SNR_ARG)

flash-only: check-west ## Flash existing build without rebuilding
	$(WEST) flash --build-dir $(BUILD_DIR) $(_SNR_ARG)

clean: ## Remove build directory
	rm -rf $(BUILD_DIR)

dist: rebuild ## Build and package firmware for sharing (outputs to dist/)
	@mkdir -p dist
	@cp $(BUILD_DIR)/merged.hex dist/merged.hex
	@cp $(BUILD_DIR)/merged_CPUNET.hex dist/merged_CPUNET.hex
	@cp scripts/flash-dist.sh dist/flash.sh
	@chmod +x dist/flash.sh
	@echo ""
	@echo "Package ready in dist/:"
	@echo "  merged.hex         — app core (MCUboot + app)"
	@echo "  merged_CPUNET.hex  — network core (radio)"
	@echo "  flash.sh           — standalone flash script"
	@echo ""
	@echo "Recipient needs (see flash.sh header for details):"
	@echo "  • nrfutil 8.0.0 + 'device' plugin 2.12.8"
	@echo "  • SEGGER J-Link V8.42"
	@echo ""
	@echo "Share the dist/ folder. Recipient flashes with:"
	@echo "  bash flash.sh"
	@echo "  bash flash.sh --snr 123456789   (if multiple boards connected)"

menuconfig: check-west ## Open Kconfig menu for the main app
	$(WEST) build \
		--build-dir $(BUILD_DIR) \
		--board $(BOARD) \
		-t menuconfig

rtt: ## Open SEGGER JLinkRTTClient for live logs (requires SEGGER tools)
	JLinkRTTClient

devices: ## List all connected boards (name, serial, state)
	@nrfutil device list 2>/dev/null \
		|| echo "  (none found — check USB connection and that 'nrfutil install device' has been run)"
	@echo ""
	@echo "  Flash a specific board:  make flash SNR=<serial>"

check-device: ## Check whether a board is reachable
	@SERIALS=$$(nrfutil device list 2>/dev/null | grep -oE '[0-9]{9,}'); \
	if [ -z "$$SERIALS" ]; then \
		echo "No board detected — check USB connection"; \
		exit 1; \
	fi; \
	COUNT=$$(echo "$$SERIALS" | wc -l | tr -d ' '); \
	nrfutil device list; \
	if [ "$$COUNT" -gt 1 ] && [ -z "$(SNR)" ]; then \
		echo ""; \
		echo "WARNING: multiple boards connected — use SNR=<serial> to pick one"; \
	fi

erase: ## Erase all flash on the board (app core + network core)
	$(NRFJPROG) --recover -f NRF53 $(_SNR_ARG)
	$(NRFJPROG) --recover -f NRF53 --coprocessor CP_NETWORK $(_SNR_ARG)
	$(NRFJPROG) --eraseall -f NRF53 $(_SNR_ARG)

recover: ## Recover a locked/bricked board, then reflash
	$(NRFJPROG) --recover -f NRF53 $(_SNR_ARG)
	$(NRFJPROG) --recover -f NRF53 --coprocessor CP_NETWORK $(_SNR_ARG)
	$(MAKE) flash SNR=$(SNR)
