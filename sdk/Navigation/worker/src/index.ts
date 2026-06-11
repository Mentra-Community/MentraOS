/**
 * secret-proxy Worker
 *
 * Holds the Google Places API key so it never ships in the Navigation
 * miniapp bundle. The miniapp calls this Worker; the Worker attaches the
 * key and forwards the request to Google Places.
 *
 * Routes:
 *   POST /places/autocomplete   -> https://places.googleapis.com/v1/places:autocomplete
 *   GET  /places/details/:id    -> https://places.googleapis.com/v1/places/:id
 *
 * AUTH (placeholder — INTENTIONALLY WEAK FOR NOW):
 *   The Worker only checks that an `X-User-Email` header is PRESENT. This is
 *   NOT real authentication — the header is a plain string the client asserts
 *   and anyone can forge. It exists purely as the swap-in seam for the real
 *   auth layer later (verify a signed session token here instead of checking
 *   presence). Until then, the ACTUAL abuse guardrail is the hard GCP quota
 *   cap + API restriction on GOOGLE_NAV_PLACES_KEY.
 *
 * Egress allowlist:
 *   The Worker ONLY ever forwards to places.googleapis.com. This prevents the
 *   proxy from being abused to send the key to an arbitrary host.
 */

interface Env {
  /** Google Places API key — set via `wrangler secret put GOOGLE_NAV_PLACES_KEY`. */
  GOOGLE_NAV_PLACES_KEY: string
}

const GOOGLE_PLACES_HOST = "places.googleapis.com"

// The Field Mask applied to EVERY details call, fixed server-side. Never
// trust a client-supplied mask: with placeholder auth, forwarding one would
// let any caller request pricier fields (reviews, photos, ...) on our key.
// This fixed set keeps us in Google's cheapest pricing tier.
const DETAILS_FIELD_MASK = "id,location,displayName,formattedAddress"

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // CORS on error responses too — without it the browser blocks the
      // response and callers see an opaque network error instead of the
      // actual 401/404/500.
      "Access-Control-Allow-Origin": "*",
    },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // CORS preflight — the miniapp WebView/JSContext may send these.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-User-Email",
        },
      })
    }

    // ── Placeholder auth gate: presence-only (see file header) ──────────────
    const userEmail = request.headers.get("X-User-Email")
    if (!userEmail || !userEmail.trim()) {
      return json({error: "missing X-User-Email"}, 401)
    }

    if (!env.GOOGLE_NAV_PLACES_KEY) {
      return json({error: "proxy misconfigured: no key"}, 500)
    }

    // ── Route ───────────────────────────────────────────────────────────────
    // POST /places/autocomplete
    if (request.method === "POST" && url.pathname === "/places/autocomplete") {
      const body = await request.text()
      const upstream = await fetch(`https://${GOOGLE_PLACES_HOST}/v1/places:autocomplete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": env.GOOGLE_NAV_PLACES_KEY,
        },
        body,
      })
      return passthrough(upstream)
    }

    // GET /places/details/:placeId?sessionToken=...
    const detailsMatch = url.pathname.match(/^\/places\/details\/([^/]+)$/)
    if (request.method === "GET" && detailsMatch) {
      const placeId = detailsMatch[1] // already URL-encoded by the client
      const sessionToken = url.searchParams.get("sessionToken") ?? ""
      const target =
        `https://${GOOGLE_PLACES_HOST}/v1/places/${placeId}` +
        (sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : "")
      const upstream = await fetch(target, {
        headers: {
          "X-Goog-Api-Key": env.GOOGLE_NAV_PLACES_KEY,
          "X-Goog-FieldMask": DETAILS_FIELD_MASK,
        },
      })
      return passthrough(upstream)
    }

    return json({error: "not found"}, 404)
  },
}

/** Mirror the upstream response, adding permissive CORS for the WebView. */
function passthrough(upstream: Response): Response {
  const headers = new Headers(upstream.headers)
  headers.set("Access-Control-Allow-Origin", "*")
  return new Response(upstream.body, {status: upstream.status, headers})
}
