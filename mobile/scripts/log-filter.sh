#!/bin/bash
# MentraOS Log Filter - Focus on specific subsystems
# Usage: bun run start 2>&1 | ./scripts/log-filter.sh [SUBSYSTEM]
# Examples:
#   ./scripts/log-filter.sh CORE
#   ./scripts/log-filter.sh "CORE|SOCKET"
#   ./scripts/log-filter.sh MIC

FILTER="${1:-.*}"  # Default to show everything

# Color codes
HIGHLIGHT='\033[1;36m'
RESET='\033[0m'
DIM='\033[2m'

echo "🎯 Filtering logs for: ${FILTER}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

while IFS= read -r line; do
  if [[ $line =~ $FILTER ]]; then
    # Highlight the matching subsystem
    echo -e "${line}" | sed -E "s/(${FILTER})/${HIGHLIGHT}\1${RESET}/g"
  fi
done

