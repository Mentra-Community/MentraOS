#!/bin/bash

# iOS Setup Script for MentraOS Mobile
# This script automates the iOS development environment setup process

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to check if we're in the mobile directory
check_directory() {
    if [[ ! -f "package.json" ]] || [[ ! -d "ios" ]]; then
        print_error "This script must be run from the mobile directory"
        print_status "Please run: cd mobile && ./setup-ios.sh"
        exit 1
    fi
}

# Function to install dependencies if not present
install_dependencies() {
    print_status "Checking for required dependencies..."
    
    # Check for Homebrew
    if ! command_exists brew; then
        print_error "Homebrew is not installed. Please install it first:"
        print_status "/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        exit 1
    fi
    
    # Check and install swiftformat
    if ! command_exists swiftformat; then
        print_status "Installing swiftformat..."
        brew install swiftformat
        print_success "swiftformat installed"
    else
        print_success "swiftformat already installed"
    fi
    
    # Check and install bun
    if ! command_exists bun; then
        print_status "Installing bun..."
        brew install bun
        print_success "bun installed"
    else
        print_success "bun already installed"
    fi
    
    # Check and install OpenJDK 17
    if ! command_exists java || ! java -version 2>&1 | grep -q "17"; then
        print_status "Installing OpenJDK 17..."
        brew install openjdk@17
        print_warning "You may need to add OpenJDK 17 to your PATH:"
        print_status "echo 'export PATH=\"/opt/homebrew/opt/openjdk@17/bin:\$PATH\"' >> ~/.zshrc"
        print_status "source ~/.zshrc"
    else
        print_success "OpenJDK 17 already installed"
    fi
}

# Function to run the setup process
run_setup() {
    print_status "Starting iOS setup process..."
    
    # Step 1: Install npm dependencies
    print_status "Installing npm dependencies..."
    bun install
    print_success "Dependencies installed"
    
    # Step 2: Run expo prebuild
    print_status "Running expo prebuild..."
    bun expo prebuild
    print_success "Expo prebuild completed"
    
    # Step 3: Install CocoaPods dependencies
    print_status "Installing CocoaPods dependencies..."
    cd ios
    
    # Clean up any existing pods and update repos to resolve version conflicts
    print_status "Cleaning up existing pods and updating repos..."
    pod repo update
    pod deintegrate || true  # Ignore errors if no existing integration
    pod cache clean --all || true  # Clean pod cache
    
    # Install pods with repo update to resolve WebRTC-SDK version conflicts
    print_status "Installing pods with updated dependencies..."
    pod install --repo-update
    
    cd ..
    print_success "CocoaPods dependencies installed"
    
    # Step 4: Open Xcode workspace
    print_status "Opening Xcode workspace..."
    open ios/MentraOS.xcworkspace
    print_success "Xcode workspace opened"
    
    print_warning "Manual step required: Install a dev build on your phone using Xcode"
    print_status "Once you've installed the dev build, you can start the Metro bundler with:"
    print_status "bun run start"
}

# Function to start Metro bundler
start_metro() {
    print_status "Starting Metro bundler..."
    bun run start
}

# Function to fix CocoaPods dependency conflicts
fix_pod_conflicts() {
    print_status "Fixing CocoaPods dependency conflicts..."
    cd ios
    
    # Update CocoaPods repos
    print_status "Updating CocoaPods repository..."
    pod repo update
    
    # Clean existing integration and cache
    print_status "Cleaning existing pod integration..."
    pod deintegrate || true
    pod cache clean --all || true
    
    # Remove Podfile.lock to force fresh resolution
    if [[ -f "Podfile.lock" ]]; then
        print_status "Removing existing Podfile.lock for fresh dependency resolution..."
        rm Podfile.lock
    fi
    
    # Install with repo update to get latest compatible versions
    print_status "Installing pods with updated dependencies..."
    pod install --repo-update
    
    cd ..
    print_success "CocoaPods dependency conflicts resolved"
}

# Main execution
main() {
    echo "=========================================="
    echo "    MentraOS iOS Setup Script"
    echo "=========================================="
    echo
    
    # Check if we're in the right directory
    check_directory
    
    # Parse command line arguments
    case "${1:-setup}" in
        "setup")
            install_dependencies
            run_setup
            ;;
        "start")
            start_metro
            ;;
        "deps")
            install_dependencies
            ;;
        "fix-pods")
            fix_pod_conflicts
            ;;
        "help"|"-h"|"--help")
            echo "Usage: $0 [command]"
            echo
            echo "Commands:"
            echo "  setup     Run full iOS setup (default)"
            echo "  start     Start Metro bundler"
            echo "  deps      Install dependencies only"
            echo "  fix-pods  Fix CocoaPods dependency conflicts"
            echo "  help      Show this help message"
            ;;
        *)
            print_error "Unknown command: $1"
            print_status "Use '$0 help' for usage information"
            exit 1
            ;;
    esac
    
    echo
    print_success "iOS setup completed successfully!"
}

# Run main function
main "$@"
