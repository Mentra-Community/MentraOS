import {z} from "zod";
import {frameworkIdentitySchema, frameworkRequestInputSchema} from "../types/framework-request.types";
import {routineIdentitySchema, routinePlatformSchema} from "../types/routine-definition.types";
import {testBuildSourceSchema} from "../types/test-build.types";
import {RoutineDefinitionService} from "./routine-definition.service";
import {GithubTestBuildGateway, type TestBuildGateway} from "./test-builds.service";
import {TestHostStateService} from "./test-host-state.service";
import {TestRequestService, requestInputDigest, type StoredTestRequest} from "./test-request.service";
import {FrameworkResultService} from "./framework-result.service";
import {configuredRoutineLanes, routineAdmissionInput, type RoutineLaneBindings} from "./routine-admission.service";
import {TestRunError} from "./test-result-error";

export const routineDispatchSchema = z.object({requestId: frameworkIdentitySchema, routineId: routineIdentitySchema,
  platform: routinePlatformSchema, source: testBuildSourceSchema}).strict();
/** Exact-source callers use the same native queue and input construction as catalog nightlies. */
export class RoutineDispatchService {
  constructor(private readonly definitions: Pick<RoutineDefinitionService, "current" | "getCurrent"> = new RoutineDefinitionService(),
    private readonly builds: Pick<TestBuildGateway, "resolve"> = new GithubTestBuildGateway(),
    private readonly hosts: Pick<TestHostStateService, "get"> = new TestHostStateService(),
    private readonly requests: Pick<TestRequestService, "get" | "submit"> = new TestRequestService(),
    private readonly results: Pick<FrameworkResultService, "detail"> = new FrameworkResultService(),
    private readonly bindings: () => RoutineLaneBindings = configuredRoutineLanes) {}
  async catalog() {return {routines: (await this.definitions.current()).filter(row => row.definition.execution)};}
  private originalRequest(selected: z.infer<typeof routineDispatchSchema>, request: StoredTestRequest) {
    const input = frameworkRequestInputSchema.safeParse(request.input);
    const source = input.success ? testBuildSourceSchema.safeParse(input.data.build.source) : null;
    if (!input.success || !source?.success || request.requestId !== selected.requestId || requestInputDigest(input.data) !== request.inputSha256)
      throw new TestRunError(503, "Stored request identity is unavailable");
    if (input.data.routineId !== selected.routineId || input.data.platform !== selected.platform
      || requestInputDigest(source.data) !== requestInputDigest(selected.source))
      throw new TestRunError(409, "Request retry changed its original routine/platform or exact build source");
    return request;
  }
  async prepare(input: unknown) {
    const parsed = routineDispatchSchema.safeParse(input);
    if (!parsed.success) throw new TestRunError(400, "Invalid exact-source routine request");
    const selected = parsed.data;
    const definition = await this.definitions.getCurrent(selected.routineId, selected.platform);
    if (!definition) throw new TestRunError(409, "Routine is not enrolled for this platform");
    const binding = this.bindings()[selected.platform];
    if (!binding) throw new TestRunError(409, `No configured host/lane binding for ${selected.platform}.`);
    const [build, host] = await Promise.all([this.builds.resolve(selected.source, selected.platform), this.hosts.get(binding.hostId)]);
    return {hostId: binding.hostId, input: routineAdmissionInput(definition, build, binding, host)};
  }
  async submit(input: unknown) {
    const parsed = routineDispatchSchema.safeParse(input);
    if (!parsed.success) throw new TestRunError(400, "Invalid exact-source routine request");
    const selected = parsed.data, existing = await this.requests.get(selected.requestId);
    if (existing) return this.originalRequest(selected, existing);
    try {
      const frozen = await this.prepare(selected);
      return await this.requests.submit(selected.requestId, frozen.hostId, frozen.input);
    } catch (error) {
      // A concurrent caller may have frozen the original request while this caller resolved newer configuration.
      const winner = await this.requests.get(selected.requestId);
      if (winner) return this.originalRequest(selected, winner);
      throw error;
    }
  }
  async detail(requestId: string) {
    if (!frameworkIdentitySchema.safeParse(requestId).success) throw new TestRunError(400, "Invalid request identity");
    const request = await this.requests.get(requestId);
    if (!request) throw new TestRunError(404, "Routine request was not found");
    try {return {request, result: await this.results.detail(requestId)};}
    catch (error) {if (error instanceof TestRunError && error.status === 404) return {request, result: null}; throw error;}
  }
}
