# APP_AUTH_JWT_PRIVATE_KEY — Generate & Verify

The cloud signs webview user tokens (RS256) with `APP_AUTH_JWT_PRIVATE_KEY`. If
the value is missing or malformed, [`POST /api/auth/generate-webview-signed-user-token`](../../packages/cloud/src/api/hono/routes/auth.routes.ts)
returns 500 and `token.service` logs one of:

- `APP_AUTH_JWT_PRIVATE_KEY is not set` — env var absent or empty.
- `APP_AUTH_JWT_PRIVATE_KEY is set but failed to import` — present but not a
  valid PKCS8 RSA PEM.

The loader lives in [`temp-token.service.ts`](../../packages/cloud/src/services/core/temp-token.service.ts);
it accepts both real-newline PEMs and single-line `\n`-escaped PEMs.

## 1. Generate a PKCS8 RSA 2048 key

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /tmp/jwt_priv.pem
```

Sanity-check that openssl can decode it (no output = OK):

```bash
openssl pkey -in /tmp/jwt_priv.pem -noout
```

The PEM must start with `-----BEGIN PRIVATE KEY-----` (PKCS8). If it starts
with `-----BEGIN RSA PRIVATE KEY-----` (PKCS1), convert it:

```bash
openssl pkcs8 -topk8 -nocrypt -in /tmp/jwt_priv.pem -out /tmp/jwt_priv_pkcs8.pem
```

## 2. Convert to single-line `\n`-escaped form for `.env`

`.env` values are single-line, so collapse newlines to literal `\n`:

```bash
awk 'BEGIN{ORS="\\n"} {print}' /tmp/jwt_priv.pem | sed 's/\\n$//' > /tmp/jwt_priv_oneline.txt
```

Quick visual check:

```bash
head -c 80 /tmp/jwt_priv_oneline.txt; echo; tail -c 80 /tmp/jwt_priv_oneline.txt
```

Expected: starts with `-----BEGIN PRIVATE KEY-----\nMIIEv…`, ends with
`…\n-----END PRIVATE KEY-----`.

## 3. Set it in `cloud/.env`

Replace any existing (or commented) line with:

```
APP_AUTH_JWT_PRIVATE_KEY="<paste the contents of /tmp/jwt_priv_oneline.txt>"
```

The value MUST be wrapped in double quotes so docker compose preserves the
literal `\n` sequences. Multi-line PEMs also work if you prefer them — the
service normalizes both forms.

## 4. Apply the change

`docker restart` does **not** reload `env_file` — env is captured at container
creation. You must recreate the container:

```bash
cd cloud
docker compose -f docker-compose.dev.yml -p dev up -d --force-recreate --no-deps cloud
```

## 5. Verify

### a. Confirm the container received the value

```bash
docker exec dev-cloud-1 bash -c \
  'echo "len=${#APP_AUTH_JWT_PRIVATE_KEY}"; echo "head=${APP_AUTH_JWT_PRIVATE_KEY:0:60}"'
```

A 2048-bit PKCS8 RSA PEM is ~1700 chars; `head` should print
`-----BEGIN PRIVATE KEY-----` followed by base64.

### b. Confirm the cloud imported it successfully

```bash
docker logs --tail 200 dev-cloud-1 2>&1 | grep -i "token.service"
```

Success looks like:

```
[token.service] APP_AUTH_JWT_PRIVATE_KEY loaded and ready for RS256 signing
```

If you see `failed to import` or `is not set`, re-check the value in `.env`
(common mistakes: missing surrounding quotes, line still commented, PKCS1
instead of PKCS8, accidental shell expansion of `$` in the base64).

### c. End-to-end: hit the signing endpoint

From a browser session that's already authenticated to your local cloud (or
with a valid Bearer token):

```bash
curl -i -X POST http://localhost:8002/api/auth/generate-webview-signed-user-token \
  -H "Authorization: Bearer $YOUR_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"packageName":"org.augmentos.store"}'
```

Expected: `200 OK` with a JWT body. Decode the JWT header at
[jwt.io](https://jwt.io) and confirm `alg: RS256`, `kid: v1`.

## Notes

- This is a **dev signing key**. For staging/prod, generate a separate key and
  store it in your secrets manager — never commit it.
- Rotating the key invalidates all previously issued webview tokens (10-minute
  TTL), so users may need to reload their app webviews once after rotation.
- The key only signs; verification is done by apps using their own API key
  hash, so there is no paired public-key env var to update.
