import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {useEffect, useRef, useState} from 'react'
import {TestingButton, TESTING_FIELD} from '../components/testing-ui'
import {Tooltip} from '../components/tooltip'
import {api, ApiError} from '../lib/api'
import type {LaneControlInput, LaneControlView, LaneControlsView} from '../../../../packages/core/src/types/lane-control.types'

export const laneControlDescriptions = {
  pause: 'Stop new jobs from using this lane. A running job continues.',
  resume: 'Allow new jobs again. Your reservation and any repair remain unchanged.',
  reserve: 'Hold this lane for your manual work after its current job finishes.',
  release: 'Return your reservation after cleanup so the lane can be used again.',
} as const
export function laneControlState(controls: LaneControlView[], laneId: string) {
  const rows = controls.filter(row => row.laneId === laneId)
  const pending = rows.find(row => !row.receipt)
  const latest = new Map<string, NonNullable<Extract<NonNullable<LaneControlView['receipt']>['result'], {status: 'accepted'}>['reservation']>>()
  const rank = {waiting: 0, granted: 1, returning: 2, released: 3, cancelled: 3}
  for (const row of rows) {
    const reservation = row.receipt?.result.status === 'accepted' ? row.receipt.result.reservation : undefined
    if (reservation && (!latest.has(reservation.id) || rank[reservation.state] >= rank[latest.get(reservation.id)!.state]))
      latest.set(reservation.id, reservation)
  }
  const reservation = [...latest.values()].find(row => ['waiting', 'granted', 'returning'].includes(row.state))
  const failure = rows[rows.length - 1]?.receipt
  return {pending, reservation, failure: failure?.result.status === 'refused' ? failure.result.reason : undefined}
}
export function laneControlsAreFresh(data: LaneControlsView | undefined, updatedAt: number, now = Date.now()) {
  return Boolean(data?.enabled && data.fresh && now - updatedAt < 15000 && now - Date.parse(data.observedAt) < 120000 && Date.parse(data.observedAt) <= now + 5000)
}
export function LaneControls({hostId, laneId, mode, fresh}: {hostId: string; laneId: string; mode: string; fresh: boolean}) {
  const client = useQueryClient(), key = ['lane-controls', hostId]
  const query = useQuery({queryKey: key, queryFn: () => api<LaneControlsView>(`/api/admin/test-runs/lanes/${encodeURIComponent(hostId)}/controls`, {timeoutMs: 5000}),
    refetchInterval: 5000, retry: false})
  const [purpose, setPurpose] = useState(''), [showPurpose, setShowPurpose] = useState(false), [restored, setRestored] = useState<LaneControlInput | null>(null)
  const storageKey = `lane-control:${hostId}:${laneId}`
  const uncertain = useRef<LaneControlInput | null>(null)
  useEffect(() => {
    try {const raw = sessionStorage.getItem(storageKey); if (raw) {const saved = JSON.parse(raw) as LaneControlInput;
      if (saved.hostId === hostId && saved.laneId === laneId && saved.expiresAt > Date.now()) {uncertain.current = saved; setRestored(saved)}}} catch {}
  }, [storageKey])
  const clearPending = () => {uncertain.current = null; setRestored(null); try {sessionStorage.removeItem(storageKey)} catch {}}
  const mutation = useMutation({retry: false, mutationFn: (input: LaneControlInput) =>
    api<LaneControlView>('/api/admin/test-runs/lanes/controls', {method: 'POST', body: input, timeoutMs: 5000}),
    onSuccess: () => {clearPending(); setShowPurpose(false); void client.invalidateQueries({queryKey: key}); void client.invalidateQueries({queryKey: ['lane-overview']})}})
  useEffect(() => {
    if (restored && query.data?.controls.some(row => row.operationId === restored.operationId)) clearPending()
  }, [query.data, restored])
  const {pending, reservation, failure} = laneControlState(query.data?.controls ?? [], laneId)
  const disabledReason = !fresh ? 'Refresh the lane status before making changes.'
    : query.isError ? 'Lane controls could not load. Refresh before making changes.'
    : query.isPending ? 'Loading lane controls.'
    : !query.data?.enabled ? 'This controller has not enabled dashboard lane controls.'
    : !laneControlsAreFresh(query.data, query.dataUpdatedAt) ? 'The controller status is stale. Refresh before making changes.'
    : pending ? 'Waiting for the controller to confirm your last action.' : undefined
  const submit = (action: LaneControlInput['action']) => {
    if (disabledReason || mutation.isPending) return
    const input: LaneControlInput = {operationId: crypto.randomUUID(), expiresAt: Date.now() + 120000, hostId, laneId, action,
      ...(action === 'reserve' ? {purpose: purpose.trim()} : {}),
      ...(action === 'release' && reservation ? {reservation: {id: reservation.id, generation: reservation.generation}} : {})}
    // Retry the exact same operation after a lost response, including after refresh.
    uncertain.current = input; try {sessionStorage.setItem(storageKey, JSON.stringify(input))} catch {} mutation.mutate(input)
  }
  const blocked = Boolean(disabledReason || mutation.isPending || mutation.isError || restored)
  const button = (action: LaneControlInput['action'], label: string, reason?: string) => {
    const disabled = blocked || Boolean(reason)
    return <Tooltip key={action} content={<>{laneControlDescriptions[action]}{reason || disabledReason ? <> {reason ?? disabledReason}</> : null}</>} disabled={disabled}>
      <TestingButton disabled={disabled} busy={mutation.isPending && mutation.variables?.action === action}
        onClick={() => action === 'reserve' ? setShowPurpose(value => !value) : submit(action)}>{label}</TestingButton>
    </Tooltip>
  }
  return <div className="mt-3 border-t border-[#e0e4de] pt-3">
    <div aria-label="Lane controls" className="flex flex-wrap gap-2">
      {button('pause', 'Pause', mode === 'paused' ? 'Scheduling is already paused.' : undefined)}
      {button('resume', 'Resume scheduling', mode === 'automatic' ? 'Scheduling is already automatic.' : undefined)}
      {button('reserve', 'Reserve', reservation ? 'Return your current reservation first.' : mode === 'paused' ? 'Resume scheduling before reserving.' : undefined)}
      {button('release', 'Release', !reservation ? 'You do not hold a reservation on this lane.' : reservation.state === 'returning' ? 'Your reservation is being cleaned up.' : undefined)}
    </div>
    {showPurpose && <form className="mt-3 flex gap-2" onSubmit={event => {event.preventDefault(); submit('reserve')}}>
      <input className={TESTING_FIELD} aria-label="Reservation purpose" placeholder="Purpose of your manual work" maxLength={200}
        value={purpose} onChange={event => setPurpose(event.target.value)} />
      <TestingButton disabled={blocked || !purpose.trim()} onClick={() => submit('reserve')}>Confirm reserve</TestingButton>
    </form>}
    {reservation && <p role="status" className="mt-2 text-xs text-[#59655e]">
      Your reservation: {reservation.state === 'waiting' ? 'Waiting' : reservation.state === 'granted' ? 'Reserved' : 'Cleanup in progress'}
      {reservation.reason ? ` · ${reservation.reason}` : ''}</p>}
    {disabledReason && <p className="mt-2 text-xs text-[#747780]">{disabledReason}</p>}
    {restored && !mutation.isError && <div className="mt-2 text-xs text-[#59655e]"><p>Your previous action still needs its receipt.</p>
      <TestingButton className="mt-2" disabled={mutation.isPending} onClick={() => mutation.mutate(restored)}>Check previous action</TestingButton></div>}
    {failure && <p role="alert" className="mt-2 text-xs text-red-700">{failure}</p>}
    {mutation.isError && <div role="alert" className="mt-2 text-xs text-red-700"><p>{mutation.error.message}</p>
      <TestingButton className="mt-2" busy={mutation.isPending} onClick={() => {
        if (uncertain.current) mutation.mutate(uncertain.current)
      }}>Retry same action</TestingButton>
      {mutation.error instanceof ApiError && [400, 403, 404, 409].includes(mutation.error.status) &&
        <TestingButton className="mt-2 ml-2" onClick={() => {clearPending(); mutation.reset(); void query.refetch()}}>Refresh controls</TestingButton>}</div>}
  </div>
}
