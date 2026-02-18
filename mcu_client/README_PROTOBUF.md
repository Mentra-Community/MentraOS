# MentraOS BLE Protocol Buffer Regeneration

This directory contains the Protocol Buffer definition file for the MentraOS BLE communication protocol and tools for regenerating language-specific bindings.

## Files

- `mentraos_ble.proto` - Main protocol buffer definition file
- `regenerate_protobuf.sh` - Automated regeneration script
- `mentraos_ble_pb2.py` - Python bindings (generated)
- `README_PROTOBUF.md` - This documentation file

## Regenerating Protocol Buffer Files

### Prerequisites

- Protocol Buffers compiler (`protoc`) version 3.0 or higher
- On macOS: `brew install protobuf`
- On Ubuntu/Debian: `sudo apt-get install protobuf-compiler`

### Quick Regeneration

Run the automated script:

```bash
cd mcu_client
./regenerate_protobuf.sh
```

This script will:

1. Generate Java, Swift, C++, and Python bindings
2. Copy Java files to `android_core/app/src/main/java/mentraos/ble/`
3. Copy Swift files to iOS project locations
4. Copy Python files to the current directory
5. Clean up temporary files

### Manual Regeneration

If you prefer manual control, you can run individual commands:

```bash
# Generate Java bindings
protoc --java_out=. mentraos_ble.proto

# Generate Swift bindings
protoc --swift_out=. mentraos_ble.proto

# Generate C++ bindings
protoc --cpp_out=. mentraos_ble.proto

# Generate Python bindings
protoc --python_out=. mentraos_ble.proto
```

## Generated Files

After regeneration, the following files are created:

### Java

- **Location**: `android_core/app/src/main/java/mentraos/ble/MentraosBle.java`
- **Package**: `mentraos.ble`
- **Usage**: Android applications and libraries

### Swift

- **Location**: `mobile/ios/Source/subs/mentraos_ble.pb.swift`
- **Usage**: iOS applications

### C++

- **Files**: `mentraos_ble.pb.h`, `mentraos_ble.pb.cc`
- **Usage**: Native C++ applications, firmware

### Python

- **Location**: `mcu_client/mentraos_ble_pb2.py`
- **Usage**: Python scripts, testing, development tools

## Protocol Version

The current protocol version is defined in the `VersionResponse` message. When making breaking changes to the protocol:

1. Increment the version number in `mentraos_ble.proto`
2. Regenerate all bindings
3. Update any version-checking logic in applications
4. Test compatibility between old and new versions

## Important Notes

- **Never edit generated files directly** - they will be overwritten on regeneration
- **Always regenerate after protocol changes** - this ensures consistency across all platforms
- **Rebuild projects after regeneration** - generated files may have different timestamps
- **Test thoroughly** - protocol changes can break communication between devices

## Troubleshooting

### Common Issues

1. **Protoc not found**: Install Protocol Buffers compiler
2. **Permission denied**: Make script executable with `chmod +x regenerate_protobuf.sh`
3. **File not found errors**: Ensure you're running from the `mcu_client` directory
4. **Build errors**: Clean and rebuild your projects after regeneration

### Getting Help

- Check protoc version: `protoc --version`
- Verify file paths in the regeneration script
- Ensure all target directories exist
- Check file permissions and ownership
