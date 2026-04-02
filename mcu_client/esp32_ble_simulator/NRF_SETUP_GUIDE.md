# nRF5340 Development Setup Guide

## Step 1: Install nRF Connect SDK

### Option A: Using nRF Connect for Desktop (Recommended)
1. Download and install [nRF Connect for Desktop](https://www.nordicsemi.com/Software-and-Tools/Development-Tools/nRF-Connect-for-desktop)
2. Open nRF Connect for Desktop
3. Install "Toolchain Manager"
4. In Toolchain Manager, install the latest nRF Connect SDK (v2.7.0 or newer)
5. This will install:
   - nRF Connect SDK
   - Zephyr RTOS
   - west build tool
   - ARM GCC toolchain
   - Python dependencies

### Option B: Manual Installation (macOS)
```bash
# Install dependencies
brew install cmake ninja python3

# Install west
pip3 install west

# Create workspace
mkdir ~/nrf-workspace
cd ~/nrf-workspace

# Initialize west workspace
west init -m https://github.com/nrfconnect/sdk-nrf --mr v2.7.0

# Update
west update

# Install Python dependencies
pip3 install -r zephyr/scripts/requirements.txt
pip3 install -r nrf/scripts/requirements.txt

# Install Zephyr SDK
cd ~
wget https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.16.8/zephyr-sdk-0.16.8_macos-x86_64.tar.xz
tar xf zephyr-sdk-0.16.8_macos-x86_64.tar.xz
cd zephyr-sdk-0.16.8
./setup.sh
```

## Step 2: Environment Setup

Add to your `~/.zshrc` or `~/.bash_profile`:
```bash
# nRF Connect SDK Environment
export ZEPHYR_BASE="$HOME/nrf-workspace/zephyr"
export ZEPHYR_SDK_INSTALL_DIR="$HOME/zephyr-sdk-0.16.8"
export NRF_CONNECT_SDK_PATH="$HOME/nrf-workspace"

# Add west to PATH
export PATH="$HOME/.local/bin:$PATH"
```

Reload your shell:
```bash
source ~/.zshrc
```

## Step 3: Verify Installation

```bash
# Check west
west --version

# Check Zephyr
west zephyr-export

# Test build with a sample
cd ~/nrf-workspace
west build -b nrf5340dk_nrf5340_cpuapp samples/hello_world
```

## Step 4: Hardware Setup

### nRF5340 DK Connections:
1. Connect nRF5340 DK to your Mac via USB
2. The board should appear as a USB device
3. Install [nRF Connect for Desktop](https://www.nordicsemi.com/Software-and-Tools/Development-Tools/nRF-Connect-for-desktop)
4. Open "Programmer" app to verify connection

### Expected Device Detection:
- Device should show up in Programmer
- SEGGER J-Link should be detected
- Two cores visible: Application CPU and Network CPU

## Step 5: Build Your nRF5340 Project

```bash
# Navigate to your project
cd /Users/loayyari/Documents/Work/Mentra/Projects/esp32s3_ble_glasses_sim_bidirectional/nrf5340_ble_glasses_protobuf

# Build for nRF5340 DK
west build -b nrf5340dk_nrf5340_cpuapp

# Flash to device
west flash

# Open serial monitor
west espressif monitor
# OR use any serial terminal at 115200 baud
```

## Step 6: Alternative Development Environment

### VS Code Setup:
1. Install VS Code extensions:
   - "nRF Connect for VS Code Extension Pack"
   - "C/C++"
   - "CMake Tools"

2. Open your project in VS Code
3. Use the nRF Connect extension for building and flashing

### Command Line Build:
```bash
# Clean build
west build -b nrf5340dk_nrf5340_cpuapp --pristine

# Build with verbose output
west build -b nrf5340dk_nrf5340_cpuapp -- -DCMAKE_VERBOSE_MAKEFILE=ON

# Flash and monitor in one command
west flash && west espressif monitor
```

## Step 7: Testing with Existing Python Scripts

Once your nRF5340 is running, you can test with the same Python scripts:

```bash
# Test BLE scanning
cd /Users/loayyari/Documents/Work/Mentra/Projects/esp32s3_ble_glasses_sim_bidirectional
.venv/bin/python ble_scanner.py

# Test service discovery
.venv/bin/python service_scanner.py

# Test protobuf communication
.venv/bin/python direct_connect_test.py
```

The nRF5340 should appear as "NexSim" with the same service UUIDs as the ESP32-C3.

## Expected Advantages of nRF5340:

1. **Better BLE Performance**: Dedicated radio controller
2. **More Reliable**: Professional-grade BLE stack
3. **Better Debugging**: Advanced debugging via RTT
4. **Production Ready**: Designed for commercial products
5. **Lower Power**: Optimized for battery operation
6. **Dual Core**: Can run complex applications on app core while network core handles BLE

## Troubleshooting:

### If west is not found:
```bash
pip3 install --user west
export PATH="$HOME/.local/bin:$PATH"
```

### If build fails:
```bash
# Check environment
west --version
echo $ZEPHYR_BASE

# Clean and rebuild
rm -rf build
west build -b nrf5340dk_nrf5340_cpuapp --pristine
```

### If flashing fails:
1. Check USB connection
2. Press RESET button on nRF5340 DK
3. Try: `west flash --recover`
4. Use nRF Connect Programmer as alternative

Ready to proceed with setting up the nRF Connect SDK?
