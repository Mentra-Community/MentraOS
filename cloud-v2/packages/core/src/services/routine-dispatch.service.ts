import {z} from 'zod';
import {frameworkIdentitySchema, frameworkRequestInputSchema} from '../types/framework-request.types';
import {routineSourceRefSchema} from '../types/framework-version.types';
import {publishedRoutineDefinitionSchema, routineEnrollmentSchema} from '../types/routine-definition.types';
import {routineDispatchSchema, routineDispatchIntentSchema} from '../types/routine-dispatch.types';
import {testBuildSourceSchema, selectedBuildInput, type TestBuild} from '../types/test-build.types';
import {RoutineDefinitionService} from './routine-definition.service';
import {GithubTestBuildGateway, type TestBuildGateway} from './test-builds.service';
import {TestHostStateService} from './test-host-state.service';
import {TestRequestService, requestInputDigest, isExecutableRequest, type StoredRequest} from './test-request.service';
import {FrameworkResultService} from './framework-result.service';
import {configuredRoutineLanes, routineAdmissionInput, type RoutineLaneBindings} from './routine-admission.service';
import {GithubRoutineSourceGateway} from './routine-source-selection.service';
import {TestRunError} from './test-result-error';
import {RoutineJobService} from './routine-job.service';

export {routineDispatchSchema} from '../types/routine-dispatch.types';
export const preparedRoutineRequestSchema = z.object({dispatchIntentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  routineSource: routineSourceRefSchema, definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  definition: publishedRoutineDefinitionSchema}).strict();
/** Source preparation and executable delivery share one immutable request identity. */
export class RoutineDispatchService {
  constructor(private readonly definitions: Pick<RoutineDefinitionService, 'current' | 'getCurrent' | 'getExact' | 'enroll'> = new RoutineDefinitionService(),
    private readonly builds: Pick<TestBuildGateway, 'resolve'> = new GithubTestBuildGateway(),
    private readonly hosts: Pick<TestHostStateService, 'get'> = new TestHostStateService(),
    private readonly requests: Pick<TestRequestService, 'get' | 'submit' | 'prepare' | 'preparation' | 'completePreparation'> = new TestRequestService(),
    private readonly results: Pick<FrameworkResultService, 'detail'> = new FrameworkResultService(),
    private readonly bindings: () => RoutineLaneBindings = configuredRoutineLanes,
    private readonly sources: Pick<GithubRoutineSourceGateway, 'resolve' | 'inventory'> = new GithubRoutineSourceGateway(),
    private readonly fleet: Pick<RoutineJobService, 'submit'> | null = new RoutineJobService()) {}
  async catalog(revision?: string) {
    const routineRevision = await this.sources.resolve(revision), inventory = await this.sources.inventory(routineRevision);
    return {routineRevision, routines: inventory.files.flatMap(file => {
      const match = /^routines\/([A-Za-z0-9][A-Za-z0-9_.-]{0,119})\/routine\.ts$/.exec(file.path);
      return match && match[1] !== 'shared' ? [{routineId: match[1]}] : [];
    })};
  }
  private originalRequest(selected: z.infer<typeof routineDispatchSchema>, request: StoredRequest) {
    const intent = routineDispatchIntentSchema.safeParse(request.dispatchIntent);
    if (!intent.success || requestInputDigest(intent.data) !== request.dispatchIntentSha256)
      throw new TestRunError(503, 'Stored dispatch intent is unavailable');
    if (intent.data.requestId !== selected.requestId || intent.data.routineId !== selected.routineId || intent.data.platform !== selected.platform ||
      intent.data.minimumFrameworkVersion !== selected.minimumFrameworkVersion ||
      selected.routineRevision && selected.routineRevision !== intent.data.routineRevision ||
      selected.routineSource && requestInputDigest(selected.routineSource) !== requestInputDigest(intent.data.routineSource ?? null) ||
      requestInputDigest(selected.source) !== requestInputDigest(intent.data.source))
      throw new TestRunError(409, 'Request retry changed its original routine/platform or exact source');
    return request;
  }
  async validatePreparationSource(intent: {routineId: string; platform: string; routineRevision: string}) {
    const ordinary = await this.definitions.getExact(intent.routineId, intent.platform, intent.routineRevision, true);
    if (!ordinary && await this.definitions.getExact(intent.routineId, intent.platform, intent.routineRevision, false))
      throw new TestRunError(422, 'Candidate-only routine source requires its accepted authoring job and review authorization');
  }
  /** Rerun previews inherit explicit old routine source and immutable app references. */
  async prepareIntent(input: unknown, original?: {hostId: string; laneId: string; build: z.infer<typeof frameworkRequestInputSchema>['build']}) {
    const selected = routineDispatchSchema.parse(input), binding = original ?? this.bindings()[selected.platform];
    if (!binding) throw new TestRunError(409, `No configured host/lane binding for ${selected.platform}.`);
    const registered = selected.routineSource ? await this.definitions.getExact(selected.routineId, selected.platform, selected.routineSource.commit, true) : null;
    if (registered && requestInputDigest(registered.routineSource) !== requestInputDigest(selected.routineSource))
      throw new TestRunError(409, 'Explicit routine source differs from immutable enrollment');
    const routineRevision = registered || original && selected.routineSource ? selected.routineSource!.commit :
      await this.sources.resolve(selected.routineRevision ?? selected.routineSource?.commit);
    if (!original) {
      const host = await this.hosts.get(binding.hostId);
      if (!host || host.hostId !== binding.hostId || !Number.isFinite(Date.parse(host.receivedAt)) || Date.now() - Date.parse(host.receivedAt) > 120_000 ||
        !host.lanes.some(lane => lane.id === binding.laneId && lane.platform === selected.platform))
        throw new TestRunError(409, 'Assigned host has no current matching lane observation');
    }
    const build = original ? recordedRoutineBuild(original.build, selected.source, selected.platform) : await this.builds.resolve(selected.source, selected.platform);
    if (build.availability !== 'available' || !build.archive || !build.receipt) throw new TestRunError(409, build.reason ?? 'Exact app publication is unavailable');
    const frozen = original?.build ?? JSON.parse(JSON.stringify({...selectedBuildInput(build, selected.platform), ...(build.manifest ? {manifest: build.manifest, manifestSha256: build.manifestSha256} : {})}));
    const dispatchIntent = routineDispatchIntentSchema.parse({...selected, routineRevision, laneId: binding.laneId, build: frozen});
    await this.validatePreparationSource(dispatchIntent);
    return {hostId: binding.hostId, dispatchIntent};
  }
  async submit(input: unknown) {
    if (this.fleet) return this.fleet.submit(input);
    const parsed = routineDispatchSchema.safeParse(input);
    if (!parsed.success) throw new TestRunError(400, 'Invalid exact-source routine request');
    const selected = parsed.data, existing = await this.requests.get(selected.requestId);
    if (existing) return this.originalRequest(selected, existing);
    try {
      const prepared = await this.prepareIntent(selected);
      const row = await this.requests.prepare(prepared.hostId, prepared.dispatchIntent);
      return this.reconcile(row);
    } catch (error) {
      const winner = await this.requests.get(selected.requestId);
      if (winner) return this.originalRequest(selected, winner);
      throw error;
    }
  }
  async prepared(requestId: string, hostId: string, input: unknown) {
    const parsed = preparedRoutineRequestSchema.safeParse(input);
    if (!parsed.success) throw new TestRunError(400, 'Invalid routine preparation completion');
    const value = parsed.data, row = await this.requests.preparation(requestId, hostId, value.dispatchIntentSha256), intent = row.dispatchIntent!;
    const fleet = row as StoredRequest & {fleetPreparation?: {definitionSha256: string; routineSource: unknown}};
    if (fleet.fleetPreparation && (fleet.fleetPreparation.definitionSha256 !== value.definitionSha256 ||
      requestInputDigest(fleet.fleetPreparation.routineSource) !== requestInputDigest(value.routineSource)))
      throw new TestRunError(409, 'Host preparation differs from the frozen offline definition and source');
    if (row.state === 'terminal' && !isExecutableRequest(row)) return row;
    await this.validatePreparationSource(intent);
    const enrollment = routineEnrollmentSchema.parse({routineId: intent.routineId, platform: intent.platform, definitionRevision: intent.routineRevision,
      routineSource: value.routineSource, definitionSha256: value.definitionSha256, definition: value.definition});
    if (requestInputDigest(value.definition) !== value.definitionSha256 || intent.routineSource && requestInputDigest(intent.routineSource) !== requestInputDigest(value.routineSource))
      throw new TestRunError(409, 'Prepared routine source contradicts the selected intent');
    const exact = await this.definitions.getExact(intent.routineId, intent.platform, intent.routineRevision, true);
    if (exact && (exact.definitionSha256 !== enrollment.definitionSha256 || requestInputDigest(exact.routineSource) !== requestInputDigest(enrollment.routineSource)))
      throw new TestRunError(409, 'Prepared source differs from immutable ordinary enrollment');
    if (isExecutableRequest(row)) {
      const frozen = frameworkRequestInputSchema.parse(row.input);
      if (requestInputDigest(frozen) !== row.inputSha256 || requestInputDigest(frozen.routineSource) !== requestInputDigest(enrollment.routineSource))
        throw new TestRunError(409, 'Prepared source differs from its first executable commit');
      return row;
    }
    if (!exact) await this.definitions.enroll(enrollment, hostId);
    return this.complete(row, enrollment);
  }
  private async complete(row: StoredRequest, definition: z.infer<typeof routineEnrollmentSchema>) {
    const intent = row.dispatchIntent!;
    const build = recordedRoutineBuild(intent.build, intent.source, intent.platform), host = await this.hosts.get(row.hostId);
    const input = routineAdmissionInput(definition, build, {hostId: row.hostId, laneId: intent.laneId}, host, Date.now(),
      {requireAutomatic: false, minimumFrameworkVersion: intent.minimumFrameworkVersion});
    input.build = intent.build;
    return this.requests.completePreparation(row.requestId, row.hostId, row.dispatchIntentSha256!, input);
  }
  private async reconcile(row: StoredRequest): Promise<StoredRequest> {
    if (row.state !== 'preparing') return row;
    const intent = row.dispatchIntent!, exact = await this.definitions.getExact(intent.routineId, intent.platform, intent.routineRevision, true);
    if (!exact) return row;
    try {return await this.complete(row, exact);}
    catch (error) {if (error instanceof TestRunError && (error.status === 409 || error.status === 503)) return row; throw error;}
  }
  async detail(requestId: string) {
    if (!frameworkIdentitySchema.safeParse(requestId).success) throw new TestRunError(400, 'Invalid request identity');
    const request = await this.requests.get(requestId);
    if (!request) throw new TestRunError(404, 'Routine request was not found');
    const current = await this.reconcile(request);
    try {return {request: current, result: await this.results.detail(requestId)};}
    catch (error) {if (error instanceof TestRunError && error.status === 404) return {request: current, result: null}; throw error;}
  }
}

