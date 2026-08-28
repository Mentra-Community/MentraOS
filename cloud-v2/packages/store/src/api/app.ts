import {createHealthApp, createLogger, type ReadinessCheck} from "@mentra/cloud-shared"
import {Hono} from "hono"
import type {AppEnv} from "../types/hono.types"
import {OauthError} from "../types/oauth.types"
import {requestContext} from "./middleware/context.middleware"
import adminApi from "./admin/preinstalled.api"
import clientMiniapps from "./client/miniapps.api"
import consoleApi from "./console/cli-auth.api"
import storeCatalog from "./store/catalog.api"
import internalDevAttestations from "./internal/dev-attestations.api"

const logger = createLogger("store").child({service: "app"})

export function createApp(opts: {readinessChecks: ReadinessCheck[]}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.route("/", createHealthApp({packageName: "store", readinessChecks: opts.readinessChecks}))
  app.use("/api/*", requestContext)
  app.route("/api/store", storeCatalog)
  app.route("/api/console", consoleApi)
  app.route("/api/admin", adminApi)
  app.route("/api/client/miniapps", clientMiniapps)
  app.route("/api/internal/dev-attestations", internalDevAttestations)
  app.onError((error, c) => {
    if (error instanceof OauthError) {
      return c.json({error: error.code, error_description: error.description}, error.httpStatus as 400)
    }
    const log = c.var.logger ?? logger
    log.error({error}, "unhandled Store backend error")
    return c.json({error: "server_error", error_description: "internal server error"}, 500)
  })
  return app
}
