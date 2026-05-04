# Flashing Guide

Build, flash, and manage firmware for the nRF5340 BLE Simulator.
All operations are driven by the `Makefile` at the project root.

---

## Dependencies

### Homebrew

**Why:** Package manager used to install everything else on macOS. All tools below are installed through it.
Install from [brew.sh](https://brew.sh) if not already present.

---

### nRF Connect SDK (NCS) v3.0.0

**Why:** The firmware is built on top of Zephyr RTOS and the Nordic nRF Connect SDK. NCS provides the Zephyr kernel, BLE stack, device drivers, board support, and all the middleware the firmware depends on.

The SDK has two parts:

| Part           | What it is                                 | Where it lives                       |
| -------------- | ------------------------------------------ | ------------------------------------ |
| **Toolchain**  | GCC compiler, CMake, Ninja, Python, `west` | `/opt/nordic/ncs/toolchains/<hash>/` |
| **SDK source** | Zephyr, nRF modules, MCUboot, drivers      | `/opt/nordic/ncs/v3.0.0/`            |

Both are installed by `make install`.

---

### west

**Why:** Nordic's meta-tool bundled with the NCS toolchain. It does two things:

**1. Multi-repo workspace manager** — The NCS SDK is not a single repo. It's ~20+ repos (Zephyr kernel, Nordic HAL, MCUboot, crypto libs, etc.) each pinned to a specific commit. `west` reads a manifest (`west.yml`) and clones/updates all of them together. This is what `west update` does during `make install`.

**2. Build and flash frontend** — `west build` and `west flash` are thin wrappers around CMake/Ninja and nrfjprog. They handle environment setup and coordinate the multi-image build (app + MCUboot + radio core) as a single operation.

The `west` used by the Makefile lives at `/opt/nordic/ncs/toolchains/<hash>/bin/west` — it's the toolchain-bundled version, which has all its Python dependencies pinned. Using a system-installed `west` (e.g. via `pip`) would risk version mismatches.

---

### nrfutil

**Why:** Nordic's CLI used to install and manage the NCS toolchain. Also the parent command for device programming plugins.

```
brew install nrfutil
```

---

### nrfutil device plugin

**Why:** Adds the `nrfutil device` subcommand, which lists connected Nordic boards with their name, serial number, and connection state. More informative than the older `nrfjprog --ids`.

```
nrfutil install device
```

Used by `make devices` and `make check-device`.

---

### nrfjprog

**Why:** Low-level command-line programmer for Nordic devices. Used for chip erase and recovery operations (`make erase`, `make recover`). It communicates with the board over J-Link.

Installed as part of the **nRF Command Line Tools**:

```
brew install nrf-command-line-tools
```

---

### SEGGER J-Link

**Why:** The nRF5340 DK has an onboard J-Link debug chip. The J-Link software installs the USB drivers your Mac needs to communicate with it. Without J-Link installed, none of the following work: flashing, chip erase, recovery, or RTT logging.

```
brew install --cask segger-jlink
```

Installed by `make install`.

---

### nanopb

**Why:** nanopb is a Protocol Buffers implementation for embedded C. The firmware communicates over BLE using protobuf-encoded messages. nanopb generates the `.pb.c` / `.pb.h` C source files from the `.proto` schema. The generated files are committed to the repo, so you only need nanopb when the schema changes.

```
brew install nanopb
```

Used by `make proto`.

---

### LVGL patch

**Why:** The upstream LVGL library (at `/opt/nordic/ncs/v3.0.0/zephyr/modules/lvgl/lvgl.c`) has an off-by-one in its monochrome conversion buffer allocation that causes a memory overwrite on this display. The fix reduces the buffer size by 8 bytes:

```c
// upstream (broken on this hardware):
lvgl_set_mono_conversion_buffer(mono_vtile_buf, BUFFER_SIZE);

// patched:
lvgl_set_mono_conversion_buffer(mono_vtile_buf, BUFFER_SIZE - 8);
```

`make install` applies this patch automatically after `west update`. It is idempotent — running it again on an already-patched file does nothing.

---

### Firmware signing key (`sysbuild/private.pem`)

**Why:** The bootloader (MCUboot) verifies firmware images using RSA-2048 signatures before booting them. The private key is used at build time to sign the image. It is not committed to the repository — generate it once per machine:

```
make keygen
```

> Keep this key consistent across builds on the same device. Changing the key requires re-flashing the bootloader.

---

## One-Time Setup (new machine)

```bash
make install    # installs all dependencies and SDK, applies LVGL patch
make keygen     # generates sysbuild/private.pem
```

---

## Daily Workflow

| Command           | What it does                                                           |
| ----------------- | ---------------------------------------------------------------------- |
| `make build`      | Incremental build — only recompiles changed files. Fast for iteration. |
| `make rebuild`    | Pristine build — wipes the build directory and rebuilds from scratch.  |
| `make flash`      | Pristine build then flashes all images (app + MCUboot + radio core).   |
| `make flash-only` | Flashes the existing build without recompiling.                        |
| `make clean`      | Deletes the `build/` directory.                                        |

---

## Device Management

| Command             | What it does                                                                      |
| ------------------- | --------------------------------------------------------------------------------- |
| `make devices`      | Lists all connected boards with name, serial number, and state.                   |
| `make check-device` | Verifies a board is reachable; warns if multiple are connected without `SNR` set. |
| `make erase`        | Full chip erase — wipes app core and network core flash. Leaves board blank.      |
| `make recover`      | Unlocks a bricked/APPROTECT-locked board (both cores), then reflashes.            |

#### What is APPROTECT and why can a core get locked?

The nRF5340 has a hardware security feature called **APPROTECT** (Access Port Protection). When enabled, it instructs the chip to block all external debug access over the SWD/J-Link interface — no reading flash, no writing, no debugging. It exists to protect production firmware from being extracted or tampered with.

A core ends up locked when:

- Firmware has `CONFIG_NRF_APPROTECT_LOCK=y` in Kconfig (intended for production, dangerous in dev)
- A bootloader or provisioning step writes to the UICR (a special flash region storing security config) to permanently enable it
- Production-hardened firmware is accidentally flashed to a dev board

The nRF5340 has two independent cores (app + network), each with its own APPROTECT register and UICR. This means the network core can be locked while the app core is fine, or vice versa. `make recover` explicitly unlocks both to be safe.

Recovery works via a hardware backdoor Nordic built in: a **CTRL-AP mailbox** that uses a special pin reset sequence to temporarily bypass protection long enough to erase the UICR and flash, unlocking the chip.

### Targeting a specific board

When multiple boards are connected, pass `SNR=<serial>` to any target:

```bash
make devices                  # find serial numbers
make flash SNR=1234567890
make erase SNR=1234567890
make recover SNR=1234567890
```

---

## Sharing a Build

To share a pre-built firmware with someone who doesn't have the SDK installed:

```bash
make dist
```

This does a pristine build and packages the output into `dist/`:

```
dist/
  merged.hex         — app core (MCUboot + TF-M + app, all merged)
  merged_CPUNET.hex  — network core (radio firmware)
  flash.sh           — standalone flash script
```

Share the `dist/` folder. The recipient only needs **nrfjprog + J-Link** — no SDK, no Makefile, no west:

```bash
# Recipient installs (one-time):
brew install nrf-command-line-tools
brew install --cask segger-jlink

# Recipient flashes:
bash flash.sh

# If multiple boards are connected:
bash flash.sh --snr 123456789
```

`flash.sh` erases both cores, programs both HEX files with verification, and resets the board.

---

## Other Targets

| Command           | What it does                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `make menuconfig` | Opens the interactive Kconfig menu to browse/change firmware config options.               |
| `make rtt`        | Opens SEGGER JLinkRTTClient to stream live firmware logs over J-Link.                      |
| `make proto`      | Recompiles `proto/mentraos_ble.proto` → `src/proto/`. Run after editing the `.proto` file. |

---

## Configurable Variables

All variables can be overridden on the command line:

| Variable       | Default                       | Description                                 |
| -------------- | ----------------------------- | ------------------------------------------- |
| `BOARD`        | `nrf5340dk/nrf5340/cpuapp/ns` | Zephyr board target                         |
| `CONF_FILE`    | `prj.conf`                    | Kconfig configuration file                  |
| `DTC_OVERLAY`  | `app.overlay`                 | Primary device tree overlay                 |
| `EXTRA_DTC`    | `npm1300_config.overlay`      | Additional device tree overlay              |
| `BUILD_DIR`    | `build`                       | Build output directory                      |
| `SNR`          | _(unset)_                     | J-Link serial number for multi-board setups |
| `NCS_VERSION`  | `v3.0.0`                      | nRF Connect SDK version                     |
| `NCS_BASE`     | `/opt/nordic/ncs`             | NCS install root                            |
| `TOOLCHAIN_ID` | `ef4fc6722e`                  | Toolchain hash (set by NCS installer)       |

Example:

```bash
make flash CONF_FILE=prj_release.conf BOARD=nrf5340dk/nrf5340/cpuapp/ns
```

---

## Troubleshooting

**`west not found` error**
Run `make install`. If the toolchain is installed in a non-default location, override the path:

```bash
make build NCS_BASE=~/ncs TOOLCHAIN_ID=<hash>
```

**Board not detected**

- Check the USB cable is connected to the **J-Link USB port** on the DK (not the nRF USB port)
- Run `make devices` to confirm the board appears
- If the board is locked/unresponsive, run `make recover`

**Build fails after SDK update**
The LVGL patch may need to be re-applied. Run:

```bash
make install
```

The patch step is idempotent and will re-apply if the file was reset by `west update`.

**Signature verification failure at boot**
The signing key in `sysbuild/private.pem` does not match the key baked into the bootloader. Re-flash everything from scratch:

```bash
make erase
make flash
```
