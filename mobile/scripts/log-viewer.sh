#!/bin/bash
# MentraOS Log Viewer - Enhanced battlefield visibility
# Usage: bun run start 2>&1 | ./scripts/log-viewer.sh

# Color codes for different subsystems
CORE='\033[1;36m'    # Cyan
SOCKET='\033[1;33m'  # Yellow
MAN='\033[1;35m'     # Magenta
LIVE='\033[1;32m'    # Green
MIC='\033[1;34m'     # Blue
ERROR='\033[1;31m'   # Red
WARN='\033[0;33m'    # Orange
RESET='\033[0m'      # Reset
DIM='\033[2m'        # Dim for line numbers

while IFS= read -r line; do
  # Extract line number if present
  if [[ $line =~ ^[[:space:]]*([0-9]+)\|(.*) ]]; then
    linenum="${BASH_REMATCH[1]}"
    content="${BASH_REMATCH[2]}"
    
    # Color based on subsystem
    if [[ $content == *"CORE:"* ]]; then
      echo -e "${DIM}${linenum}|${RESET}${CORE}${content}${RESET}"
    elif [[ $content == *"SOCKET:"* ]]; then
      echo -e "${DIM}${linenum}|${RESET}${SOCKET}${content}${RESET}"
    elif [[ $content == *"MAN:"* ]]; then
      echo -e "${DIM}${linenum}|${RESET}${MAN}${content}${RESET}"
    elif [[ $content == *"LIVE:"* ]]; then
      echo -e "${DIM}${linenum}|${RESET}${LIVE}${content}${RESET}"
    elif [[ $content == *"MIC:"* ]]; then
      echo -e "${DIM}${linenum}|${RESET}${MIC}${content}${RESET}"
    elif [[ $content == *"ERROR"* ]] || [[ $content == *"Error"* ]]; then
      echo -e "${DIM}${linenum}|${RESET}${ERROR}${content}${RESET}"
    elif [[ $content == *"WARN"* ]] || [[ $content == *"Warn"* ]]; then
      echo -e "${DIM}${linenum}|${RESET}${WARN}${content}${RESET}"
    else
      echo -e "${DIM}${linenum}|${RESET}${content}"
    fi
  else
    # No line number, just color the content
    if [[ $line == *"CORE:"* ]]; then
      echo -e "${CORE}${line}${RESET}"
    elif [[ $line == *"SOCKET:"* ]]; then
      echo -e "${SOCKET}${line}${RESET}"
    elif [[ $line == *"MAN:"* ]]; then
      echo -e "${MAN}${line}${RESET}"
    elif [[ $line == *"LIVE:"* ]]; then
      echo -e "${LIVE}${line}${RESET}"
    elif [[ $line == *"MIC:"* ]]; then
      echo -e "${MIC}${line}${RESET}"
    elif [[ $line == *"ERROR"* ]] || [[ $line == *"Error"* ]]; then
      echo -e "${ERROR}${line}${RESET}"
    elif [[ $line == *"WARN"* ]] || [[ $line == *"Warn"* ]]; then
      echo -e "${WARN}${line}${RESET}"
    else
      echo "$line"
    fi
  fi
done

