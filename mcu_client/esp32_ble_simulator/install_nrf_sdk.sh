#!/bin/bash

# nRF Connect SDK Quick Install Script for macOS
echo "🚀 Installing nRF Connect SDK..."

# Install dependencies
echo "📦 Installing dependencies..."
brew install cmake ninja dtc python3

# Install west
echo "📦 Installing west build tool..."
pip3 install --user west

# Add west to PATH
echo "🔧 Adding west to PATH..."
export PATH="$HOME/.local/bin:$PATH"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc

# Create workspace
echo "📁 Creating nRF workspace..."
mkdir -p ~/nrf-workspace
cd ~/nrf-workspace

# Initialize west workspace  
echo "🌐 Initializing west workspace..."
west init -m https://github.com/nrfconnect/sdk-nrf --mr v2.7.0

# Update workspace
echo "📥 Downloading SDK (this may take a while)..."
west update

# Install Python dependencies
echo "🐍 Installing Python dependencies..."
pip3 install --user -r zephyr/scripts/requirements.txt
pip3 install --user -r nrf/scripts/requirements.txt

# Install Zephyr SDK
echo "🔧 Installing Zephyr SDK..."
cd ~
ZEPHYR_SDK_VERSION="0.16.8"
SDK_URL="https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v${ZEPHYR_SDK_VERSION}/zephyr-sdk-${ZEPHYR_SDK_VERSION}_macos-$(uname -m).tar.xz"

curl -L "$SDK_URL" -o "zephyr-sdk-${ZEPHYR_SDK_VERSION}.tar.xz"
tar xf "zephyr-sdk-${ZEPHYR_SDK_VERSION}.tar.xz"
cd "zephyr-sdk-${ZEPHYR_SDK_VERSION}"
./setup.sh

# Set up environment variables
echo "🌍 Setting up environment variables..."
cat >> ~/.zshrc << EOF

# nRF Connect SDK Environment
export ZEPHYR_BASE="$HOME/nrf-workspace/zephyr"
export ZEPHYR_SDK_INSTALL_DIR="$HOME/zephyr-sdk-${ZEPHYR_SDK_VERSION}"
export NRF_CONNECT_SDK_PATH="$HOME/nrf-workspace"
EOF

echo ""
echo "✅ nRF Connect SDK installation complete!"
echo ""
echo "🔄 Next steps:"
echo "1. Restart your terminal or run: source ~/.zshrc"
echo "2. Restart VS Code"
echo "3. Try building again"
echo ""
echo "🧪 Test installation:"
echo "   west --version"
echo "   cd ~/nrf-workspace && west build -b nrf5340dk_nrf5340_cpuapp samples/hello_world"
