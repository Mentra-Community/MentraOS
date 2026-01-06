# Photo Test App

A simple MentraOS app that continuously takes photos and displays them in a webview.

## Purpose

Test app for verifying photo capture functionality, including the `silent` mode feature.

## Running

```bash
cd cloud/packages/apps/photo-test
bun install
MENTRAOS_API_KEY=your_api_key bun start
```

## How it Works

1. When a user connects, the app starts taking photos every 5 seconds
2. Photos are stored in memory and displayed in the webview
3. The webview auto-refreshes every 2 seconds to show the latest photo

## API Endpoints

- `GET /api/status` - Get auth status and photo count
- `GET /api/latest-photo` - Get the latest photo as base64 data URL
- `GET /api/photo-count` - Get the current photo count

## Configuration

- `PORT` - Server port (default: 3333)
- `PACKAGE_NAME` - App package name (default: com.mentra.photo-test)
- `MENTRAOS_API_KEY` - Required API key for MentraOS