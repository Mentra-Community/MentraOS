import {Hono} from "hono"
import {ZodError} from "zod"
import {createTestHostAuth, type TestHostEnv} from "../middleware/test-host-auth.middleware"
import {frameworkBodyLimit, frameworkJson} from "./framework-json"
import {TestHostStateService} from "../../services/test-host-state.service"
import {TestRunError} from "../../services/test-result-error"
export function createTestHostStateApi(service = new TestHostStateService(), credentials?: () => string | undefined) {
  const app = new Hono<TestHostEnv>()
  app.use("*", createTestHostAuth(credentials))
  app.onError((error, c) =>
    error instanceof ZodError
      ? c.json({error: "invalid_host_state"}, 400)
      : error instanceof TestRunError
        ? c.json({error: "host_state_conflict", message: error.message}, error.status)
        : c.json({error: "host_state_unavailable"}, 503),
  )
  app.post("/", frameworkBodyLimit(), async (c) =>
    c.json(await service.report(await frameworkJson(c), c.var.testHostId)),
  )
  app.post("/deployment", frameworkBodyLimit(), async (c) =>
    c.json(await service.reportDeployment(await frameworkJson(c), c.var.testHostId)),
  )
  return app
}
