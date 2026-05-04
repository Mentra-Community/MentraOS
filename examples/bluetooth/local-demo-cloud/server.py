#!/usr/bin/env python3
"""Run the local companion services used by the Mentra SDK example apps."""

from __future__ import annotations

import argparse
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path


DEFAULT_PHOTO_PORT = 8787
DEFAULT_RTMP_PORT = 1935
DEFAULT_HLS_PORT = 8888
DEFAULT_WEBRTC_PORT = 8889
DEFAULT_STREAM_PATH = "mentra-live"
MEDIA_MTX_CONTAINER = "mentra-webrtc"
MEDIA_MTX_IMAGE = "bluenviron/mediamtx:1"

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
PHOTO_SERVER = REPO_ROOT / "examples" / "photo-webhook-server" / "server.py"


def parse_options() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Start the local photo webhook and MediaMTX streaming server for Mentra SDK examples."
    )
    parser.add_argument("--host", default="0.0.0.0", help="Host interface for the photo webhook.")
    parser.add_argument("--host-ip", default=None, help="LAN IP printed for phones and glasses.")
    parser.add_argument("--photo-port", type=int, default=DEFAULT_PHOTO_PORT, help="Photo webhook HTTP port.")
    parser.add_argument("--rtmp-port", type=int, default=DEFAULT_RTMP_PORT, help="MediaMTX RTMP ingest port.")
    parser.add_argument("--hls-port", type=int, default=DEFAULT_HLS_PORT, help="MediaMTX HLS preview port.")
    parser.add_argument("--webrtc-port", type=int, default=DEFAULT_WEBRTC_PORT, help="MediaMTX WebRTC HTTP port.")
    parser.add_argument("--stream-path", default=DEFAULT_STREAM_PATH, help="MediaMTX stream path.")
    parser.add_argument("--webrtc-path", dest="stream_path", help=argparse.SUPPRESS)
    parser.add_argument("--photo-only", action="store_true", help="Start only the photo webhook.")
    parser.add_argument("--streaming-only", action="store_true", help="Start only the MediaMTX streaming server.")
    parser.add_argument("--webrtc-only", dest="streaming_only", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--skip-photo", action="store_true", help="Do not start the photo webhook.")
    parser.add_argument("--skip-streaming", action="store_true", help="Do not start MediaMTX.")
    parser.add_argument("--skip-webrtc", dest="skip_streaming", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument(
        "--require-streaming",
        dest="require_streaming",
        action="store_true",
        help="Exit instead of continuing when Docker or MediaMTX cannot start.",
    )
    parser.add_argument("--require-webrtc", dest="require_streaming", action="store_true", help=argparse.SUPPRESS)
    options = parser.parse_args()
    if options.photo_only:
        options.skip_streaming = True
    if options.streaming_only:
        options.skip_photo = True
    return options


def detect_host_ip(explicit_ip: str | None) -> str:
    if explicit_ip:
        return explicit_ip

    for iface in ("en0", "en1", "en2"):
        ip = run_capture(["ipconfig", "getifaddr", iface])
        if ip:
            return ip

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        pass

    addresses = socket.gethostbyname_ex(socket.gethostname())[2]
    for address in addresses:
        if not address.startswith("127."):
            return address

    raise RuntimeError("Could not detect a LAN IP address. Pass --host-ip explicitly.")


def run_capture(command: list[str]) -> str | None:
    if not shutil.which(command[0]):
        return None

    result = subprocess.run(command, capture_output=True, text=True, check=False)
    value = result.stdout.strip()
    return value or None


def can_bind_tcp(host: str, port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind((host, port))
        return True
    except OSError:
        return False


def docker_container_running(name: str) -> bool:
    if not shutil.which("docker"):
        return False

    result = subprocess.run(
        ["docker", "ps", "--filter", f"name={name}", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    return name in result.stdout.splitlines()


def missing_mediamtx_ports(options: argparse.Namespace) -> list[str]:
    required_ports = [
        (f"{options.rtmp_port}:1935/tcp", "1935/tcp"),
        (f"{options.hls_port}:8888/tcp", "8888/tcp"),
        (f"{options.webrtc_port}:8889/tcp", "8889/tcp"),
        ("8890:8890/udp", "8890/udp"),
        ("8189:8189/udp", "8189/udp"),
    ]
    missing: list[str] = []
    for label, container_port in required_ports:
        result = subprocess.run(
            ["docker", "port", MEDIA_MTX_CONTAINER, container_port],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            missing.append(label)
    return missing


def ensure_docker_ready() -> None:
    if not shutil.which("docker"):
        raise RuntimeError("Docker is not installed or is not on PATH.")

    result = subprocess.run(
        ["docker", "version", "--format", "{{.Server.Version}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"Docker is not running: {message}")


def start_photo_server(options: argparse.Namespace) -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [
            sys.executable,
            str(PHOTO_SERVER),
            "--host",
            options.host,
            "--port",
            str(options.photo_port),
        ]
    )


def start_mediamtx(options: argparse.Namespace, host_ip: str) -> tuple[subprocess.Popen[bytes] | None, bool]:
    if docker_container_running(MEDIA_MTX_CONTAINER):
        missing_ports = missing_mediamtx_ports(options)
        if missing_ports:
            missing = ", ".join(missing_ports)
            raise RuntimeError(
                f"Existing {MEDIA_MTX_CONTAINER} container is missing port mappings: {missing}. "
                f"Stop it with `docker stop {MEDIA_MTX_CONTAINER}` and rerun this command."
            )
        return None, False

    ensure_docker_ready()
    process = subprocess.Popen(
        [
            "docker",
            "run",
            "--rm",
            "--name",
            MEDIA_MTX_CONTAINER,
            "-e",
            f"MTX_WEBRTCADDITIONALHOSTS={host_ip}",
            "-p",
            f"{options.rtmp_port}:1935",
            "-p",
            f"{options.hls_port}:8888",
            "-p",
            f"{options.webrtc_port}:8889",
            "-p",
            "8890:8890/udp",
            "-p",
            "8189:8189/udp",
            MEDIA_MTX_IMAGE,
        ]
    )
    return process, True


def print_urls(
    options: argparse.Namespace,
    host_ip: str,
    photo_warning: str | None,
    reused_mediamtx: bool,
    streaming_warning: str | None,
) -> None:
    stream_path = options.stream_path.strip("/")
    print("\nLocal Mentra demo cloud")
    print("=======================")

    if photo_warning:
        print("\nPhoto webhook was not started:")
        print(f"  {photo_warning}")
        print("  If another photo webhook is already running, use this URL:")
        print(f"  http://{host_ip}:{options.photo_port}/upload")
    elif not options.skip_photo:
        print("\nPhoto upload URL:")
        print(f"  http://{host_ip}:{options.photo_port}/upload")

    if streaming_warning:
        print("\nStreaming server is not running:")
        print(f"  {streaming_warning}")
        print("  Photo upload is still available. Install/start Docker later to try RTMP/WebRTC streaming.")
    elif not options.skip_streaming:
        print("\nRTMP publish URL:")
        print(f"  rtmp://{host_ip}:{options.rtmp_port}/{stream_path}")
        print("\nRTMP browser preview (HLS):")
        print(f"  http://{host_ip}:{options.hls_port}/{stream_path}")
        print("\nOptional RTMP ffplay preview:")
        print(f"  ffplay -fflags nobuffer -flags low_delay -framedrop rtmp://{host_ip}:{options.rtmp_port}/{stream_path}")
        print("\nWHIP publish URL:")
        print(f"  http://{host_ip}:{options.webrtc_port}/{stream_path}/whip")
        print("\nWebRTC browser preview:")
        print(f"  http://{host_ip}:{options.webrtc_port}/{stream_path}")
        print("\nWHEP playback URL:")
        print(f"  http://{host_ip}:{options.webrtc_port}/{stream_path}/whep")
        if reused_mediamtx:
            print(f"\nReusing existing Docker container: {MEDIA_MTX_CONTAINER}")

    print(f"\nKeep the phone, glasses, and computer on a network that can reach {host_ip}.")
    print("Press Ctrl+C to stop services started by this command.\n")


def stop_process(process: subprocess.Popen[bytes] | None) -> None:
    if not process or process.poll() is not None:
        return

    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def stop_mediamtx_if_owned(started_by_us: bool) -> None:
    if not started_by_us:
        return

    subprocess.run(["docker", "stop", MEDIA_MTX_CONTAINER], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main() -> None:
    options = parse_options()
    host_ip = detect_host_ip(options.host_ip)

    photo_process: subprocess.Popen[bytes] | None = None
    mediamtx_process: subprocess.Popen[bytes] | None = None
    mediamtx_started_by_us = False
    photo_warning: str | None = None
    streaming_warning: str | None = None

    def handle_signal(_signum: int, _frame: object) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, handle_signal)

    try:
        if not options.skip_photo:
            if can_bind_tcp(options.host, options.photo_port):
                photo_process = start_photo_server(options)
            else:
                photo_warning = (
                    f"Port {options.photo_port} is already in use. "
                    "Stop the existing process or pass --photo-port to use another port."
                )

        if not options.skip_streaming:
            try:
                mediamtx_process, mediamtx_started_by_us = start_mediamtx(options, host_ip)
            except RuntimeError as error:
                if options.require_streaming:
                    raise
                streaming_warning = str(error)

        print_urls(
            options,
            host_ip,
            photo_warning=photo_warning,
            reused_mediamtx=not mediamtx_started_by_us and not options.skip_streaming and streaming_warning is None,
            streaming_warning=streaming_warning,
        )

        processes = [process for process in (photo_process, mediamtx_process) if process is not None]
        while True:
            for process in processes:
                return_code = process.poll()
                if return_code is not None:
                    raise RuntimeError(f"A local demo service stopped unexpectedly with exit code {return_code}.")
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping local demo cloud.")
    finally:
        stop_process(photo_process)
        stop_process(mediamtx_process)
        stop_mediamtx_if_owned(mediamtx_started_by_us)


if __name__ == "__main__":
    main()
