/**
 * @fileoverview Sign-in routes of Core's portal websites, on the portal's own
 * origin (each portal host forwards `/api/*` to Core):
 *  - `GET  /api/{admin,portal}/auth/login?return_to`: start sign-in (20 per minute per IP);
 *  - `GET  /api/{admin,portal}/auth/callback`: finish it (30 per minute per IP);
 *    any failure renders a fixed-text page with "Try again" and sets no session cookie;
 *  - `POST /api/{admin,portal}/auth/logout`: same-origin only; ends the portal
 *    session and answers `{signOutUrl}` (the identity provider's sign-out, or null).
 * All three answer `Cache-Control: no-store`. Mounted ahead of each group's
 * principal gate.
 */

import {Hono} from "hono"

import type {PortalKind} from "../../services/signin/browser-session.service"
import {finishPortalSignIn, signOutPortal, startPortalSignIn} from "../../services/signin/portal-signin.service"
import type {AppEnv} from "../../types/hono.types"

export function createPortalAuthApi(portal: PortalKind): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    await next()
    c.header("cache-control", "no-store")
  })
  app.get("/login", c => startPortalSignIn(c, portal))
  app.get("/callback", c => finishPortalSignIn(c, portal))
  app.post("/logout", c => signOutPortal(c, portal))
  return app
}
