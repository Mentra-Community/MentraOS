#!/usr/bin/env python3
"""Local webhook receiver for Mentra Live media upload demos."""

from __future__ import annotations

import argparse
import json
import mimetypes
import re
import socket
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


DEFAULT_PORT = 8787
UPLOAD_ROUTE = "/upload"
UPLOADS_ROUTE = "/uploads/"
PHOTOS_ROUTE = "/photos/"
MEDIA_ROUTE = "/media/"

MEDIA_TYPE_PHOTO = "photo"
MEDIA_TYPE_VIDEO = "video"


def sanitize_id(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())
    return cleaned.strip(".-") or f"photo-{int(time.time() * 1000)}"


def sanitize_media_type(value: object | None) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if normalized in {MEDIA_TYPE_PHOTO, "image", "jpeg", "jpg"}:
        return MEDIA_TYPE_PHOTO
    if normalized in {MEDIA_TYPE_VIDEO, "mp4", "movie"}:
        return MEDIA_TYPE_VIDEO
    return None


def parse_options() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Receive Mentra Live webhook photo/video uploads and serve them back for preview."
    )
    parser.add_argument("--host", default="0.0.0.0", help="Host interface to bind.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="HTTP port to listen on.")
    parser.add_argument(
        "--uploads-dir",
        default=str(Path(__file__).with_name("uploads")),
        help="Directory where uploaded media and metadata are stored.",
    )
    return parser.parse_args()


def parse_multipart(body: bytes, content_type: str) -> tuple[dict[str, str], dict[str, dict[str, bytes | str]]]:
    boundary_match = re.search(r'boundary="?([^";]+)"?', content_type)
    if not boundary_match:
        raise ValueError("Missing multipart boundary")

    delimiter = ("--" + boundary_match.group(1)).encode("utf-8")
    fields: dict[str, str] = {}
    files: dict[str, dict[str, bytes | str]] = {}

    for raw_part in body.split(delimiter):
        part = raw_part
        if part.startswith(b"\r\n"):
            part = part[2:]
        if part.endswith(b"\r\n"):
            part = part[:-2]
        if not part or part == b"--":
            continue
        if part.endswith(b"--"):
            part = part[:-2]
            if part.endswith(b"\r\n"):
                part = part[:-2]

        header_blob, separator, payload = part.partition(b"\r\n\r\n")
        if not separator:
            continue

        headers = parse_part_headers(header_blob)
        disposition = headers.get("content-disposition", "")
        disposition_values = parse_content_disposition(disposition)
        name = disposition_values.get("name")
        if not name:
            continue

        filename = disposition_values.get("filename")
        if filename:
            files[name] = {
                "filename": filename,
                "content_type": headers.get("content-type", "application/octet-stream"),
                "content": payload,
            }
        else:
            fields[name] = payload.decode("utf-8", errors="replace")

    return fields, files


def parse_part_headers(header_blob: bytes) -> dict[str, str]:
    headers: dict[str, str] = {}
    for line in header_blob.decode("utf-8", errors="replace").split("\r\n"):
        key, separator, value = line.partition(":")
        if separator:
            headers[key.strip().lower()] = value.strip()
    return headers


def parse_content_disposition(value: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for segment in value.split(";"):
        key, separator, raw_value = segment.strip().partition("=")
        if separator:
            result[key.strip().lower()] = raw_value.strip().strip('"')
    return result


def local_ips() -> list[str]:
    addresses = {"127.0.0.1"}
    try:
        addresses.update(socket.gethostbyname_ex(socket.gethostname())[2])
    except OSError:
        pass

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            addresses.add(sock.getsockname()[0])
    except OSError:
        pass

    return sorted(addresses)


class PhotoWebhookHandler(BaseHTTPRequestHandler):
    server_version = "MentraMediaWebhook/1.0"

    @property
    def uploads_dir(self) -> Path:
        return self.server.uploads_dir  # type: ignore[attr-defined]

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        request_path = urlparse(self.path).path

        if request_path == "/":
            self.send_index()
            return

        if request_path == "/latest.json":
            self.send_json_file(self.uploads_dir / "latest.json")
            return

        if request_path.startswith(UPLOADS_ROUTE) and request_path.endswith(".json"):
            request_id = unquote(request_path[len(UPLOADS_ROUTE) : -len(".json")])
            self.send_json_file(self.uploads_dir / f"{sanitize_id(request_id)}.json")
            return

        if request_path.startswith(PHOTOS_ROUTE):
            filename = Path(unquote(request_path[len(PHOTOS_ROUTE) :])).name
            self.send_static_file(self.uploads_dir / filename)
            return

        if request_path.startswith(MEDIA_ROUTE):
            filename = Path(unquote(request_path[len(MEDIA_ROUTE) :])).name
            self.send_static_file(self.uploads_dir / filename)
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Unknown route")

    def do_POST(self) -> None:
        if urlparse(self.path).path != UPLOAD_ROUTE:
            self.send_error(HTTPStatus.NOT_FOUND, "Use POST /upload")
            return

        try:
            length = int(self.headers.get("content-length", "0"))
            content_type = self.headers.get("content-type", "")
            body = self.rfile.read(length)
            fields, files = parse_multipart(body, content_type)
            metadata = self.parse_metadata(fields)
            upload_file, field_name = self.media_file(files)
            if not upload_file:
                self.send_json(
                    {
                        "success": False,
                        "error": "Missing multipart file field named photo, video, or file",
                    },
                    HTTPStatus.BAD_REQUEST,
                )
                return

            media_type = self.detect_media_type(field_name, upload_file, fields, metadata)
            request_id = sanitize_id(
                str(
                    metadata.get("requestId")
                    or fields.get("requestId")
                    or f"{media_type}-{int(time.time() * 1000)}"
                )
            )
            extension = self.file_extension(media_type, upload_file)
            filename = f"{request_id}{extension}"
            media_path = self.uploads_dir / filename
            media_path.write_bytes(upload_file["content"])  # type: ignore[arg-type]

            stored_metadata = {
                **metadata,
                "success": True,
                "requestId": request_id,
                "filename": filename,
                "fileSizeBytes": media_path.stat().st_size,
                "contentType": upload_file.get("content_type", "application/octet-stream"),
                "mediaType": media_type,
                "uploadedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            self.write_metadata(stored_metadata)
            self.send_json(self.metadata_for_response(stored_metadata), HTTPStatus.OK)
            print(
                f"Received {media_type} requestId={request_id} "
                f"fileSizeBytes={stored_metadata['fileSizeBytes']} file={media_path}"
            )
        except Exception as error:  # noqa: BLE001 - demo server should return readable errors.
            self.send_json({"success": False, "error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def parse_metadata(self, fields: dict[str, str]) -> dict[str, object]:
        raw_metadata = fields.get("metadata")
        if not raw_metadata:
            return {}
        try:
            metadata = json.loads(raw_metadata)
            return metadata if isinstance(metadata, dict) else {}
        except json.JSONDecodeError:
            return {"metadataRaw": raw_metadata}

    def media_file(
        self,
        files: dict[str, dict[str, bytes | str]],
    ) -> tuple[dict[str, bytes | str] | None, str | None]:
        for field_name in ("photo", "video", "file"):
            upload_file = files.get(field_name)
            if upload_file:
                return upload_file, field_name
        return None, None

    def detect_media_type(
        self,
        field_name: str | None,
        upload_file: dict[str, bytes | str],
        fields: dict[str, str],
        metadata: dict[str, object],
    ) -> str:
        for value in (
            metadata.get("mediaType"),
            fields.get("mediaType"),
            field_name,
            upload_file.get("content_type"),
            upload_file.get("filename"),
            fields.get("type"),
        ):
            normalized = sanitize_media_type(value)
            if normalized:
                return normalized
            if isinstance(value, str) and "video" in value.lower():
                return MEDIA_TYPE_VIDEO
        return MEDIA_TYPE_PHOTO

    def file_extension(self, media_type: str, upload_file: dict[str, bytes | str]) -> str:
        filename = str(upload_file.get("filename", ""))
        suffix = Path(filename).suffix.lower()
        if media_type == MEDIA_TYPE_VIDEO:
            return suffix if suffix in {".mp4", ".mov", ".m4v"} else ".mp4"
        return suffix if suffix in {".jpg", ".jpeg", ".png", ".webp", ".avif"} else ".jpg"

    def write_metadata(self, metadata: dict[str, object]) -> None:
        request_id = str(metadata["requestId"])
        (self.uploads_dir / f"{sanitize_id(request_id)}.json").write_text(
            json.dumps(metadata, indent=2) + "\n",
            encoding="utf-8",
        )
        (self.uploads_dir / "latest.json").write_text(
            json.dumps(metadata, indent=2) + "\n",
            encoding="utf-8",
        )

    def send_index(self) -> None:
        body = {
            "name": "Mentra media webhook demo server",
            "uploadUrl": self.absolute_url(UPLOAD_ROUTE),
            "latestUrl": self.absolute_url("/latest.json"),
        }
        self.send_json(body, HTTPStatus.OK)

    def send_json_file(self, path: Path) -> None:
        if not path.exists():
            self.send_json({"success": False, "error": "No upload found yet"}, HTTPStatus.NOT_FOUND)
            return

        metadata = json.loads(path.read_text(encoding="utf-8"))
        self.send_json(self.metadata_for_response(metadata), HTTPStatus.OK)

    def send_static_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Media not found")
            return

        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        file_size = path.stat().st_size
        start, end = self.parse_range_header(file_size)
        content_length = end - start + 1
        self.send_response(HTTPStatus.PARTIAL_CONTENT if start > 0 or end < file_size - 1 else HTTPStatus.OK)
        self.send_cors_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(content_length))
        if start > 0 or end < file_size - 1:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.end_headers()
        try:
            with path.open("rb") as media_file:
                media_file.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk = media_file.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def parse_range_header(self, file_size: int) -> tuple[int, int]:
        range_header = self.headers.get("Range", "")
        if not range_header.startswith("bytes="):
            return 0, max(0, file_size - 1)
        raw_start, _, raw_end = range_header[len("bytes=") :].partition("-")
        try:
            if raw_start:
                start = int(raw_start)
                end = int(raw_end) if raw_end else file_size - 1
            else:
                suffix_length = int(raw_end)
                start = max(0, file_size - suffix_length)
                end = file_size - 1
        except ValueError:
            return 0, max(0, file_size - 1)
        start = min(max(0, start), max(0, file_size - 1))
        end = min(max(start, end), max(0, file_size - 1))
        return start, end

    def metadata_for_response(self, metadata: dict[str, object]) -> dict[str, object]:
        filename = str(metadata["filename"])
        request_id = str(metadata["requestId"])
        media_type = sanitize_media_type(metadata.get("mediaType")) or MEDIA_TYPE_PHOTO
        route = PHOTOS_ROUTE if media_type == MEDIA_TYPE_PHOTO else MEDIA_ROUTE
        media_url = self.absolute_url(f"{route}{filename}")
        response = dict(metadata)
        response["url"] = media_url
        response["mediaUrl"] = media_url
        if media_type == MEDIA_TYPE_VIDEO:
            response["videoUrl"] = media_url
        else:
            response["photoUrl"] = media_url
        response["statusUrl"] = self.absolute_url(f"{UPLOADS_ROUTE}{request_id}.json")
        return response

    def absolute_url(self, path: str) -> str:
        host = self.headers.get("host", f"127.0.0.1:{DEFAULT_PORT}")
        return f"http://{host}{path}"

    def send_json(self, payload: dict[str, object], status: HTTPStatus) -> None:
        data = (json.dumps(payload, indent=2) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")


def main() -> None:
    options = parse_options()
    uploads_dir = Path(options.uploads_dir).expanduser().resolve()
    uploads_dir.mkdir(parents=True, exist_ok=True)

    server = ThreadingHTTPServer((options.host, options.port), PhotoWebhookHandler)
    server.uploads_dir = uploads_dir  # type: ignore[attr-defined]

    print(f"Saving uploads to: {uploads_dir}")
    print("Use one of these URLs in the Android, iOS, or React Native example:")
    for ip_address in local_ips():
        print(f"  http://{ip_address}:{options.port}{UPLOAD_ROUTE}")
    print("Press Ctrl+C to stop.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
