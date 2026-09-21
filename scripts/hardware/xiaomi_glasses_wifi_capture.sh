#!/bin/bash

# Xiaomi AI Glasses WiFi Password Capture Script
# This script monitors logcat for WiFi credentials when photo sync is triggered

echo "🔍 Xiaomi AI Glasses WiFi Password Capture"
echo "==========================================="
echo "1. Make sure your phone is connected via ADB"
echo "2. Trigger photo sync in the Xiaomi app"
echo "3. When WiFi notification appears, DON'T connect on phone"
echo "4. Use the captured credentials to connect from PC"
echo ""
echo "Press Ctrl+C to stop monitoring"
echo ""

# Clear any existing logcat buffer
adb logcat -c

# Monitor logcat for WiFi credentials
echo "🔍 Monitoring logcat for WiFi credentials..."
adb logcat -s O95FileSpace | while read line; do
    # Check if this line contains WiFi credentials
    if echo "$line" | grep -q "wiFi AP"; then
        echo ""
        echo "🎯 WIFI CREDENTIALS DETECTED:"
        echo "================================"
        echo "$line"
        
        # Extract SSID
        SSID=$(echo "$line" | sed -n 's/.*ssid: "\([^"]*\)".*/\1/p')
        
        # Extract password
        PASSWORD=$(echo "$line" | sed -n 's/.*password: "\([^"]*\)".*/\1/p')
        
        # Extract gateway
        GATEWAY=$(echo "$line" | sed -n 's/.*gateway: "\([^"]*\)".*/\1/p')
        
        if [ ! -z "$SSID" ] && [ ! -z "$PASSWORD" ] && [ ! -z "$GATEWAY" ]; then
            echo ""
            echo "📱 EXTRACTED CREDENTIALS:"
            echo "========================"
            echo "SSID: $SSID"
            echo "Password: $PASSWORD"
            echo "Gateway: $GATEWAY"
            echo "API Base: http://$GATEWAY:8080/v1/"
            echo ""
            echo "💻 PC CONNECTION COMMAND:"
            echo "========================"
            echo "Connect to WiFi network '$SSID' with password '$PASSWORD'"
            echo "Then access: http://$GATEWAY:8080/v1/filelists"
            echo ""
            
            # Save to file for later use
            echo "SSID=$SSID" > /tmp/xiaomi_wifi_credentials.txt
            echo "PASSWORD=$PASSWORD" >> /tmp/xiaomi_wifi_credentials.txt
            echo "GATEWAY=$GATEWAY" >> /tmp/xiaomi_wifi_credentials.txt
            echo "API_BASE=http://$GATEWAY:8080/v1/" >> /tmp/xiaomi_wifi_credentials.txt
            
            echo "📁 Credentials saved to: /tmp/xiaomi_wifi_credentials.txt"
        fi
    fi
done