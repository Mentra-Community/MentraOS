#!/bin/bash
set -e

# Test script for Better Stack HTTP logging
# This script tests the Better Stack HTTP endpoint without needing the full Go app

echo "🧪 Testing Better Stack HTTP Logging"
echo "======================================"

# Check for required environment variables
if [ -z "$BETTERSTACK_SOURCE_TOKEN" ]; then
    echo "❌ Error: BETTERSTACK_SOURCE_TOKEN is not set"
    echo "   Please set it in your .env file or export it:"
    echo "   export BETTERSTACK_SOURCE_TOKEN=your_token_here"
    exit 1
fi

if [ -z "$BETTERSTACK_INGESTING_HOST" ]; then
    echo "❌ Error: BETTERSTACK_INGESTING_HOST is not set"
    echo "   Please set it in your .env file or export it:"
    echo "   export BETTERSTACK_INGESTING_HOST=sXXX.region.betterstackdata.com"
    exit 1
fi

echo "✅ Environment variables found:"
echo "   Token: ${BETTERSTACK_SOURCE_TOKEN:0:20}..."
echo "   Host: $BETTERSTACK_INGESTING_HOST"
echo ""

# Test 1: Single log entry
echo "📤 Test 1: Sending single log entry..."
RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST \
    "https://$BETTERSTACK_INGESTING_HOST" \
    -H "Authorization: Bearer $BETTERSTACK_SOURCE_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
        "message": "Test log from LiveKit Bridge",
        "level": "info",
        "service": "livekit-bridge",
        "dt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
    }')

HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | grep -v "HTTP_CODE")

if [ "$HTTP_CODE" = "202" ]; then
    echo "✅ Single log sent successfully (HTTP 202)"
else
    echo "❌ Failed to send single log (HTTP $HTTP_CODE)"
    echo "   Response: $BODY"
    exit 1
fi

sleep 1

# Test 2: Batch of logs
echo ""
echo "📤 Test 2: Sending batch of logs..."
RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST \
    "https://$BETTERSTACK_INGESTING_HOST" \
    -H "Authorization: Bearer $BETTERSTACK_SOURCE_TOKEN" \
    -H "Content-Type: application/json" \
    -d '[
        {
            "message": "LiveKit bridge started",
            "level": "info",
            "service": "livekit-bridge",
            "dt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
            "extra": {
                "version": "1.0.0",
                "socket": "/var/run/livekit/bridge.sock"
            }
        },
        {
            "message": "JoinRoom request received",
            "level": "info",
            "service": "livekit-bridge",
            "user_id": "test@example.com",
            "session_id": "test-session-123",
            "room_name": "test-room",
            "dt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
        },
        {
            "message": "Token validation failed",
            "level": "error",
            "service": "livekit-bridge",
            "user_id": "test@example.com",
            "error": "token is expired",
            "dt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
        }
    ]')

HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | grep -v "HTTP_CODE")

if [ "$HTTP_CODE" = "202" ]; then
    echo "✅ Batch logs sent successfully (HTTP 202)"
else
    echo "❌ Failed to send batch logs (HTTP $HTTP_CODE)"
    echo "   Response: $BODY"
    exit 1
fi

sleep 1

# Test 3: Log with all fields
echo ""
echo "📤 Test 3: Sending log with all fields..."
RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST \
    "https://$BETTERSTACK_INGESTING_HOST" \
    -H "Authorization: Bearer $BETTERSTACK_SOURCE_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
        "message": "Region switch detected",
        "level": "warn",
        "service": "livekit-bridge",
        "user_id": "isaiah@mentra.glass",
        "session_id": "session-xyz-789",
        "room_name": "isaiah@mentra.glass",
        "dt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
        "extra": {
            "old_region": "centralus",
            "new_region": "france",
            "old_url": "wss://mentraos.livekit.cloud",
            "new_url": "wss://mentraos-france.livekit.cloud",
            "action": "closing_old_connections"
        }
    }')

HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | grep -v "HTTP_CODE")

if [ "$HTTP_CODE" = "202" ]; then
    echo "✅ Complex log sent successfully (HTTP 202)"
else
    echo "❌ Failed to send complex log (HTTP $HTTP_CODE)"
    echo "   Response: $BODY"
    exit 1
fi

# Summary
echo ""
echo "🎉 All tests passed!"
echo ""
echo "📊 Next steps:"
echo "   1. Go to https://telemetry.betterstack.com/"
echo "   2. Navigate to your 'LiveKit gRPC Bridge' source"
echo "   3. You should see the test logs in Live Tail"
echo ""
echo "🔍 Try these queries:"
echo "   - service:livekit-bridge"
echo "   - service:livekit-bridge AND level:error"
echo "   - service:livekit-bridge AND user_id:test@example.com"
echo "   - service:livekit-bridge AND message:*Region switch*"
echo ""
echo "✨ Integration is working! Now update your Go code to use the logger."
