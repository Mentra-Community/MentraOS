#!/bin/bash
# MentraOS Log Dashboard - Real-time statistics and monitoring
# Usage: bun run start 2>&1 | ./scripts/log-dashboard.sh

# Counters
declare -A counters=(
  ["CORE"]=0
  ["SOCKET"]=0
  ["MAN"]=0
  ["LIVE"]=0
  ["MIC"]=0
  ["ERROR"]=0
  ["WARN"]=0
)

last_update=$(date +%s)
update_interval=2  # Update dashboard every 2 seconds

# Colors
CYAN='\033[1;36m'
YELLOW='\033[1;33m'
MAGENTA='\033[1;35m'
GREEN='\033[1;32m'
BLUE='\033[1;34m'
RED='\033[1;31m'
ORANGE='\033[0;33m'
RESET='\033[0m'
CLEAR='\033[2J\033[H'

print_dashboard() {
  echo -e "${CLEAR}"
  echo "╔════════════════════════════════════════════════════════════════╗"
  echo "║           MentraOS Development Log Dashboard                  ║"
  echo "║                  Real-time Mission Status                     ║"
  echo "╚════════════════════════════════════════════════════════════════╝"
  echo ""
  echo -e "📊 ${CYAN}Subsystem Activity Count${RESET}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  printf "  ${CYAN}%-12s${RESET} %6d logs\n" "CORE:" "${counters[CORE]}"
  printf "  ${YELLOW}%-12s${RESET} %6d logs\n" "SOCKET:" "${counters[SOCKET]}"
  printf "  ${MAGENTA}%-12s${RESET} %6d logs\n" "MAN:" "${counters[MAN]}"
  printf "  ${GREEN}%-12s${RESET} %6d logs\n" "LIVE:" "${counters[LIVE]}"
  printf "  ${BLUE}%-12s${RESET} %6d logs\n" "MIC:" "${counters[MIC]}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  printf "  ${RED}%-12s${RESET} %6d events\n" "ERRORS:" "${counters[ERROR]}"
  printf "  ${ORANGE}%-12s${RESET} %6d events\n" "WARNINGS:" "${counters[WARN]}"
  echo ""
  echo -e "📡 Last update: $(date '+%H:%M:%S')"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo -e "${CYAN}Recent Activity Stream${RESET} (last 10 entries)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# Store recent logs
recent_logs=()

while IFS= read -r line; do
  # Count subsystems
  [[ $line == *"CORE:"* ]] && ((counters[CORE]++))
  [[ $line == *"SOCKET:"* ]] && ((counters[SOCKET]++))
  [[ $line == *"MAN:"* ]] && ((counters[MAN]++))
  [[ $line == *"LIVE:"* ]] && ((counters[LIVE]++))
  [[ $line == *"MIC:"* ]] && ((counters[MIC]++))
  [[ $line == *"ERROR"* ]] || [[ $line == *"Error"* ]] && ((counters[ERROR]++))
  [[ $line == *"WARN"* ]] || [[ $line == *"Warn"* ]] && ((counters[WARN]++))
  
  # Store recent logs (keep last 10)
  recent_logs+=("$line")
  if [ ${#recent_logs[@]} -gt 10 ]; then
    recent_logs=("${recent_logs[@]:1}")
  fi
  
  # Update dashboard every N seconds
  current_time=$(date +%s)
  if [ $((current_time - last_update)) -ge $update_interval ]; then
    print_dashboard
    # Print recent logs with colors
    for log in "${recent_logs[@]}"; do
      if [[ $log == *"CORE:"* ]]; then
        echo -e "${CYAN}${log:0:100}${RESET}"
      elif [[ $log == *"SOCKET:"* ]]; then
        echo -e "${YELLOW}${log:0:100}${RESET}"
      elif [[ $log == *"MAN:"* ]]; then
        echo -e "${MAGENTA}${log:0:100}${RESET}"
      elif [[ $log == *"LIVE:"* ]]; then
        echo -e "${GREEN}${log:0:100}${RESET}"
      elif [[ $log == *"MIC:"* ]]; then
        echo -e "${BLUE}${log:0:100}${RESET}"
      elif [[ $log == *"ERROR"* ]] || [[ $log == *"Error"* ]]; then
        echo -e "${RED}${log:0:100}${RESET}"
      else
        echo "${log:0:100}"
      fi
    done
    last_update=$current_time
  fi
done

