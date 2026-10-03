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
# Porcelain v2 puts the path last: after 8 fields for an ordinary entry ("1"), after 9
# for a rename ("2", followed by a tab and the original path). Paths may contain spaces.
dirty_gitlinks() {
  awk '($1 == "1" || $1 == "2") && substr($3, 1, 1) == "S" {
    skip = ($1 == "1") ? 8 : 9
    line = $0
    for (i = 0; i < skip; i++) sub(/^[^ ]+ /, "", line)
    sub(/\t.*/, "", line)
    print line
  }'
}

# Submodules of the worktree at $1 that are actually checked out inside it, one path
# per line. Whether a submodule is "initialised" is recorded in the repository config,
# which linked worktrees share with the main checkout, so that flag says nothing about
# this worktree; the presence of <path>/.git does.
populated_submodules() {
  local wt="$1" mode path
  git -C "$wt" ls-files --stage -z | while IFS= read -r -d '' entry; do
    mode=${entry%% *}
    path=${entry#*$'\t'}
    [[ "$mode" == 160000 && -e "$wt/$path/.git" ]] && printf '%s\n' "$path"
  done
  return 0
}