/** Original admissions already verified publication. Reuse their immutable references after a PR closes or moves. */
export function recordedRoutineBuild(input: z.infer<typeof frameworkRequestInputSchema>['build'], source: z.infer<typeof testBuildSourceSchema>, platform: TestBuild['platform']): TestBuild {
  const asset = z.object({url:z.string().url().refine(value=>value.startsWith('https://artifactscdn.mentraglass.com/')),size:z.number().int().positive().safe(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough();
  const parsed = z.object({repository:z.literal('Mentra-Community/MentraOS'),headSha:z.string().regex(/^[a-f0-9]{40}$/),channel:z.enum(['pr','dev','staging']),source:testBuildSourceSchema,archive:asset.extend({name:z.string().min(1)}),receipt:asset,manifest:asset.optional(),manifestSha256:z.string().optional(),releaseIdentity:z.string().optional()}).passthrough().safeParse(input);
  if (!parsed.success || requestInputDigest(parsed.data.source)!==requestInputDigest(source) || parsed.data.channel!==source.channel)
    throw new TestRunError(409,'Original exact app references are incomplete; choose an explicit replacement artifact');
  const build=parsed.data;
  return {source,platform,headSha:build.headSha,title:'Original recorded artifact',createdAt:'1970-01-01T00:00:00Z',buildUrl:`https://github.com/Mentra-Community/MentraOS/actions/runs/${source.buildRunId}`,availability:'available',archive:build.archive,receipt:build.receipt,
    ...(build.manifest?{manifest:build.manifest,manifestSha256:build.manifestSha256}:{}),...(build.releaseIdentity?{release:build.releaseIdentity}:{})};
}
