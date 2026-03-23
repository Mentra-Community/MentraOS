#!/usr/bin/env python3
"""
BLE Device Scanner - Find ESP32-S3 device details
"""

import asyncio
from bleak import BleakScanner

async def detailed_scan():
    print("🔍 Scanning for all BLE devices with detailed info...")
    print("=" * 60)
    
    devices = await BleakScanner.discover(timeout=15.0)
    
    print(f"Found {len(devices)} BLE devices:")
    print()
    
    esp32_candidates = []
    
    for i, device in enumerate(devices, 1):
        name = device.name or "Unknown"
        print(f"{i:2d}. Name: {name}")
        print(f"    Address: {device.address}")
        
        # Look for ESP32 or Mentra devices
        if any(keyword in name.lower() for keyword in ['esp32', 'mentra', 'glass', 'demo']):
            esp32_candidates.append((i, device))
            print(f"    🎯 POTENTIAL ESP32-S3 CANDIDATE!")
        
        # Also check for devices with MAC addresses starting with common ESP32 prefixes
        mac_prefixes = ['d8:3b:da', '24:6f:28', '30:ae:a4', 'a0:76:4e']
        if any(device.address.lower().startswith(prefix) for prefix in mac_prefixes):
            esp32_candidates.append((i, device))
            print(f"    🔍 ESP32 MAC PREFIX DETECTED!")
            
        print()
    
    if esp32_candidates:
        print("🎯 ESP32-S3 Candidates Found:")
        for idx, device in esp32_candidates:
            print(f"  {idx}. {device.name or 'Unknown'} ({device.address})")
    else:
        print("❌ No obvious ESP32-S3 candidates found")
        print("💡 Your device might be advertising with a different name")
        print("💡 Try looking for devices with strong RSSI (close to you)")

if __name__ == "__main__":
    asyncio.run(detailed_scan())
