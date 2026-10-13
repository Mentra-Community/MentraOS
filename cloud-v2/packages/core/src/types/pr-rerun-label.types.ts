import type {RerunPlan} from './test-rerun.types'

/** GitHub limits label names to 50 characters; ~ explicitly marks a prefix. */
export const GITHUB_LABEL_MAX_LENGTH = 50
export type LabelReference = {value: string; prefix: boolean}
export type PrRerunLabel = {label: string; routine: LabelReference; kind: 's' | 'r'; target: LabelReference}
export type PrLinkedTarget = {
  parent: RerunPlan['parent']; memberId: string; originalRequestId?: string;
  requestedRunId?: string; labels: string[];
}
export const isRoutineCheckLabel = (label: string) => label.startsWith('routine:') || label.startsWith('rerun:')
const identity = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/
const reference = (value: string): LabelReference => {
  const prefix = value.endsWith('~'), text = prefix ? value.slice(0, -1) : value
  if (!identity.test(text)) throw new Error('Invalid routine rerun reference')
  return {value: text, prefix}
}
export function parsePrRerunLabel(label: string): PrRerunLabel {
  const parts = label.split(':')
  if (label.length > GITHUB_LABEL_MAX_LENGTH || parts.length < 4 || parts[0] !== 'rerun' || !['s', 'r'].includes(parts[2]!))
    throw new Error('Use rerun:<routine>:s:<suite> or rerun:<routine>:r:<run>')
  return {label, routine: reference(parts[1]!), kind: parts[2] as 's' | 'r', target: reference(parts.slice(3).join(':'))}
}
export const matchesLabelReference = (reference: LabelReference, id: string) => reference.prefix ? id.startsWith(reference.value) : id === reference.value

/** Choose the longest readable references that fit; the server verifies uniqueness before returning the label. */
export function compactPrRerunLabel(routineId: string, kind: 's' | 'r', targetId: string, targetPrefixLength = 8) {
  if (!identity.test(routineId) || !identity.test(targetId)) throw new Error('This identity cannot be represented by a rerun label')
  const complete = `rerun:${routineId}:${kind}:${targetId}`
  if (complete.length <= GITHUB_LABEL_MAX_LENGTH) return complete
  const targetLength = Math.min(targetPrefixLength, targetId.length)
  const target = targetLength === targetId.length ? targetId : `${targetId.slice(0, targetLength)}~`
  const available = GITHUB_LABEL_MAX_LENGTH - `rerun::${kind}:${target}`.length
  if (available < 2) throw new Error('Rerun identity does not fit a GitHub label')
  const routine = routineId.length <= available ? routineId : `${routineId.slice(0, available - 1)}~`
  return `rerun:${routine}:${kind}:${target}`
}
