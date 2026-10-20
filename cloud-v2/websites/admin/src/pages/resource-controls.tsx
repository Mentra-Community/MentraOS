import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {useEffect, useRef, useState} from 'react'
import {TestingButton, TESTING_FIELD} from '../components/testing-ui'
import {api, ApiError} from '../lib/api'
import {useClock} from '../lib/use-clock'
import type {ResourceControlInput, ResourceControlView, ResourceControlsView} from '../../../../packages/core/src/types/lane-control.types'
import {resourceControlInputSchema} from '../../../../packages/core/src/types/lane-control.types'
import type {ResourceLifecycleSubject} from '../../../../packages/core/src/types/resource-lifecycle.types'
import {advanceResourceReservation, resourceReservationIdentity, resourceReservationGenerationConstraint} from '../../../../packages/core/src/types/resource-control-authority'

type Reservation = NonNullable<Extract<NonNullable<ResourceControlView['receipt']>['result'], {status: 'accepted'}>['reservation']>
const activeStates = new Set(['waiting', 'granted', 'returning'])
export function resourceControlState(rows: ResourceControlView[], resourceId: string, hostId: string) {
  const controls = rows.filter(row => row.subject.resourceId === resourceId && row.hostId === hostId)
  const latest = new Map<string, Reservation>(), constraints = new Map<string, number | undefined>()
  let conflicting: ResourceControlView | undefined
  for (const row of controls) {
    const receipt = row.receipt
    const valid = receipt?.hostId === hostId && receipt.operationId === row.operationId &&
      receipt.subject.resourceId === resourceId && receipt.subject.subjectGeneration === row.subject.subjectGeneration
    const reservation = valid && receipt?.result.status === 'accepted' ? receipt.result.reservation : undefined
    if (reservation?.resourceId === resourceId) {
      const key=resourceReservationIdentity({hostId,subject:{resourceId}},reservation),previous=latest.get(key),
        next=previous?advanceResourceReservation(previous,reservation):reservation
      try {
        const retained=constraints.get(key), incoming=row.reservationGenerationConstraint
        if(retained!==undefined&&incoming!==undefined&&retained!==incoming)throw new Error('Conflicting generation')
        constraints.set(key,resourceReservationGenerationConstraint(retained??incoming,reservation))
        if(next)latest.set(key,next);else conflicting=row
      } catch {conflicting=row}
    }
  }
  const validReceipt = (row: ResourceControlView) => row.receipt?.hostId === hostId && row.receipt.operationId === row.operationId &&
    row.receipt.subject.resourceId === resourceId && row.receipt.subject.subjectGeneration === row.subject.subjectGeneration
  const last = controls.filter(validReceipt).at(-1)?.receipt?.result
  return {pending: conflicting ?? controls.find(row => !validReceipt(row)),
    reservation: [...latest.values()].find(row => activeStates.has(row.state)),
    failure: last?.status === 'refused' ? last.reason : undefined,
    result: last}
}
export function resourceControlsAreFresh(data: ResourceControlsView | undefined, updatedAt: number,
  resource: ResourceLifecycleSubject, now = Date.now()) {
  const observed = Date.parse(data?.observedAt ?? '')
  return Boolean(data?.enabled && data.fresh && resource.current && data.subject.resourceId === resource.subject.id &&
    data.subject.subjectGeneration === resource.generation && now - updatedAt < 15_000 && observed <= now + 5000 && now - observed < 120_000 &&
    [resource.observedAt, resource.receivedAt].every(at => at && Number.isFinite(Date.parse(at)) &&
      Date.parse(at) <= now + 5000 && now - Date.parse(at) < 120_000))
}
const descriptions = {
  reserve: 'Hold this resource for manual use after its current owner returns it.',
  release: 'Return your reservation through cleanup and a fresh readiness check.',
  check: 'Check this resource using its installed provider. Failed readiness starts repair.',
  'mark-out-of-service': 'Stop new jobs from using this resource. Current work keeps its ownership.',
} as const

