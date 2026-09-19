#!/usr/bin/env python3
"""Add/remove only this job's keychain without racing other runners on the Mac."""
import fcntl
from pathlib import Path
import shlex
import subprocess
import sys

operation, keychain = sys.argv[1:]
if operation not in {"add", "remove"}:
    raise ValueError("Expected add or remove")
lock = Path.home() / "Library/Caches/mentra-keychain-search.lock"
lock.parent.mkdir(parents=True, exist_ok=True)
with lock.open("a") as stream:
    fcntl.flock(stream, fcntl.LOCK_EX)
    current = shlex.split(subprocess.check_output(["security", "list-keychains", "-d", "user"], text=True))
    updated = [item for item in current if item != keychain]
    if operation == "add":
        updated.insert(0, keychain)
    subprocess.run(["security", "list-keychains", "-d", "user", "-s", *updated], check=True)
