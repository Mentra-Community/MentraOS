# Offline MediaMTX images (no Docker Hub pull)

Pre-saved `bluenviron/mediamtx:1` images so `start-local-stream` can run
without downloading anything. Docker Desktop must already be installed.

| File | Use on |
|------|--------|
| `images/mediamtx-1-linux-amd64.tar` | Typical Windows / Intel PCs |
| `images/mediamtx-1-linux-arm64.tar` | Apple Silicon / Windows ARM |

`start-local-stream.cmd` / `.ps1` auto-loads the matching image before
`docker compose up`.

Manual load:

```bat
offline\load-images.cmd
```