/** Controls use the existing authenticated delivery path. A delivery response is not resource acquisition. */
export function ResourceControls({resource, fresh}: {resource: ResourceLifecycleSubject; fresh: boolean}) {
  const client = useQueryClient(), now = useClock(), id = resource.subject.id, hostId = resource.subject.authorityHostId
  const manualRestriction = resource.reason?.code === 'resource-operator-out-of-service'
  const key = ['resource-controls', hostId, id]
  const query = useQuery({queryKey: key, queryFn: () => api<ResourceControlsView>(
    `/api/admin/test-runs/resources/${encodeURIComponent(id)}/controls`, {timeoutMs: 5000}), retry: false, refetchInterval: 5000})
  const [purpose, setPurpose] = useState(''), [reason, setReason] = useState('')
  const [form, setForm] = useState<{action: 'reserve' | 'mark-out-of-service'; generation: number} | null>(null)
  const [restored, setRestored] = useState<ResourceControlInput | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  const uncertain = useRef<ResourceControlInput | null>(null), storageKey = `resource-control:${hostId}:${id}`
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey)
      if (raw) {
        const parsed = resourceControlInputSchema.safeParse(JSON.parse(raw))
        if (parsed.success && parsed.data.hostId === hostId && parsed.data.subject.resourceId === id) {
          uncertain.current = parsed.data; setRestored(parsed.data)
        }
      }
    } catch {}
  }, [storageKey, hostId, id])
  const clear = () => {uncertain.current = null; setRestored(null); try {sessionStorage.removeItem(storageKey)} catch {}}
  const mutation = useMutation({retry: false, mutationFn: async (input: ResourceControlInput) => {
    const value = await api<ResourceControlView>('/api/admin/test-runs/lanes/controls', {method: 'POST', body: input, timeoutMs: 5000})
    if (value.operationId !== input.operationId || value.hostId !== input.hostId || value.action !== input.action ||
      value.expiresAt !== input.expiresAt || value.subject?.resourceId !== input.subject.resourceId ||
      value.subject.subjectGeneration !== input.subject.subjectGeneration)
      throw new Error('The delivery response did not match your action. Check the previous action before continuing.')
    return value
  },
    onSuccess: value => {
      // The retained delivery record can be pending. Only its controller receipt establishes the effect.
      client.setQueryData<ResourceControlsView>(key, previous => previous ? {...previous,
        controls: [...previous.controls.filter(row => row.operationId !== value.operationId), value]} : previous)
      clear(); setForm(null); setPurpose(''); setReason('')
      void client.invalidateQueries({queryKey: key}); void client.invalidateQueries({queryKey: ['resource-lifecycle']})
      void client.invalidateQueries({queryKey: ['lane-overview']})
    }})
  useEffect(() => {
    const saved = uncertain.current
    if (saved && query.data?.controls.some(row => row.operationId === saved.operationId && row.hostId === saved.hostId &&
      row.subject.resourceId === saved.subject.resourceId && row.subject.subjectGeneration === saved.subject.subjectGeneration && row.action === saved.action)) {
      clear(); mutation.reset()
    }
  }, [query.data, restored])
  const state = resourceControlState(query.data?.controls ?? [], id, hostId)
  const disabledReason = !fresh ? 'Resource status is stale. Refresh before making changes.'
    : query.isError ? 'Resource controls could not load. Refresh before making changes.'
    : query.isPending ? 'Loading resource controls.'
    : !query.data?.enabled ? 'The installed controller has not enabled resource controls.'
    : !resourceControlsAreFresh(query.data, query.dataUpdatedAt, resource, now) ? 'The resource changed. Refresh its current status before making changes.'
    : state.pending ? 'Waiting for the controller to confirm your last action.' : undefined
  const blocked = Boolean(disabledReason || mutation.isPending || mutation.isError || restored)
  const supported = (action: ResourceControlInput['action']) => (resource.supportedActions as readonly string[]).includes(action)
  const actionReason = (action: ResourceControlInput['action']) => !supported(action) ? 'This action is unavailable in the resource’s current state.'
    : action === 'reserve' && state.reservation ? 'Return your current reservation first.'
    : action === 'release' && !state.reservation ? 'You do not hold a reservation on this resource.'
    : action === 'release' && state.reservation?.state === 'returning' ? 'Your reservation is being cleaned up.' : undefined
  const submit = (action: ResourceControlInput['action']) => {
    if (blocked || actionReason(action) || form && form.generation !== resource.generation ||
      action === 'reserve' && !purpose.trim() || action === 'mark-out-of-service' && !reason.trim()) return
    const input: ResourceControlInput = {operationId: crypto.randomUUID(), hostId,
      subject: {resourceId: id, subjectGeneration: resource.generation}, expiresAt: Date.now() + 120_000, action,
      ...(action === 'reserve' ? {purpose: purpose.trim()} : {}),
      ...(action === 'mark-out-of-service' ? {reason: reason.trim()} : {}),
      ...(action === 'release' && state.reservation ? {reservation: {id: state.reservation.id, generation: state.reservation.generation}} : {})}
    try {
      const encoded = JSON.stringify(input)
      sessionStorage.setItem(storageKey, encoded)
      if (sessionStorage.getItem(storageKey) !== encoded) throw new Error('Intent was not retained')
    } catch {
      setStorageError('Your browser could not save this action for recovery. Nothing was sent. Enable session storage and try again.')
      return
    }
    setStorageError(null); uncertain.current = input
    mutation.mutate(input)
  }
  const button = (action: ResourceControlInput['action'], label: string) => <TestingButton key={action}
    disabled={blocked || Boolean(actionReason(action))} title={actionReason(action) ?? disabledReason ?? descriptions[action]}
    busy={mutation.isPending && mutation.variables?.action === action}
    onClick={() => action === 'reserve' || action === 'mark-out-of-service'
      ? setForm(value => value?.action === action ? null : {action, generation: resource.generation}) : submit(action)}>{label}</TestingButton>
  return <div className="mt-3 border-t border-[#e0e4de] pt-3">
    <div aria-label={`Controls for ${id}`} className="flex flex-wrap gap-2">
      {button('reserve', 'Reserve')}{button('release', 'Release')}{button('check', manualRestriction ? 'Check and return to service' : 'Check readiness')}{button('mark-out-of-service', 'Take out of service')}
    </div>
    {form && <form className="mt-3 flex flex-wrap gap-2" onSubmit={event => {event.preventDefault(); submit(form.action)}}>
      <input className={TESTING_FIELD} aria-label={form.action === 'reserve' ? 'Resource reservation purpose' : 'Out-of-service reason'}
        placeholder={form.action === 'reserve' ? 'Purpose of your manual use' : 'Why this resource is unavailable'} maxLength={form.action === 'reserve' ? 200 : 2000}
        value={form.action === 'reserve' ? purpose : reason} onChange={event => form.action === 'reserve' ? setPurpose(event.target.value) : setReason(event.target.value)} />
      <TestingButton disabled={blocked || Boolean(actionReason(form.action)) || form.generation !== resource.generation || !(form.action === 'reserve' ? purpose : reason).trim()}
        onClick={() => submit(form.action)}>{form.action === 'reserve' ? 'Confirm reserve' : 'Confirm out of service'}</TestingButton>
      {form.generation !== resource.generation && <p role="alert" className="w-full text-sm text-red-700">The resource changed while you were entering this action. Close the form and review its current state.</p>}
    </form>}
    {state.reservation && <p role="status" className="mt-2 text-sm">Your reservation: {state.reservation.state === 'waiting'
      ? 'Waiting for current use to finish' : state.reservation.state === 'granted' ? 'Reserved for you' : 'Returning through cleanup'}
      {state.reservation.reason ? ` · ${state.reservation.reason}` : ''}</p>}
    {state.result?.status === 'accepted' && state.result.check && <p role="status" className="mt-2 text-sm">Readiness check: {state.result.check.state}.</p>}
    {state.result?.status === 'accepted' && state.result.resource && <p role="status" className="mt-2 text-sm">Your out-of-service action was accepted. See the current resource status above.</p>}
    {manualRestriction && <p className="mt-2 text-xs text-[#747780]">A successful check of this exact restriction returns the resource to service. Refreshing this page does not remove it.</p>}
    {storageError && <p role="alert" className="mt-2 text-sm text-red-700">{storageError}</p>}
    {disabledReason && <p className="mt-2 text-xs text-[#747780]">{disabledReason}</p>}
    {state.failure && <p role="alert" className="mt-2 text-sm text-red-700">{state.failure}</p>}
    {(restored || mutation.isError) && <div role="alert" className="mt-2 text-sm text-red-700">
      <p>{mutation.isError ? mutation.error.message : 'Your previous action still needs its delivery receipt.'}</p>
      <TestingButton className="mt-2" busy={mutation.isPending} onClick={() => {if (uncertain.current) mutation.mutate(uncertain.current)}}>Check previous action</TestingButton>
      {mutation.error instanceof ApiError && [400, 403, 404, 409].includes(mutation.error.status) &&
        <TestingButton className="mt-2 ml-2" onClick={() => {clear(); mutation.reset(); void query.refetch(); void client.invalidateQueries({queryKey: ['resource-lifecycle']})}}>Refresh controls</TestingButton>}
    </div>}
  </div>
}
