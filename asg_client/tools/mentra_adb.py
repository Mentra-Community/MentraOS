"""Small adb helpers shared by the BES crash tools.

Every call runs the `adb` found on PATH, so a per-unit wrapper placed first on
PATH selects the device. Remote shell commands are passed to adb as a single
argument: lab wrappers that rewrite adb flags then cannot mistake a remote
`test -e` or `logcat -d` for one of their own options.
"""
import shlex
import subprocess


def shell(command, timeout=30, check=False):
    """Run one remote shell command string; return (returncode, stdout text)."""
    if not isinstance(command, str):
        command = " ".join(shlex.quote(str(part)) for part in command)
    try:
        result = subprocess.run(["adb", "shell", command], capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        if check:
            raise
        return 124, ""
    text = result.stdout.decode("utf8", errors="replace").replace("\r\n", "\n")
    if check and result.returncode != 0:
        raise RuntimeError(f"adb shell failed ({result.returncode}): {command}")
    return result.returncode, text


def out(command, timeout=30):
    """Remote command stdout, stripped; empty string on failure."""
    code, text = shell(command, timeout=timeout)
    return text.strip() if code == 0 else ""


def push(local, remote, timeout=60):
    subprocess.run(["adb", "push", local, remote], check=True, capture_output=True, timeout=timeout)


def pull(remote, local, timeout=120):
    subprocess.run(["adb", "pull", remote, local], check=True, capture_output=True, timeout=timeout)


def attached(timeout=15):
    """True when the PATH adb can reach its device."""
    try:
        result = subprocess.run(["adb", "get-state"], capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False
    return result.returncode == 0 and b"device" in result.stdout
