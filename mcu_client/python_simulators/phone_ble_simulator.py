#!/usr/bin/env python3
"""
Phone BLE Simulator for ESP32-S3 Glasses
Simulates a phone connecting to the ESP32-S3 BLE device and sends protobuf messages
"""

import asyncio
import sys
import struct
import time
from bleak import BleakClient, BleakScanner
from bleak.exc import BleakError

# ESP32-S3 BLE Configuration
SERVICE_UUID = "00004860-0000-1000-8000-00805f9b34fb"
CHAR_TX_UUID = "000071FF-0000-1000-8000-00805f9b34fb"  # Phone → Glasses
CHAR_RX_UUID = "000070FF-0000-1000-8000-00805f9b34fb"  # Glasses → Phone

# MentraOS Protocol Headers
PROTOBUF_HEADER = 0x02
AUDIO_HEADER = 0xA0
IMAGE_HEADER = 0xB0

class PhoneBLESimulator:
    def __init__(self):
        self.client = None
        self.device = None
        self.connected = False
        
    async def scan_for_device(self, device_name_prefix="NexSim"):
        """Scan for the ESP32-S3 device"""
        print(f"🔍 Scanning for devices starting with '{device_name_prefix}'...")
        
        devices = await BleakScanner.discover(timeout=10.0)
        
        print(f"Found {len(devices)} BLE devices:")
        for i, device in enumerate(devices):
            name = device.name or "Unknown"
            print(f"  {i+1}. {name} ({device.address})")
            
        # Look for our target device
        target_devices = [d for d in devices if d.name and device_name_prefix in d.name]
        
        if not target_devices:
            print(f"❌ No device found with name containing '{device_name_prefix}'")
            print("🔍 Falling back to service UUID scan...")
            
            # Fallback: scan for devices with our service UUID
            for device in devices:
                try:
                    if device.name:
                        print(f"  Checking {device.name}...")
                        client = BleakClient(device.address)
                        await client.connect()
                        services = await client.get_services()
                        
                        if SERVICE_UUID in [str(service.uuid) for service in services]:
                            print(f"✅ Found device with matching service: {device.name} ({device.address})")
                            await client.disconnect()
                            self.device = device
                            return self.device
                        
                        await client.disconnect()
                except Exception as e:
                    # Skip devices we can't connect to
                    continue
            
            print("Available devices:")
            for device in devices:
                if device.name:
                    print(f"  - {device.name} ({device.address})")
            return None
            
        self.device = target_devices[0]
        print(f"✅ Found target device: {self.device.name} ({self.device.address})")
        return self.device

    async def connect(self):
        """Connect to the ESP32-S3 device"""
        if not self.device:
            print("❌ No device to connect to. Run scan first.")
            return False
            
        try:
            print(f"🔗 Connecting to {self.device.name}...")
            self.client = BleakClient(self.device.address)
            await self.client.connect()
            
            # Verify we're connected and can see the service
            services = await self.client.get_services()
            target_service = None
            
            for service in services:
                if service.uuid.lower() == SERVICE_UUID.lower():
                    target_service = service
                    break
                    
            if not target_service:
                print(f"❌ Service {SERVICE_UUID} not found")
                await self.client.disconnect()
                return False
                
            print(f"✅ Connected! Found service: {target_service.uuid}")
            
            # List characteristics
            for char in target_service.characteristics:
                props = ", ".join(char.properties)
                print(f"  📡 Characteristic: {char.uuid} ({props})")
                
            self.connected = True
            return True
            
        except BleakError as e:
            print(f"❌ Connection failed: {e}")
            return False

    async def setup_notifications(self):
        """Setup notifications from the glasses"""
        try:
            await self.client.start_notify(CHAR_RX_UUID, self.notification_handler)
            print(f"🔔 Subscribed to notifications on {CHAR_RX_UUID}")
            return True
        except Exception as e:
            print(f"❌ Failed to setup notifications: {e}")
            return False

    def notification_handler(self, sender, data):
        """Handle notifications from the glasses"""
        print(f"\n📨 Received notification from {sender}:")
        print(f"   Raw data ({len(data)} bytes): {data.hex().upper()}")
        print(f"   ASCII: '{data.decode('utf-8', errors='ignore')}'")

    async def send_protobuf_message(self, message_data):
        """Send a protobuf message with proper header"""
        if not self.connected:
            print("❌ Not connected to device")
            return False
            
        try:
            # Prepare message with protobuf header
            full_message = bytes([PROTOBUF_HEADER]) + message_data
            
            print(f"\n📤 Sending protobuf message:")
            print(f"   Header: 0x{PROTOBUF_HEADER:02X}")
            print(f"   Data ({len(message_data)} bytes): {message_data.hex().upper()}")
            print(f"   Full message ({len(full_message)} bytes): {full_message.hex().upper()}")
            
            await self.client.write_gatt_char(CHAR_TX_UUID, full_message)
            print("✅ Message sent successfully!")
            return True
            
        except Exception as e:
            print(f"❌ Failed to send message: {e}")
            return False

    async def send_test_messages(self):
        """Send various test messages"""
        test_messages = [
            {
                "name": "Simple Text",
                "data": b"Hello ESP32-S3!"
            },
            {
                "name": "Simulated Protobuf",
                "data": b"\x08\x96\x01\x12\x04test"  # Simple protobuf-like data
            },
            {
                "name": "Binary Data",
                "data": b"\x00\x01\x02\x03\x04\x05"
            },
            {
                "name": "JSON-like",
                "data": b'{"action":"test","value":123}'
            }
        ]
        
        for i, msg in enumerate(test_messages, 1):
            print(f"\n🧪 Test {i}: {msg['name']}")
            await self.send_protobuf_message(msg['data'])
            await asyncio.sleep(2)  # Wait between messages

    async def send_audio_data(self):
        """Send simulated audio data"""
        audio_data = b"\x01\x02\x03\x04" * 16  # Simulate audio samples
        full_message = bytes([AUDIO_HEADER]) + audio_data
        
        print(f"\n🎵 Sending audio data:")
        print(f"   Header: 0x{AUDIO_HEADER:02X}")
        print(f"   Data ({len(audio_data)} bytes): {audio_data[:16].hex().upper()}...")
        
        try:
            await self.client.write_gatt_char(CHAR_TX_UUID, full_message)
            print("✅ Audio data sent!")
        except Exception as e:
            print(f"❌ Failed to send audio: {e}")

    async def send_image_data(self):
        """Send simulated image data"""
        image_data = b"\xFF\xD8\xFF\xE0" + b"\x00" * 32  # Simulate JPEG header + data
        full_message = bytes([IMAGE_HEADER]) + image_data
        
        print(f"\n📸 Sending image data:")
        print(f"   Header: 0x{IMAGE_HEADER:02X}")
        print(f"   Data ({len(image_data)} bytes): {image_data[:16].hex().upper()}...")
        
        try:
            await self.client.write_gatt_char(CHAR_TX_UUID, full_message)
            print("✅ Image data sent!")
        except Exception as e:
            print(f"❌ Failed to send image: {e}")

    async def interactive_mode(self):
        """Interactive mode for manual testing"""
        print("\n🎮 Entering interactive mode...")
        print("Commands:")
        print("  1 - Send test protobuf messages")
        print("  2 - Send audio data")
        print("  3 - Send image data")
        print("  4 - Send custom message")
        print("  q - Quit")
        
        while self.connected:
            try:
                choice = input("\nEnter command: ").strip().lower()
                
                if choice == 'q':
                    break
                elif choice == '1':
                    await self.send_test_messages()
                elif choice == '2':
                    await self.send_audio_data()
                elif choice == '3':
                    await self.send_image_data()
                elif choice == '4':
                    custom_msg = input("Enter custom message (text): ")
                    await self.send_protobuf_message(custom_msg.encode('utf-8'))
                else:
                    print("❌ Invalid command")
                    
            except KeyboardInterrupt:
                print("\n🛑 Interrupted by user")
                break
            except Exception as e:
                print(f"❌ Error: {e}")

    async def disconnect(self):
        """Disconnect from the device"""
        if self.client and self.connected:
            try:
                await self.client.disconnect()
                print("🔌 Disconnected from device")
            except Exception as e:
                print(f"❌ Error during disconnect: {e}")
        self.connected = False

async def main():
    print("📱 Phone BLE Simulator for ESP32-C3 Glasses")
    print("=" * 50)
    
    simulator = PhoneBLESimulator()
    
    try:
        # Scan for device
        device = await simulator.scan_for_device()
        if not device:
            return
        
        # Connect
        if not await simulator.connect():
            return
        
        # Setup notifications
        await simulator.setup_notifications()
        
        # Run interactive mode
        await simulator.interactive_mode()
        
    except KeyboardInterrupt:
        print("\n🛑 Interrupted by user")
    except Exception as e:
        print(f"❌ Unexpected error: {e}")
    finally:
        await simulator.disconnect()

if __name__ == "__main__":
    # Check if bleak is installed
    try:
        import bleak
    except ImportError:
        print("❌ 'bleak' library not found. Install with:")
        print("   pip install bleak")
        sys.exit(1)
    
    asyncio.run(main())
