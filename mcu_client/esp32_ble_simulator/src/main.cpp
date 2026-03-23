
#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define SERVICE_UUID        "00004860-0000-1000-8000-00805f9b34fb"
#define CHAR_TX_UUID        "000071FF-0000-1000-8000-00805f9b34fb"  // Phone → Glasses
#define CHAR_RX_UUID        "000070FF-0000-1000-8000-00805f9b34fb"  // Glasses → Phone

BLECharacteristic *pRxCharacteristic;
BLECharacteristic *pTxCharacteristic;
BLEServer *pServer;

class SimpleWriteCallback: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
        std::string value = pCharacteristic->getValue();
        if (value.length() == 0) {
            Serial.println("[BLE] Received empty data - ignoring");
            return;
        }

        Serial.println("\n=== BLE DATA RECEIVED ===");
        Serial.print("[ESP32-C3] Received BLE data (");
        Serial.print(value.length());
        Serial.print(" bytes): ");
        for (int i = 0; i < value.length(); i++) {
            Serial.print("0x");
            if ((uint8_t)value[i] < 0x10) Serial.print("0");
            Serial.print((uint8_t)value[i], HEX);
            Serial.print(" ");
        }
        Serial.println();
        
        // Check if this looks like a protobuf message (starts with control header)
        uint8_t firstByte = (uint8_t)value[0];
        if (firstByte == 0x02) {
            Serial.println("[PROTOBUF] Control header detected: 0x02 (Protobuf message)");
        } else if (firstByte == 0xA0) {
            Serial.println("[AUDIO] Control header detected: 0xA0 (Audio data)");
        } else if (firstByte == 0xB0) {
            Serial.println("[IMAGE] Control header detected: 0xB0 (Image data)");
        } else {
            Serial.print("[UNKNOWN] Unknown control header: 0x");
            Serial.println(firstByte, HEX);
        }
        
        // Show raw ASCII if printable
        Serial.print("[ASCII] Raw string: \"");
        for (int i = 0; i < value.length(); i++) {
            if (value[i] >= 32 && value[i] <= 126) {
                Serial.print((char)value[i]);
            } else {
                Serial.print(".");
            }
        }
        Serial.println("\"");
        
        // Simple echo response
        String response = "Echo: Received " + String(value.length()) + " bytes";
        pTxCharacteristic->setValue(response.c_str());
        pTxCharacteristic->notify();
        Serial.println("[ESP32-C3] Sent echo response: " + response);
        Serial.println("=== END BLE DATA ===\n");
    }
};

class ServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServerCallbacks* pServer) {
        Serial.println("[ESP32-C3] *** CLIENT CONNECTED! ***");
        Serial.println("[ESP32-C3] Connection established successfully");
    }

    void onDisconnect(BLEServerCallbacks* pServer) {
        Serial.println("[ESP32-C3] *** CLIENT DISCONNECTED! ***");
        Serial.println("[ESP32-C3] Reason: Connection lost or timeout");
        // Small delay before restarting advertising
        delay(500);
        BLEDevice::startAdvertising();
        Serial.println("[ESP32-C3] Restarted advertising");
    }
};

void setup() {
    Serial.begin(115200);
    delay(3000);  // Give time to connect serial monitor
    Serial.println("=== ESP32-C3 BLE Glasses Simulator ===");
    Serial.println("Device started successfully!");
    Serial.println("Waiting 5 seconds for serial monitor connection...");
    delay(5000);  // Additional delay to ensure serial monitor is connected
    
    // Get MAC address for device name
    uint64_t macAddress = ESP.getEfuseMac();
    String macStr = String(macAddress, HEX);
    macStr.toUpperCase();
    String shortMac = macStr.substring(macStr.length() - 6);
    String deviceName = "NexSim " + shortMac;
    
    Serial.println("MAC Address: " + macStr);
    Serial.println("Device Name: " + deviceName);
    
    // Initialize BLE
    Serial.println("Initializing BLE...");
    BLEDevice::init(deviceName.c_str());
    Serial.println("BLE Device initialized");
    
    // Create BLE Server
    pServer = BLEDevice::createServer();
    Serial.println("BLE Server created");
    pServer->setCallbacks(new ServerCallbacks());
    Serial.println("Server callbacks set");
    
    // Create BLE Service
    BLEService *pService = pServer->createService(SERVICE_UUID);
    Serial.println("BLE Service created with UUID: " SERVICE_UUID);

    // Create characteristics
    Serial.println("Creating TX characteristic...");
    pTxCharacteristic = pService->createCharacteristic(
                          CHAR_RX_UUID,
                          BLECharacteristic::PROPERTY_NOTIFY
                        );
    
    BLE2902* pBLE2902 = new BLE2902();
    pBLE2902->setNotifications(true);
    pTxCharacteristic->addDescriptor(pBLE2902);
    Serial.println("TX characteristic created with notifications enabled");

    Serial.println("Creating RX characteristic...");
    pRxCharacteristic = pService->createCharacteristic(
                          CHAR_TX_UUID,
                          BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
                        );
    pRxCharacteristic->setCallbacks(new SimpleWriteCallback());
    Serial.println("RX characteristic created with write properties");

    // Start the service
    Serial.println("Starting BLE service...");
    pService->start();
    Serial.println("BLE service started");
    
    // Start advertising with minimal configuration
    Serial.println("Setting up advertising...");
    BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
    
    // Use the simplest possible advertising setup
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(false);  // Disable scan response for now
    
    Serial.println("Starting advertising...");
    BLEDevice::startAdvertising();
    Serial.println("BLE advertising started!");
    
    Serial.println("BLE service started successfully!");
    Serial.println("Service UUID: " SERVICE_UUID);
    Serial.println("TX Characteristic (Glasses->Phone): " CHAR_RX_UUID);
    Serial.println("RX Characteristic (Phone->Glasses): " CHAR_TX_UUID);
    Serial.println("Waiting for BLE connections...");
    Serial.println("Ready for testing!");
    Serial.println("=== Send data via BLE to see protobuf logs ===");
}

void loop() {
    static unsigned long lastPrint = 0;
    unsigned long now = millis();
    
    // Check for serial input to show device info
    if (Serial.available()) {
        while (Serial.available()) {
            Serial.read(); // Clear the buffer
        }
        
        // Re-display device information
        Serial.println("\n=== DEVICE INFO (on demand) ===");
        uint64_t macAddress = ESP.getEfuseMac();
        String macStr = String(macAddress, HEX);
        macStr.toUpperCase();
        String shortMac = macStr.substring(macStr.length() - 6);
        String deviceName = "NexSim " + shortMac;
        
        Serial.println("MAC Address: " + macStr);
        Serial.println("Device Name: " + deviceName);
        Serial.println("Service UUID: " SERVICE_UUID);
        Serial.println("TX Characteristic (Glasses->Phone): " CHAR_RX_UUID);
        Serial.println("RX Characteristic (Phone->Glasses): " CHAR_TX_UUID);
        Serial.println("BLE Status: " + String(pServer->getConnectedCount() > 0 ? "CONNECTED" : "ADVERTISING"));
        Serial.println("=== Connect with nRF Connect or BLE app to test ===\n");
    }
    
    if (now - lastPrint > 10000) {  // Every 10 seconds instead of 5
        Serial.print("[HEARTBEAT] Uptime: ");
        Serial.print(now / 1000);
        Serial.print(" seconds | BLE Status: ");
        if (pServer->getConnectedCount() > 0) {
            Serial.println("CONNECTED");
        } else {
            Serial.println("ADVERTISING");
        }
        lastPrint = now;
    }
    
    delay(1000);
}
