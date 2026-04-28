# Photo Webhook Server

This tiny local server is for testing Mentra Live photo uploads during SDK development.

It receives the `requestPhoto` webhook upload, saves the image on your computer, and serves JSON status endpoints that the Android, iOS, and React Native example apps can poll to show a preview.

## Run

From this repository:

```bash
python3 examples/photo-webhook-server/server.py
```

The server prints URLs like:

```text
http://192.168.1.42:8787/upload
```

Use the LAN URL, not `localhost`, in the Android, iOS, or React Native example app. The URL shown in each example's empty input field is only a placeholder; paste the URL printed by this server. Keep the glasses, phone, and computer on a network where the upload client can reach the computer.

## Endpoints

- `POST /upload`: Mentra Live uploads multipart form data with a `photo` file and `requestId`. Some upload paths also include fields such as `source`, `type`, or `success`.
- `GET /uploads/<requestId>.json`: returns metadata for one uploaded photo. Cache-busting query strings are accepted, for example `/uploads/<requestId>.json?poll=123`.
- `GET /latest.json`: returns metadata for the latest uploaded photo.
- `GET /photos/<requestId>.jpg`: serves the saved photo.

Uploaded photos are written to `examples/photo-webhook-server/uploads/`, which is ignored by git.
