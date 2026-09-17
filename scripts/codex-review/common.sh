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

# Classify `git status --porcelain=v2` output read from stdin.
# untracked_paths: paths git reports as untracked.
# dirty_gitlinks:  submodules (gitlinks) that are not clean: a different commit checked
#                  out, modified tracked content, or untracked content inside them.
untracked_paths() { awk '$1 == "?" { sub(/^\? /, ""); print }'; }
dirty_gitlinks() { awk '($1 == "1" || $1 == "2") && substr($3, 1, 1) == "S" { print $NF }'; }
