# secret-proxy Worker

Holds the Google **Places** API key server-side so it never ships inside the
Navigation miniapp bundle. The miniapp calls this Worker; the Worker attaches
the key and forwards to Google Places.

## Why

The Navigation miniapp used to inline `GOOGLE_NAV_API_KEY` into its bundle
(`sdk/Navigation/build.ts`), so anyone who unzipped a release could read it. The
Places REST calls now go through this Worker instead. (The Maps **JavaScript**
SDK key still ships in the UI bundle — it can't be proxied — and is locked down
GCP-side as a separate, public key.)

## Auth — read this

The Worker's auth is a **placeholder**: it only checks that an `X-User-Email`
header is **present**. That is **not real authentication** — the header is a
plain string the client asserts and anyone can forge.

It exists as the **swap-in seam** for the real auth layer: when that lands,
replace the presence check in `src/index.ts` with signature verification of a
signed session token. Until then, the **real abuse guardrail is the hard GCP
quota cap + API restriction** on the Places key.

See `issues/proxy-trust-model.md` for the full reasoning.

## Routes

| Method | Path | Forwards to |
|---|---|---|
| POST | `/places/autocomplete` | `https://places.googleapis.com/v1/places:autocomplete` |
| GET | `/places/details/:placeId?sessionToken=` | `https://places.googleapis.com/v1/places/:placeId` |

Egress is allowlisted to `places.googleapis.com` only.

## Deploy

```bash
cd sdk/Navigation/worker
bun install                                  # or npm install
bunx wrangler login                          # once
bunx wrangler secret put GOOGLE_NAV_PLACES_KEY   # paste the Places-only GCP key
bunx wrangler deploy
```

Copy the printed `*.workers.dev` URL (or your custom route) into
`PROXY_BASE_URL` in `sdk/Navigation/build.ts`.

## Test

```bash
# 401 — no email
curl -i https://<worker-url>/places/autocomplete -X POST -d '{"input":"coffee"}'

# 200 — with placeholder email
curl -i https://<worker-url>/places/autocomplete \
  -X POST \
  -H "X-User-Email: something@mentraglass.com" \
  -H "Content-Type: application/json" \
  -d '{"input":"coffee","sessionToken":"test-123"}'
```
