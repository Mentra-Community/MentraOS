import {RoutineDefinitionService} from './routine-definition.service'
import {TestHostStateService} from './test-host-state.service'
import {isExecutableRequest, requestInputDigest, type StoredRequest} from './test-request.service'
import {recordedFrameworkRequestInputSchema} from '../types/framework-request.types'
import {matchingRoutineProgress, type RoutineLiveProgress} from '../types/routine-progress.types'

/** Display only: the accepted controller heartbeat remains the progress authority. */
export class TestRequestProgressService {
  constructor(private readonly hosts: Pick<TestHostStateService, 'progressObservation'> = new TestHostStateService(),
    private readonly definitions: Pick<RoutineDefinitionService, 'getExact'> = new RoutineDefinitionService(),
    private readonly now: () => number = Date.now) {}

  async get(row: StoredRequest): Promise<RoutineLiveProgress | undefined> {
    if (!isExecutableRequest(row) || !row.hostReceipt || row.state === 'terminal') return
    const input = recordedFrameworkRequestInputSchema.safeParse(row.input)
    if (!input.success || requestInputDigest(input.data) !== row.inputSha256) return
    const host = await this.hosts.progressObservation(row.hostId, input.data.laneId)
    if (!host?.lane.progress) return
    const definition = await this.definitions.getExact(input.data.routineId, input.data.platform, input.data.definitionRevision)
    if (!definition || definition.definitionSha256 !== requestInputDigest(definition.definition)) return
    const steps = definition.definition.steps.map(({id, instruction}) => ({id, instruction}))
    const progress = matchingRoutineProgress(host, host.lane, row, steps.map(step => step.id))
    if (progress) return {progress, receivedAt: host.receivedAt,
      observationAgeMs: Math.max(0, this.now() - Date.parse(host.receivedAt)), title: definition.definition.title, steps}
    return undefined
  }
}
