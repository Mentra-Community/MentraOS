import {useState} from 'react'
import {useInfiniteQuery, useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {RefreshCw} from 'lucide-react'
import type {CaseMutation, CaseOccurrence, CasePr, FailureFollowUp, RoutineCase} from '../../../../packages/core/src/types/routine-case.types'
import type {CaseFollowUpSummary, RoutineFixDelta, RoutineFixInclusion} from '../../../../packages/core/src/types/routine-fix-provenance.types'
import type {RerunAttempt} from '../../../../packages/core/src/types/test-rerun.types'
import {observedTestStatus} from '../../../../packages/core/src/types/test-status-comparison'
import {ApiError, api} from '../lib/api'
import {runDuration} from '../lib/run-duration'
import {LoadingIndicator} from './loading-indicator'
import {TestingButton, TESTING_FIELD, TESTING_LINK, TESTING_PANEL} from './testing-ui'
import {Tooltip} from './tooltip'
import {Input} from './ui/input'
import {Textarea} from './ui/textarea'

const base = '/api/admin/test-runs/follow-ups'
const muted = 'text-xs text-[#656d76]'
const stageNames: Record<RoutineCase['stage'], string> = {investigating: 'Investigating', fixing: 'Fixing', 'in-review': 'In review', 'waiting-deployment': 'Waiting for deployment', verifying: 'Verifying', verified: 'Verified', 'needs-input': 'Needs input'}
type CaseView = FailureFollowUp['case']
type Evidence = RoutineCase['evidence'][number]
type AttemptPage = {attempts: (RerunAttempt & {delta: RoutineFixDelta | null; provenanceUnavailable?: string; inclusions?: RoutineFixInclusion[]})[]; nextBefore: number | null; unavailable?: string}
const prIdentity = (pr: CasePr) => `${pr.repository}#${pr.number}`
const prHref = (pr: CasePr) => `https://github.com/${pr.repository}/pull/${pr.number}`
const runHref = (id: string) => `/?testRun=${encodeURIComponent(id)}`

export function parseFixingPr(value: string): CasePr {
  const match = /^https:\/\/github\.com\/(Mentra-Community\/(?:MentraOS|Mentra-Automated-Testing))\/pull\/([1-9]\d*)\/?$/.exec(value.trim())
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw Error('Use a MentraOS or Automated Testing GitHub PR link')
  return {repository: match[1] as CasePr['repository'], number: Number(match[2])}
}
export function parseCaseEvidence(kind: Evidence['kind'], value: string): Evidence {
  if (kind === 'pull-request') return {kind, ...parseFixingPr(value)}
  const id = value.trim()
  if (kind === 'incident' ? !/^rep_[A-Za-z0-9]{1,80}$/.test(id) : !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(id))
    throw Error(kind === 'incident' ? 'Enter an incident report ID' : 'Enter a run or request ID')
  return {kind, id}
}

function PrLink({pr, observation}: {pr: CasePr; observation?: RoutineCase['prObservations'][number] | null}) {
  return <Tooltip content={observation ? <>Observed {new Date(observation.observedAt).toLocaleString()} · Review {observation.review.replaceAll('-', ' ')}. Inclusion in a tested build is unverified here.</> : 'PR status unavailable; inclusion in a tested build is unverified here.'}>
    <a className={`${TESTING_LINK} text-xs`} href={prHref(pr)} target="_blank" rel="noreferrer">#{pr.number} · {observation?.state ?? 'status unavailable'}</a>
  </Tooltip>
}
export function FollowUpSummary({row}: {row: CaseView}) {
  return <div className="space-y-2 text-xs"><div className="flex flex-wrap items-center gap-2">
    <span className="rounded border border-[#d0d7de] bg-[#f6f8fa] px-2 py-0.5">{row.stage === 'verified' && row.occurrences.some(occurrence => occurrence.closure?.kind !== 'verified') ? 'Closed' : stageNames[row.stage]}</span>
    <span className={muted}>{row.owner ?? 'Unassigned'} · {row.classification === 'undetermined' ? 'Cause undetermined' : `${row.classification} issue`}</span>
    <time className={muted} dateTime={row.updatedAt} title="Last recorded update">{new Date(row.updatedAt).toLocaleString()}</time>
  </div>
    {row.execution && <p className={muted}>Agent {row.execution.state} · {row.execution.owner}</p>}
    {row.diagnosis && <p>{row.diagnosis}</p>}
    {row.nextAction && <p className={muted}>Next: {row.nextAction}</p>}
    {row.input && <p>{row.input.recipient}: {row.input.question}</p>}
    {!!row.evidence.length && <div className="flex flex-wrap gap-2">{row.evidence.map((evidence, index) => <EvidenceLink key={index} evidence={evidence}/>)}</div>}
    {!!row.intendedFixes.length && <div className="flex flex-wrap gap-2">{row.intendedFixes.map(pr => <PrLink key={prIdentity(pr)} pr={pr} observation={row.prObservations.find(observed => prIdentity(observed) === prIdentity(pr))}/>)}</div>}
  </div>
}
function EvidenceLink({evidence}: {evidence: Evidence}) {
  const href = evidence.kind === 'pull-request' ? prHref(evidence) : evidence.kind === 'run' ? runHref(evidence.id) : `/?report=${encodeURIComponent(evidence.id)}`
  return <a className={`${TESTING_LINK} text-xs`} href={href}>{evidence.kind === 'pull-request' ? `PR #${evidence.number}` : evidence.kind === 'run' ? 'Run evidence' : 'Incident report'}</a>
}
function useFollowUpRefresh(requestId: string) {
  const cache = useQueryClient()
  return () => {
    for (const queryKey of [['routine-follow-up', requestId], ['routine-case-detail'], ['routine-case-attempts'], ['suite-follow-ups'], ['test-history']]) void cache.invalidateQueries({queryKey})
  }
}
function MutationError({error, retry, refresh}: {error: Error | null; retry: () => void; refresh: () => void}) {
  if (!error) return null
  const conflict = error instanceof ApiError && error.status === 409
  const uncertain = !(error instanceof ApiError) || error.status >= 500
  return <div role="alert" className="space-y-2 text-xs text-[#cf222e]"><p>{error.message}</p>
    {conflict ? <TestingButton onClick={refresh}>Refresh follow-up</TestingButton> : uncertain ? <TestingButton onClick={retry}>Retry previous action</TestingButton> : null}
  </div>
}
function useCaseUpdate(row: CaseView, requestId: string) {
  const refresh = useFollowUpRefresh(requestId)
  const mutation = useMutation({mutationFn: (body: CaseMutation) => api<FailureFollowUp>(`${base}/${row.caseId}`, {method: 'PATCH', body}), onSuccess: refresh})
  const uncertain = !!mutation.error && (!(mutation.error instanceof ApiError) || mutation.error.status >= 500)
  const conflict = mutation.error instanceof ApiError && mutation.error.status === 409
  return {...mutation, blocked: mutation.isPending || uncertain || conflict, refresh,
    feedback: <MutationError error={mutation.error} refresh={() => {mutation.reset(); refresh()}} retry={() => {if (mutation.variables) mutation.mutate(mutation.variables)}}/>}
}
export function RoutineFollowUp({requestId, failed}: {requestId: string; failed: boolean}) {
  const refresh = useFollowUpRefresh(requestId)
  const query = useQuery({queryKey: ['routine-follow-up', requestId], queryFn: () => api<{followUps: CaseView[]}>(`${base}/original/${encodeURIComponent(requestId)}`), enabled: failed, retry: false, staleTime: 30000})
  const [editing, setEditing] = useState(false)
  const create = useMutation({mutationFn: (body: {requestId: string; mutationId: string}) => api<FailureFollowUp>(base, {method: 'POST', body}), onSuccess: () => {refresh(); setEditing(true)}})
  if (!failed) return null
  if (query.isPending) return <LoadingIndicator inline label="Loading follow-up" className="py-2"/>
  if (query.error instanceof ApiError && query.error.status === 409) return null
  if (query.error) return <p className={muted}>Follow-up unavailable: {query.error.message}</p>
  const rows = query.data?.followUps ?? []
  return <section className={TESTING_PANEL} aria-label="Failure follow-up"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">Follow-up</h3>
    {rows.length ? <TestingButton onClick={() => setEditing(!editing)}>{editing ? 'Close editor' : 'Edit'}</TestingButton> : <TestingButton busy={create.isPending} disabled={!!create.error} onClick={() => create.mutate({requestId, mutationId: crypto.randomUUID()})}>Start follow-up</TestingButton>}</div>
    {!rows.length && <p className={`mt-3 ${muted}`}>Unassigned</p>}
    <MutationError error={create.error} refresh={() => {create.reset(); refresh()}} retry={() => {if (create.variables) create.mutate(create.variables)}}/>
    {rows.map(row => <div key={row.caseId} className="mt-3 space-y-3"><FollowUpSummary row={row}/>
      {editing && <FollowUpEditor key={`editor:${row.caseId}:${row.revision}`} row={row} requestId={requestId}/>}
      <FollowUpHistory key={`history:${row.caseId}:${row.revision}`} row={row} requestId={requestId}/>
    </div>)}
  </section>
}
function FollowUpEditor({row, requestId}: {row: CaseView; requestId: string}) {
  const [classification, setClassification] = useState(row.classification), [diagnosis, setDiagnosis] = useState(row.diagnosis), [nextAction, setNextAction] = useState(row.nextAction)
  const [owner, setOwner] = useState(row.owner ?? ''), [stage, setStage] = useState(row.stage), [question, setQuestion] = useState(row.input?.question ?? ''), [recipient, setRecipient] = useState(row.input?.recipient ?? '')
  const [intendedFixes, setIntendedFixes] = useState(row.intendedFixes), [pr, setPr] = useState(''), [evidence, setEvidence] = useState(row.evidence)
  const [evidenceKind, setEvidenceKind] = useState<Evidence['kind']>('run'), [evidenceValue, setEvidenceValue] = useState(''), [validation, setValidation] = useState<string | null>(null)
  const save = useCaseUpdate(row, requestId)
  const addPr = () => {try {const parsed = parseFixingPr(pr); setIntendedFixes(current => [...current.filter(old => prIdentity(old) !== prIdentity(parsed)), parsed]); setPr(''); setValidation(null)} catch (error) {setValidation((error as Error).message)}}
  const addEvidence = () => {try {const parsed = parseCaseEvidence(evidenceKind, evidenceValue); setEvidence(current => [...current.filter(old => JSON.stringify(old) !== JSON.stringify(parsed)), parsed]); setEvidenceValue(''); setValidation(null)} catch (error) {setValidation((error as Error).message)}}
  return <form className="grid gap-3 border-t border-[#d0d7de] pt-3 text-xs" onSubmit={event => {event.preventDefault(); setValidation(null)
    if (save.blocked) return
    if (pr.trim() || evidenceValue.trim()) {setValidation('Add or clear the pending PR and evidence fields before saving'); return}
    save.mutate({mutationId: crypto.randomUUID(), revision: row.revision, classification, diagnosis, nextAction, owner: owner.trim() || null, stage, intendedFixes, evidence,
      input: stage === 'needs-input' ? {question: question.trim(), recipient: recipient.trim()} : null})}}>
    <div className="grid gap-3 sm:grid-cols-2"><label>Cause<select aria-label="Cause classification" className={TESTING_FIELD} value={classification} onChange={event => setClassification(event.target.value as typeof classification)}>{['undetermined', 'app', 'framework', 'routine'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Stage<select aria-label="Follow-up stage" className={TESTING_FIELD} value={stage} onChange={event => setStage(event.target.value as typeof stage)}>{Object.entries(stageNames).map(([id, name]) => <option key={id} value={id}>{id === 'verified' ? 'Complete (all occurrences settled)' : name}</option>)}</select></label></div>
    <label>Diagnosis<Textarea maxLength={2000} value={diagnosis} onChange={event => setDiagnosis(event.target.value)} rows={2}/></label>
    <label>Next action<Input maxLength={1000} value={nextAction} onChange={event => setNextAction(event.target.value)}/></label>
    <label>Owner<Input maxLength={300} value={owner} disabled={!!row.execution} onChange={event => setOwner(event.target.value)}/>{row.execution && <span className={muted}>Settle the agent claim before changing owner.</span>}</label>
    {stage === 'needs-input' && <div className="grid gap-3 sm:grid-cols-2"><label>Recipient<Input required maxLength={300} value={recipient} onChange={event => setRecipient(event.target.value)}/></label>
      <label>Unanswered question<Textarea required maxLength={1000} rows={2} value={question} onChange={event => setQuestion(event.target.value)}/></label></div>}
    <div><label>Intended fixing PR<Input placeholder="https://github.com/Mentra-Community/MentraOS/pull/…" value={pr} onChange={event => setPr(event.target.value)}/></label>
      <TestingButton className="mt-2" disabled={!pr.trim() || intendedFixes.length >= 20} onClick={addPr}>Add PR</TestingButton>
      <ul className="mt-2 space-y-1">{intendedFixes.map(value => <li key={prIdentity(value)} className="flex items-center gap-2"><PrLink pr={value} observation={row.prObservations.find(observed => prIdentity(observed) === prIdentity(value))}/><TestingButton variant="ghost" aria-label={`Remove PR ${value.number}`} onClick={() => setIntendedFixes(current => current.filter(old => prIdentity(old) !== prIdentity(value)))}>Remove</TestingButton></li>)}</ul>
    </div>
    <div><span>Evidence</span><div className="mt-1 flex flex-wrap gap-2"><select aria-label="Evidence type" className={`${TESTING_FIELD} w-auto`} value={evidenceKind} onChange={event => setEvidenceKind(event.target.value as Evidence['kind'])}><option value="run">Run</option><option value="incident">Incident</option><option value="pull-request">PR</option></select>
      <Input className="min-w-40 flex-1" aria-label="Evidence reference" placeholder={evidenceKind === 'pull-request' ? 'GitHub PR link' : evidenceKind === 'incident' ? 'rep_…' : 'Run or request ID'} value={evidenceValue} onChange={event => setEvidenceValue(event.target.value)}/>
      <TestingButton disabled={!evidenceValue.trim() || evidence.length >= 30} onClick={addEvidence}>Add evidence</TestingButton></div>
      <ul className="mt-2 space-y-1">{evidence.map((value, index) => <li key={JSON.stringify(value)} className="flex items-center gap-2"><EvidenceLink evidence={value}/><TestingButton variant="ghost" aria-label={`Remove evidence ${index + 1}`} onClick={() => setEvidence(current => current.filter((_, i) => i !== index))}>Remove</TestingButton></li>)}</ul>
    </div>
    {validation && <p role="alert" className="text-[#cf222e]">{validation}</p>}{save.feedback}
    <TestingButton className="justify-self-start" busy={save.isPending} disabled={save.blocked} onClick={event => event.currentTarget.form?.requestSubmit()}>Save follow-up</TestingButton>
  </form>
}
function FollowUpHistory({row, requestId}: {row: CaseView; requestId: string}) {
  const [open, setOpen] = useState(false), refresh = useFollowUpRefresh(requestId)
  const detail = useInfiniteQuery({queryKey: ['routine-case-detail', row.caseId, row.revision], enabled: open, initialPageParam: null as number | null,
    queryFn: ({pageParam}) => api<FailureFollowUp>(`${base}/${row.caseId}?limit=20${pageParam === null ? '' : `&before=${pageParam}`}`), getNextPageParam: page => page.nextBefore ?? undefined, retry: false})
  const reconcile = useMutation({mutationFn: (body: {revision: number; mutationId: string}) => api<FailureFollowUp>(`${base}/${row.caseId}/reconcile-prs`, {method: 'POST', body}), onSuccess: refresh})
  return <details className="text-xs" onToggle={event => {if (event.target === event.currentTarget) setOpen(event.currentTarget.open)}}><summary className={`cursor-pointer ${muted}`}>Activity and tested changes · {row.occurrences.length} occurrence{row.occurrences.length === 1 ? '' : 's'}</summary>
    {open && <div className="mt-3 space-y-3">
      {!!row.intendedFixes.length && <div><Tooltip content="Read current GitHub head, review and merge status for the linked PRs. This does not verify that a build includes the fix."><TestingButton busy={reconcile.isPending} disabled={!!reconcile.error} onClick={() => reconcile.mutate({revision: row.revision, mutationId: crypto.randomUUID()})}><RefreshCw className="size-3.5"/>Refresh PR status</TestingButton></Tooltip><MutationError error={reconcile.error} refresh={() => {reconcile.reset(); refresh()}} retry={() => {if (reconcile.variables) reconcile.mutate(reconcile.variables)}}/></div>}
      <div><h4 className="mb-2 font-medium">Original occurrences</h4>{row.occurrences.map(occurrence => <OccurrenceHistory key={occurrence.occurrenceId} row={row} occurrence={occurrence} requestId={requestId}/>)}</div>
      <div><h4 className="mb-2 font-medium">Activity</h4>{detail.isPending ? <LoadingIndicator inline label="Loading follow-up activity"/> : detail.data?.pages.map(page => page.activity.map(event => <p key={event.revision} className="py-1"><time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time> · {event.actor} · {event.kind.replaceAll('-', ' ')}{event.changed.length ? ` (${event.changed.join(', ')})` : ''}</p>))}
        {detail.error && <p role="alert" className="text-[#cf222e]">{detail.error.message}</p>}
        {detail.hasNextPage && <TestingButton className="mt-2" busy={detail.isFetchingNextPage} onClick={() => void detail.fetchNextPage()}>Older activity</TestingButton>}
      </div>
    </div>}
  </details>
}
function OccurrenceHistory({row, occurrence, requestId}: {row: CaseView; occurrence: CaseOccurrence; requestId: string}) {
  const [open, setOpen] = useState(false), [editing, setEditing] = useState(false)
  const history = useInfiniteQuery({queryKey: ['routine-case-attempts', row.caseId, occurrence.occurrenceId, row.revision], enabled: open, initialPageParam: null as number | null,
    queryFn: ({pageParam}) => api<AttemptPage>(`${base}/${row.caseId}/occurrences/${occurrence.occurrenceId}/attempts${pageParam === null ? '' : `?before=${pageParam}`}`), getNextPageParam: page => page.nextBefore ?? undefined, retry: false})
  const original = occurrence.original, id = original.requestId ?? original.runId ?? occurrence.anchorRunId
  return <details className="border-t border-[#d0d7de] py-2" onToggle={event => {if (event.target === event.currentTarget) setOpen(event.currentTarget.open)}}>
    <summary className="cursor-pointer"><span>{original.routineId ?? 'Routine unknown'} · {original.platform ?? 'Platform unknown'} · {original.environment} · {original.branch}</span><span className={`ml-2 ${muted}`}>{occurrence.closure?.kind === 'verified' ? 'Verified' : occurrence.closure ? 'Closed' : 'Open'}</span></summary>
    {open && <div className="mt-2 space-y-2"><div className="flex flex-wrap gap-3"><a className={`${TESTING_LINK} text-xs`} href={runHref(id)}>{original.requestId || original.runId ? 'Original run' : 'Historical anchor'}</a>{original.suiteId && <a className={`${TESTING_LINK} text-xs`} href={`/?testSuite=${encodeURIComponent(original.suiteId)}`}>Original suite</a>}
      <TestingButton onClick={() => setEditing(!editing)}>{editing ? 'Close editor' : 'Record verification or closure'}</TestingButton></div>
      {occurrence.closure && <p className={muted}>{occurrence.closure.reason} · {new Date(occurrence.closure.at).toLocaleString()}{occurrence.closure.requestId && <> · <a className={TESTING_LINK} href={runHref(occurrence.closure.requestId)}>Verification run</a></>}</p>}
      {!!occurrence.verificationRequestIds.length && <div className="flex flex-wrap gap-2">{occurrence.verificationRequestIds.map((value, index) => <a key={value} className={`${TESTING_LINK} text-xs`} href={runHref(value)}>Recorded verification {index + 1}</a>)}</div>}
      {editing && <OccurrenceEditor row={row} occurrence={occurrence} requestId={requestId}/>}
      {history.isPending ? <LoadingIndicator inline label="Loading linked attempts"/> : history.data?.pages.map(page => <div key={page.attempts[0]?.attemptId ?? 'empty'} className="space-y-2">{page.unavailable && <p className={muted}>{page.unavailable}</p>}{page.attempts.map(attempt => <FollowUpAttempt key={attempt.attemptId} attempt={attempt}/>)}</div>)}
      {history.error && <p role="alert" className="text-[#cf222e]">{history.error.message}</p>}
      {history.hasNextPage && <TestingButton busy={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>Older attempts</TestingButton>}
    </div>}
  </details>
}
function OccurrenceEditor({row, occurrence, requestId}: {row: CaseView; occurrence: CaseOccurrence; requestId: string}) {
  const [action, setAction] = useState<'record' | 'verified' | 'closed'>('record'), [run, setRun] = useState(''), [reason, setReason] = useState('')
  const save = useCaseUpdate(row, requestId)
  return <form className="grid gap-2 rounded-lg border border-[#d0d7de] p-3" onSubmit={event => {event.preventDefault(); if (save.blocked) return
    save.mutate({revision: row.revision, mutationId: crypto.randomUUID(), ...(action === 'record' ? {verification: {occurrenceId: occurrence.occurrenceId, requestId: run.trim()}} : {close: {occurrenceId: occurrence.occurrenceId, kind: action, reason: reason.trim(), ...(run.trim() ? {requestId: run.trim()} : {})}})})}}>
    <label>Action<select className={TESTING_FIELD} value={action} onChange={event => setAction(event.target.value as typeof action)}><option value="record">Record linked verification</option><option value="verified">Verify this occurrence</option><option value="closed">Close without a proven fix</option></select></label>
    <label>Linked run or request ID<Input required={action !== 'closed'} value={run} onChange={event => setRun(event.target.value)}/></label>
    {action !== 'record' && <label>Reason<Textarea required maxLength={1000} rows={2} value={reason} onChange={event => setReason(event.target.value)}/></label>}
    {action === 'verified' && <p className={muted}>Requires a demonstrated cause and a complete published passing run for this occurrence.</p>}
    {save.feedback}<TestingButton className="justify-self-start" busy={save.isPending} disabled={save.blocked} onClick={event => event.currentTarget.form?.requestSubmit()}>Save occurrence</TestingButton>
  </form>
}
export function FollowUpAttempt({attempt}: {attempt: AttemptPage['attempts'][number]}) {
  const status = observedTestStatus(attempt), passed = status === 'pass' || status === 'passed', failed = status === 'failed' || status.endsWith('-failed')
  return <div className="rounded-lg border border-[#d0d7de] p-3"><div className="flex flex-wrap items-center gap-2">
    {attempt.requestId || attempt.runId ? <a className={`${TESTING_LINK} text-xs`} href={runHref(attempt.requestId ?? attempt.runId!)}>Attempt {attempt.attemptNumber}</a> : <span>Attempt {attempt.attemptNumber}</span>}
    <span className={passed ? 'text-[#1a7f37]' : failed ? 'text-[#cf222e]' : muted}>{passed ? 'Passed' : status.replaceAll('-', ' ')}</span>
    {attempt.startedAt && <time className={muted} dateTime={attempt.startedAt}>{new Date(attempt.startedAt).toLocaleString()}</time>}
    {runDuration(attempt.startedAt, attempt.finishedAt) && <span className={muted}>{runDuration(attempt.startedAt, attempt.finishedAt)}</span>}
  </div>{attempt.reason && <p className={`mt-1 ${muted}`}>{attempt.reason}</p>}
    {!!attempt.inclusions?.length && <div className="mt-2 flex flex-wrap gap-2">{attempt.inclusions.map(inclusion => <Tooltip key={prIdentity(inclusion)} content={inclusion.reason}><a className={`${TESTING_LINK} text-xs`} href={prHref(inclusion)} target="_blank" rel="noreferrer">#{inclusion.number} · {inclusion.state === 'included' ? `${inclusion.component ?? 'component'} included` : inclusion.state === 'not-yet-tested' ? 'Not yet tested' : 'Inclusion unverified'}</a></Tooltip>)}</div>}
    {attempt.delta ? <div className="mt-2"><p>{attempt.delta.changes.length ? [...new Set(attempt.delta.changes.map(change => change.component))].join(', ') + ' changed' : attempt.delta.noInputChanges && !attempt.delta.unknowns.length ? 'No input changes' : 'No known input changes'}</p>
      {!!attempt.delta.changes.length && <details className="mt-1"><summary className={`cursor-pointer ${muted}`}>Input versions</summary><dl className="mt-1 space-y-1">{attempt.delta.changes.map((change, index) => <div key={index} className="flex flex-wrap gap-x-2"><dt className={muted}>{change.component}</dt><dd className="break-all font-mono text-xs" title={`${change.original} → ${change.attempt}`}>{change.original.length > 45 ? `${change.original.slice(0, 42)}…` : change.original} → {change.attempt.length > 45 ? `${change.attempt.slice(0, 42)}…` : change.attempt}</dd></div>)}</dl></details>}
      {!!attempt.delta.unknowns.length && <details className={`mt-1 ${muted}`}><summary className="cursor-pointer">Unverified scope</summary><ul className="mt-1 list-inside list-disc">{attempt.delta.unknowns.map(value => <li key={value}>{value}</li>)}</ul></details>}
    </div> : <p className={`mt-2 ${muted}`}>{attempt.provenanceUnavailable ?? 'Input provenance unavailable'}</p>}
  </div>
}
export function CompactFollowUp({row}: {row: CaseFollowUpSummary}) {
  return <span className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 ${muted}`} title={`${row.classification} issue; ${row.owner ?? 'Unassigned'}; updated ${new Date(row.updatedAt).toLocaleString()}`}>
    <span>{row.displayStage === 'closed' ? 'Closed' : stageNames[row.displayStage]}{!row.owner && ' · Unassigned'}</span>{row.intendedFixes.map(pr => <PrLink key={prIdentity(pr)} pr={pr} observation={pr.observation}/>)}</span>
}
