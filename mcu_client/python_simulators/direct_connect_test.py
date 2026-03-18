#!/usr/bin/env python3
"""
Direct Connect Test for ESP32-C3
Connects directly to the known device address for testing
"""

import asyncio
import struct
from bleak import BleakClient
from bleak.exc import BleakError

# ESP32-C3 BLE Configuration  
SERVICE_UUID = "00004860-0000-1000-8000-00805f9b34fb"
CHAR_TX_UUID = "000071FF-0000-1000-8000-00805f9b34fb"  # Phone → Glasses
CHAR_RX_UUID = "000070FF-0000-1000-8000-00805f9b34fb"  # Glasses → Phone

# Known device address from service scanner
DEVICE_ADDRESS = "A39AA207-99C6-6C2C-445A-A204D2B42C55"

# MentraOS Protocol Headers
PROTOBUF_HEADER = 0x02
AUDIO_HEADER = 0xA0  
IMAGE_HEADER = 0xB0

async def notification_handler(sender, data):
    """Handle notifications from ESP32-C3"""
    print(f"\n📥 Received notification from {sender}:")
    print(f"Raw data: {data.hex()}")
    try:
        message = data.decode('utf-8')
        print(f"Message: {message}")
    except:
        print(f"Binary data: {[hex(b) for b in data]}")

async def test_connection():
    """Test connection and send protobuf messages"""
    print("📱 Direct ESP32-C3 Connection Test")
    print("=" * 50)
    
    try:
        print(f"🔗 Connecting to {DEVICE_ADDRESS}...")
        client = BleakClient(DEVICE_ADDRESS)
        await client.connect()
        print("✅ Connected!")
        
        # Check services
        services = await client.get_services()
        print(f"📋 Found {len(services)} services")
        
        target_service = None
        for service in services:
            print(f"  Service: {service.uuid}")
            if str(service.uuid) == SERVICE_UUID:
                target_service = service
                print(f"  ✅ Found target service: {service.uuid}")
                
                for char in service.characteristics:
                    print(f"    Characteristic: {char.uuid} - {char.properties}")
        
        if not target_service:
            print("❌ Target service not found!")
            await client.disconnect()
            return
            
        # Enable notifications
        print("🔔 Enabling notifications...")
        await client.start_notify(CHAR_RX_UUID, notification_handler)
        
        # Test 1: Send protobuf message
        print("\n📤 Test 1: Sending protobuf message...")
        protobuf_data = struct.pack('B', PROTOBUF_HEADER) + b"Hello ESP32-C3!"
        await client.write_gatt_char(CHAR_TX_UUID, protobuf_data, response=False)
        print(f"Sent: {protobuf_data.hex()}")
        
        await asyncio.sleep(2)
        
        # Test 2: Send audio header message
        print("\n📤 Test 2: Sending audio message...")
        audio_data = struct.pack('B', AUDIO_HEADER) + b"Audio test data"
        await client.write_gatt_char(CHAR_TX_UUID, audio_data, response=False)
        print(f"Sent: {audio_data.hex()}")
        
        await asyncio.sleep(2)
        
        # Test 3: Send image header message
        print("\n📤 Test 3: Sending image message...")
        image_data = struct.pack('B', IMAGE_HEADER) + b"Image test data"  
        await client.write_gatt_char(CHAR_TX_UUID, image_data, response=False)
        print(f"Sent: {image_data.hex()}")
        
        await asyncio.sleep(2)
        
        # Test 4: Send unknown header
        print("\n📤 Test 4: Sending unknown header...")
        unknown_data = struct.pack('B', 0xFF) + b"Unknown data"
        await client.write_gatt_char(CHAR_TX_UUID, unknown_data, response=False)
        print(f"Sent: {unknown_data.hex()}")
        
        await asyncio.sleep(2)
        
        print("\n✅ All tests completed!")
        await client.stop_notify(CHAR_RX_UUID)
        await client.disconnect()
        print("👋 Disconnected")
        
    except BleakError as e:
        print(f"❌ BLE Error: {e}")
    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    asyncio.run(test_connection())
