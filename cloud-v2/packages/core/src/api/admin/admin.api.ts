import {Hono} from "hono"
import type {AppEnv} from "../../types/hono.types"
import {storeServiceAuth} from "../middleware/store-service-auth.middleware"
import reports from "./reports.api"
import supportProfiles from "./support-profiles.api"

const app = new Hono<AppEnv>()
app.use("*", storeServiceAuth)
app.route("/reports", reports)
app.route("/support-profiles", supportProfiles)
export default app
