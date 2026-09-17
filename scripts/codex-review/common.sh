#!/usr/bin/env bash
# Shared helpers for the codex-review scripts. Sourced, not executed.

# Modification time of a path as epoch seconds, on GNU (`stat -c %Y`) and BSD
# (`stat -f %m`). GNU `stat -f` means filesystem status and prints text with
# exit 0, so the GNU form is tried first and the result is validated; on any
# doubt the current time is returned, which errs on the side of "fresh".
file_mtime() {
  local t
  t=$(stat -c %Y "$1" 2>/dev/null) || t=$(stat -f %m "$1" 2>/dev/null) || t=""
  [[ "$t" =~ ^[0-9]+$ ]] || t=$(date +%s)
  echo "$t"
}
