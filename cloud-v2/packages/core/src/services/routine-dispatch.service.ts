import {z} from "zod";
import {frameworkIdentitySchema} from "../types/framework-request.types";
import {routineIdentitySchema, routinePlatformSchema} from "../types/routine-definition.types";
import {testBuildSourceSchema, type TestBuildSource} from "../types/test-build.types";
import {RoutineDefinitionService} from "./routine-definition.service";
import {GithubTestBuildGateway, type TestBuildGateway} from "./test-builds.service";
import {TestHostStateService} from "./test-host-state.service";
import {TestRequestService, requestInputDigest} from "./test-request.service";
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
  async submit(input: unknown) {
    const parsed = routineDispatchSchema.safeParse(input);
    if (!parsed.success) throw new TestRunError(400, "Invalid exact-source routine request");
    const selected = parsed.data, existing = await this.requests.get(selected.requestId);
    if (existing) {
      const prior = existing.input as {routineId: string; platform: string; build: {source: TestBuildSource}};
      if (prior.routineId !== selected.routineId || prior.platform !== selected.platform || requestInputDigest(prior.build.source) !== requestInputDigest(selected.source))
        throw new TestRunError(409, "Request retry changed its original routine/platform or exact build source");
      return existing;
    }
    const definition = await this.definitions.getCurrent(selected.routineId, selected.platform);
    if (!definition) throw new TestRunError(409, "Routine is not enrolled for this platform");
    const binding = this.bindings()[selected.platform];
    if (!binding) throw new TestRunError(409, `No configured host/lane binding for ${selected.platform}.`);
    const [build, host] = await Promise.all([this.builds.resolve(selected.source, selected.platform), this.hosts.get(binding.hostId)]);
    return this.requests.submit(selected.requestId, binding.hostId, routineAdmissionInput(definition, build, binding, host));
  }
  async detail(requestId: string) {
    if (!frameworkIdentitySchema.safeParse(requestId).success) throw new TestRunError(400, "Invalid request identity");
    const request = await this.requests.get(requestId);
    if (!request) throw new TestRunError(404, "Routine request was not found");
    try {return {request, result: await this.results.detail(requestId)};}
    catch (error) {if (error instanceof TestRunError && error.status === 404) return {request, result: null}; throw error;}
  }
}
