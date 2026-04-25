# Photo Webhook Server

This tiny local server is for testing Mentra Live photo uploads during native SDK development.

It receives the `requestPhoto` webhook upload from the glasses, saves the image on your computer, and serves a JSON status endpoint that the Android example app can poll to show a preview.

## Run

From this repository:

```bash
python3 examples/photo-webhook-server/server.py
```

The server prints URLs like:

```text
http://192.168.1.42:8787/upload
```

Use the LAN URL, not `localhost`, in the Android example app. The URL shown in the Android example's empty input field is only a placeholder; paste the URL printed by this server. The glasses upload the photo directly to this URL, so the glasses, phone, and computer need to be on a network where the glasses can reach the computer.

## Endpoints

- `POST /upload`: Mentra Live uploads multipart form data with `photo`, `requestId`, `type`, and `success`.
- `GET /uploads/<requestId>.json`: returns metadata for one uploaded photo.
- `GET /latest.json`: returns metadata for the latest uploaded photo.
- `GET /photos/<requestId>.jpg`: serves the saved photo.

Uploaded photos are written to `examples/photo-webhook-server/uploads/`, which is ignored by git.
