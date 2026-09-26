#!/usr/bin/env python3
"""Coordinate keychain changes and signing across runners sharing a Mac user.

macOS can resolve a duplicate identity's private key from the first search-list
keychain even when codesign specifies --keychain. Keep the job keychain first
for the entire signed archive/export, including CocoaPods' nested signers.
"""
import fcntl
from pathlib import Path
import shlex
import subprocess
import sys

LOCK = Path.home() / "Library/Caches/mentra-keychain-search.lock"


def keychain_path(value):
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = Path.home() / "Library/Keychains" / path
    return str(path.resolve())


def main(args):
    operation, *remaining = args
    if operation not in {"add", "remove", "run", "locked"}:
        raise ValueError("Expected add, remove, run or locked")
    if operation != "locked":
        keychain = keychain_path(remaining.pop(0))
    if operation in {"run", "locked"} and not remaining:
        raise ValueError("Expected a command to run")
    if operation in {"add", "remove"} and remaining:
        raise ValueError("Unexpected arguments")
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    with LOCK.open("a") as stream:
        print("Waiting for the Mac signing/keychain lock", flush=True)
        fcntl.flock(stream, fcntl.LOCK_EX)
        if operation != "locked":
            current = shlex.split(subprocess.check_output(["security", "list-keychains", "-d", "user"], text=True))
            updated = [item for item in current if keychain_path(item) != keychain]
            if operation != "remove":
                if not Path(keychain).is_file():
                    raise ValueError(f"Job keychain does not exist: {keychain}")
                updated.insert(0, keychain)
            subprocess.run(["security", "list-keychains", "-d", "user", "-s", *updated], check=True)
        if operation in {"run", "locked"}:
            # Let the command retain the lock if this wrapper is terminated.
            try:
                result = subprocess.run(remaining, pass_fds=(stream.fileno(),))
                return result.returncode if result.returncode >= 0 else 128 - result.returncode
            finally:
                if operation == "run":
                    latest = shlex.split(subprocess.check_output(["security", "list-keychains", "-d", "user"], text=True))
                    # Preserve additions by older, unguarded jobs during rollout;
                    # never resurrect a keychain their cleanup already deleted.
                    restored = list(dict.fromkeys([*current, *latest]))
                    restored = [item for item in restored if Path(keychain_path(item)).is_file()]
                    subprocess.run(["security", "list-keychains", "-d", "user", "-s", *restored], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
