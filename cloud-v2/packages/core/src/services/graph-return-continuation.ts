import {isDeepStrictEqual} from 'node:util'
import {resourceReturnContinuationSchema, type ResourceReturnContinuation} from '../types/resource-return-continuation.types'
import type {FleetCandidatePreparation} from '../types/routine-job.types'
import type {ExclusiveResourceReturn} from '../types/resource-reservations.types'
import type {TestHostState} from './test-host-state.service'

/** A retained Core receipt authenticates return only, never candidate admission. */
export function graphReturnContinuation(pending: FleetCandidatePreparation, value: unknown): ResourceReturnContinuation | undefined {
  const parsed = resourceReturnContinuationSchema.safeParse(value)
  if (!parsed.success) return
  const proof = parsed.data, original = proof.history[0]!, successor = proof.history[1]!, current = proof.history.at(-1)!
  if (proof.hostId !== pending.hostId || !isDeepStrictEqual(original.binding, pending.target.acceptedBinding) ||
    original.incarnation !== pending.candidate.controller.incarnation || original.incarnationGeneration !== pending.candidate.controller.generation ||
    original.endReason !== 'observed-stop' || original.endedAt !== proof.stopped.observedAt ||
    proof.stopped.installationId !== original.binding.installationId || !isDeepStrictEqual(proof.stopped.process, original.process) ||
    Date.parse(original.effectiveAt) > Date.parse(pending.candidate.requestedAt) ||
    Date.parse(original.endedAt) > Date.parse(successor.effectiveAt) || current.endedAt || current.endReason ||
    proof.history.some((entry, index) => index > 0 && (
      entry.incarnationGeneration <= proof.history[index - 1]!.incarnationGeneration ||
      proof.history.slice(0, index).some(prior => prior.incarnation === entry.incarnation || isDeepStrictEqual(prior.process, entry.process)) ||
      !isDeepStrictEqual(entry.binding, successor.binding) ||
      index < proof.history.length - 1 && (entry.endReason !== 'accepted-replacement' || entry.endedAt !== proof.history[index + 1]!.effectiveAt)))) return
  return proof
}

export function graphReturnSuccessorMatches(pending: FleetCandidatePreparation, returned: ExclusiveResourceReturn) {
  const proof = graphReturnContinuation(pending, pending.resourceReturnContinuation)
  if (!proof || !('kind' in returned.release)) return false
  const reporter = proof.history.findIndex(entry => entry.incarnation === returned.controller.incarnation &&
    entry.incarnationGeneration === returned.controller.generation), at = Date.parse(returned.release.releasedAt)
  // An ordinary same-installation restart may deliver a release queued by its
  // accepted predecessor. It must not move or regenerate that release.
  return reporter > 0 && proof.history.slice(1, reporter + 1).some(entry =>
    Date.parse(entry.effectiveAt) <= at && (!entry.endedAt || at <= Date.parse(entry.endedAt)))
}

export function graphReturnReporterMatches(pending: FleetCandidatePreparation, snapshot: TestHostState) {
  const proof = graphReturnContinuation(pending, pending.resourceReturnContinuation), current = proof?.history.at(-1)
  return !!current && snapshot.hostId === proof!.hostId && current.incarnation === snapshot.incarnation &&
    current.incarnationGeneration === snapshot.incarnationGeneration && isDeepStrictEqual(current.binding, snapshot.frameworkBinding) &&
    isDeepStrictEqual(current.process, snapshot.frameworkProcess) && current.effectiveAt === snapshot.frameworkAcceptedAt &&
    Date.parse(current.effectiveAt) <= Date.parse(snapshot.observedAt)
}

/** Read only the independently retained Core updater stop and accepted history.
 * The caller still checks current report freshness, exact claims and releases. */
export function currentGraphReturnContinuation(pending: FleetCandidatePreparation, host: {
  hostId: string; incarnation: string; incarnationGeneration: number; snapshot: TestHostState;
  frameworkHistory?: unknown; frameworkStopReceipts?: unknown;
}): ResourceReturnContinuation | undefined {
  if (!Array.isArray(host.frameworkHistory) || !Array.isArray(host.frameworkStopReceipts) || host.hostId !== pending.hostId) return
  const start = host.frameworkHistory.findIndex(entry => entry?.incarnation === pending.candidate.controller.incarnation &&
    entry?.incarnationGeneration === pending.candidate.controller.generation && isDeepStrictEqual(entry?.binding, pending.target.acceptedBinding))
  if (start < 0) return
  const history = host.frameworkHistory.slice(start), original = history[0], current = history.at(-1), snapshot = host.snapshot,
    stopped = host.frameworkStopReceipts.find(stop => stop?.installationId === original.binding.installationId &&
      isDeepStrictEqual(stop?.process, original.process) && stop?.observedAt === original.endedAt),
    proof = graphReturnContinuation(pending, {hostId: host.hostId, stopped, history})
  if (!proof || snapshot.hostId !== host.hostId || current.incarnation !== host.incarnation ||
    current.incarnationGeneration !== host.incarnationGeneration || snapshot.incarnation !== host.incarnation ||
    snapshot.incarnationGeneration !== host.incarnationGeneration || !isDeepStrictEqual(current.binding, snapshot.frameworkBinding) ||
    !isDeepStrictEqual(current.process, snapshot.frameworkProcess) || current.effectiveAt !== snapshot.frameworkAcceptedAt ||
    Date.parse(current.effectiveAt) > Date.parse(snapshot.observedAt)) return
  const previous = pending.resourceReturnContinuation && graphReturnContinuation(pending, pending.resourceReturnContinuation)
  if (pending.resourceReturnContinuation && (!previous || !isDeepStrictEqual(previous.stopped, proof.stopped) ||
    previous.history.length > proof.history.length || previous.history.some((entry, index) => {
      const next = proof.history[index]!
      return !isDeepStrictEqual(entry.binding, next.binding) || !isDeepStrictEqual(entry.process, next.process) ||
        entry.incarnation !== next.incarnation || entry.incarnationGeneration !== next.incarnationGeneration || entry.effectiveAt !== next.effectiveAt ||
        entry.endedAt !== undefined && (entry.endedAt !== next.endedAt || entry.endReason !== next.endReason)
    }))) return
  return proof
}
