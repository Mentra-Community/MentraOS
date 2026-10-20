import {LaneControlsService} from '../../services/lane-controls.service'
import {Hono} from "hono"
import {ZodError} from "zod"
import {createTestHostAuth, type TestHostEnv} from "../middleware/test-host-auth.middleware"
import {frameworkBodyLimit, frameworkJson} from "./framework-json"
import {TestHostStateService} from "../../services/test-host-state.service"
import {TestRunError} from "../../services/test-result-error"
import {ResourceReservationsService} from '../../services/resource-reservations.service'
export function createTestHostStateApi(service = new TestHostStateService(), credentials?: () => string | undefined,
  controls = new LaneControlsService(), resources = new ResourceReservationsService()) {
  const app = new Hono<TestHostEnv>()
  app.use("*", createTestHostAuth(credentials))
  app.onError((error, c) =>
    error instanceof ZodError
      ? c.json({error: "invalid_host_state"}, 400)
      : error instanceof TestRunError
        ? c.json({error: "host_state_conflict", message: error.message}, error.status)
        : c.json({error: "host_state_unavailable"}, 503),
  )
  app.post("/", frameworkBodyLimit(), async c => {
    const input = await frameworkJson(c) as {laneControls?: unknown}
    const receipt = await service.report(input, c.var.testHostId)
    return c.json({...receipt, ...(input.laneControls === undefined ? {} : {
      laneControls: await controls.exchange(c.var.testHostId, input.laneControls)})})
  })
  app.post("/deployment", frameworkBodyLimit(), async (c) =>
    c.json(await service.reportDeployment(await frameworkJson(c), c.var.testHostId)),
  )
  app.post('/resource-reservations/acquire', frameworkBodyLimit(16_384), async c =>
    c.json(await resources.acquire(await frameworkJson(c), c.var.testHostId)))
  app.post('/resource-reservations/observe', frameworkBodyLimit(16_384), async c =>
    c.json(await resources.observe(await frameworkJson(c), c.var.testHostId)))
  app.post('/resource-reservations/return', frameworkBodyLimit(4096), async c =>
    c.json(await resources.giveBack(await frameworkJson(c), c.var.testHostId)))
  return app
}
