#!/usr/bin/env python3
"""
Service UUID Scanner - Find device by service UUID
"""

import asyncio
from bleak import BleakClient, BleakScanner
from bleak.exc import BleakError

SERVICE_UUID = "00004860-0000-1000-8000-00805f9b34fb"

async def scan_by_service():
    print("🔍 Scanning for devices with our specific service UUID...")
    print(f"Looking for service: {SERVICE_UUID}")
    print("=" * 60)
    
    devices = await BleakScanner.discover(timeout=15.0)
    
    print(f"Found {len(devices)} BLE devices, checking each for our service...")
    print()
    
    candidates = []
    
    for i, device in enumerate(devices, 1):
        name = device.name or "Unknown"
        print(f"{i:2d}. Checking: {name} ({device.address})")
        
        try:
            # Try to connect and check services
            client = BleakClient(device.address)
            await client.connect()
            
            if client.is_connected:
                services = client.services
                for service in services:
                    if service.uuid.lower() == SERVICE_UUID.lower():
                        print(f"    🎯 FOUND ESP32-S3! Service UUID matches!")
                        candidates.append(device)
                        
                        # Show characteristics
                        for char in service.characteristics:
                            props = ", ".join(char.properties)
                            print(f"    📡 Characteristic: {char.uuid} ({props})")
                        break
                else:
                    print(f"    ❌ Service not found")
                    
                await client.disconnect()
            else:
                print(f"    ❌ Could not connect")
                    
        except BleakError as e:
            print(f"    ❌ Connection error: {str(e)[:50]}...")
        except Exception as e:
            print(f"    ❌ Error: {str(e)[:50]}...")
        
        # Small delay between attempts
        await asyncio.sleep(0.5)
    
    print()
    if candidates:
        print("🎯 ESP32-S3 Device Found!")
        for device in candidates:
            print(f"  Name: {device.name or 'Unknown'}")
            print(f"  Address: {device.address}")
            return candidates[0]
    else:
        print("❌ No device found with our service UUID")
        print("💡 The ESP32-S3 might not be advertising properly")
        print("💡 Try restarting the ESP32-S3 or check the serial monitor")
        return None

if __name__ == "__main__":
    device = asyncio.run(scan_by_service())
    if device:
        print(f"\n✅ Ready to connect to: {device.name or 'Unknown'} ({device.address})")
    else:
        print(f"\n❌ No compatible device found")
