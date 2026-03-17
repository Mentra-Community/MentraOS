#!/bin/bash
# scripts/fetch-incident-logs.sh
# Fetch incident logs for debugging bug reports
# Usage: ./scripts/fetch-incident-logs.sh <incidentId>

set -e

INCIDENT_ID=$1
API_HOST="${MENTRA_API_HOST:-https://api.mentra.glass}"

if [ -z "$INCIDENT_ID" ]; then
  echo "Usage: ./scripts/fetch-incident-logs.sh <incidentId>"
  echo "Example: ./scripts/fetch-incident-logs.sh 01HXYZ..."
  echo ""
  echo "Required environment variables:"
  echo "  MENTRA_AGENT_API_KEY - API key for agent access"
  echo ""
  echo "Optional environment variables:"
  echo "  MENTRA_API_HOST - API host (default: https://api.mentra.glass)"
  exit 1
fi

if [ -z "$MENTRA_AGENT_API_KEY" ]; then
  echo "Error: MENTRA_AGENT_API_KEY environment variable not set"
  echo ""
  echo "To set this:"
  echo "  export MENTRA_AGENT_API_KEY=your-api-key"
  exit 1
fi

echo "Fetching incident logs for: $INCIDENT_ID" >&2
echo "API host: $API_HOST" >&2

curl -s -H "X-Agent-Key: $MENTRA_AGENT_API_KEY" \
  "$API_HOST/api/agent/incidents/$INCIDENT_ID/logs" | jq .
