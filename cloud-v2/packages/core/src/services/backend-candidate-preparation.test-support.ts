import {RoutineJobService, routineJobInputDigest, type RoutineJobRepository} from './routine-job.service'
import {candidateRenewal, graphCheckOperationId, graphFinalCheckOperationId} from './backend-candidate-preparation'
import {expect} from 'bun:test'
import type {ResourceReadinessCheck} from '../types/backend-connectivity.types'
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures'
import {requestInputDigest} from './test-request.service'
import type {StoredRoutineJob, FleetCandidatePreparation} from '../types/routine-job.types'
import type {ReceivedTestHostState} from './test-host-state.service'

const initialNow = Date.parse('2026-10-20T12:00:00Z'), hash = (c: string) => c.repeat(64)
export function backendCandidateFixture(exclusive = false) {
  let now = initialNow, writes = 0, bindWrites = 0
  const definition = {id:'probe',minimumRoutineApiVersion:1,title:'A check',purpose:'Verify independently',platforms:['android'],entry:'home',account:'lane',requirements:[],fixtures:exclusive?[{provider:'google-authentication',description:'Use the existing test account'}]:[],
    steps:[{id:'check',instruction:'Check',expected:'Checked'}],execution:{resourceKinds:['phone','app','recorder','network',...(exclusive?['fixture-data']:[])],policy:{estimatedOutputBytes:1024}},
    resourceRequirements:[{kind:'phone',capabilities:['backend-connectivity']},{kind:'app',capabilities:[]},{kind:'recorder',capabilities:[]},{kind:'network',capabilities:['independent-uplink']},
      ...(exclusive?[{kind:'fixture-data',capabilities:['google-authentication']}]:[])],
    source:{repository:'Mentra-Community/Mentra-Automated-Testing',revision:'a'.repeat(40),path:'routines/probe/routine.ts'}}
  const source = {channel:'pr' as const,prNumber:12,buildRunId:55,publicationAttempt:1}, build = {kind:'android-apk' as const,repository:'Mentra-Community/MentraOS',channel:'pr',prNumber:12,source,headSha:'b'.repeat(40),
    archive:{name:'app.apk',size:100,sha256:hash('c'),url:'https://artifactscdn.mentraglass.com/app.apk'}, receipt:{size:10,sha256:hash('d'),url:'https://artifactscdn.mentraglass.com/receipt.json'}}
  let row = {requestId:'job-one',state:'awaiting-runner',fleetSelection:{requestId:'job-one',routineId:'probe',platform:'android',source,routineRevision:'a'.repeat(40),build},
    fleetPreparation:{routineSource:testRoutineSource(),definitionSha256:requestInputDigest(definition),definition,requirements:{platform:'android',resources:definition.resourceRequirements}},
    fleetDeadline:new Date(now+300_000),createdAt:new Date(now)} as unknown as StoredRoutineJob
  row.fleetSelectionSha256=requestInputDigest(row.fleetSelection);row.fleetInputSha256=routineJobInputDigest(row)
  const hosts = ['air1','air2'].map(hostId => ({hostId,incarnation:`${hostId}-one`,incarnationGeneration:1,sequence:1,
    observedAt:new Date(now).toISOString(),receivedAt:new Date(now).toISOString(),frameworkBinding:{...testFrameworkBinding(),version:1200,routineApiVersion:70},
    resourceReservations:{claims:[],returns:[],candidatePrerequisites:[]},authorityReservations:[],lanes:[{id:'android',platform:'android',state:'idle',dispatchMode:'automatic',resources:[
      {id:`${hostId}:phone`,kind:'phone',capabilities:['backend-connectivity']},{id:`${hostId}:app`,kind:'app'},
      {id:`${hostId}:recorder`,kind:'recorder',storage:{poolId:`${hostId}:disk`,observedAt:new Date(now).toISOString(),availableBytes:64*1024**3,stagingBudgetBytes:10*1024**3,pendingEvidenceBytes:0,reservations:[]}},
      {id:`${hostId}:network`,kind:'network',capabilities:['independent-uplink']},
      ...(exclusive?[{id:`${hostId}:fixtures`,kind:'fixture-data',capabilities:['google-authentication'],exclusiveDependencies:[{resourceId:'conference-account',authorityHostId:'air2',capability:'google-authentication'}]}]:[])]}],
      ...(exclusive?{resources:[{id:'conference-account',kind:'fixture-data',capabilities:['google-authentication']}]}:{}),resourceLifecycle:{schemaVersion:1,history:[],subjects:[{
        subject:{kind:'resource',id:`${hostId}:phone`,authorityHostId:hostId},generation:1,current:true,status:'unknown',owner:null,
        observedAt:new Date(now).toISOString(),receivedAt:null,reason:null,
        idle:{contractVersion:'phone-baseline',outcome:'not-checked',checkedAt:null,acceptedCheck:null,qualifiedScope:{kind:'same-controller',controllerId:hostId},evidenceRefs:[]},
        repair:{configured:true,state:'none'},supportedActions:[],resource:{kind:'phone',capabilities:['backend-connectivity'],memberships:[{hostId,laneId:'android'}],dependencies:[],placement:'installed'}}]}} as unknown as ReceivedTestHostState))
  const copy = <T>(v:T):T=>structuredClone(v)
  const rows = {async get(id:string){return id===row.requestId?copy(row):null},async recorderClaims(){return []},async selectedLanes(){return [{requestId:'other',hostId:'air2',laneId:'android'}]},
    async *qualificationCandidates(){yield copy(row)},
    async candidatePreparation(original:StoredRoutineJob,pending:FleetCandidatePreparation){if(row.fleetCandidatePreparation||row.fleetCandidateSelection && candidateRenewal(row,pending.hostId,pending.laneId)?.candidate.attemptId!==pending.candidate.previousAttemptId||JSON.stringify(original)!==JSON.stringify(row))return null;writes++;row={...row,fleetCandidatePreparation:copy(pending),fleetCandidateSelection:undefined};return copy(row)},
    async settleCandidatePreparation(original:StoredRoutineJob,pending:FleetCandidatePreparation){if(JSON.stringify(original)!==JSON.stringify(row))return null;row={...row,fleetCandidatePreparations:[...row.fleetCandidatePreparations??[],copy(pending)],fleetCandidatePreparation:undefined,
      ...(pending.settlement?.outcome==='qualified'&&row.state==='awaiting-runner'&&!row.fleetCancellation&&row.fleetDeadline.getTime()>now?{fleetCandidateSelection:{hostId:pending.hostId,laneId:pending.laneId,targetInputSha256:pending.targetInputSha256}}:{})};return copy(row)},
    async reserveResources(_id:string,_sha:string,hostId:string,laneId:string){bindWrites++;row={...row,fleetResourceReservation:{id:'d0af6e63-513c-43d5-9392-ff2e672bab86',requestId:row.requestId,fleetInputSha256:row.fleetInputSha256!,hostId,laneId,poolId:`${hostId}:disk`,minimumAvailableBytes:1024,reservedAt:new Date(now).toISOString(),...(row.fleetPreparation?.requirements.glasses?{chosenModel:hosts.find(host=>host.hostId===hostId)?.lanes.find(lane=>lane.id===laneId)?.glasses?.[0]?.model}:{})}};return copy(row)},
  } as unknown as RoutineJobRepository
  const service = new RoutineJobService(rows,undefined,undefined,undefined,{async get(id){return copy(hosts.find(h=>h.hostId===id)??null)},async list(){return copy(hosts)}},undefined,undefined,()=>now)
  function settle(outcome:'qualified'|'unqualified'|'unknown', rawClosed=true, returnAck=true) {
    const p=row.fleetCandidatePreparation!,host=hosts.find(h=>h.hostId===p.hostId)!,phone=host.lanes[0]!.resources[0]!,subject=host.resourceLifecycle!.subjects[0]!,op=`backend-prerequisite:${p.targetInputSha256}`
    p.backendTarget={schemaVersion:1,coreUrl:'https://core.example/'};subject.generation=3
    p.claimReceipt={kind:'exclusive',id:'d0af6e63-513c-43d5-9392-ff2e672bab86',authorityHostId:host.hostId,borrowerHostId:host.hostId,laneId:p.laneId,resourceId:phone.id,
      operationId:op,intentSha256:hash('e'),inputSha256:p.targetInputSha256,owner:{id:'original-check-owner',kind:'boundary-cleanup'},
      controllerIncarnation:host.incarnation,controllerGeneration:1,borrowerSequence:1,reservedAt:new Date(now).toISOString(),prerequisite:{kind:'backend-connectivity',
        jobId:row.requestId,targetInputSha256:p.targetInputSha256,resourceId:phone.id,binding:p.target.acceptedBinding,candidate:p.candidate,target:p.backendTarget}}
    phone.backendConnectivity={schemaVersion:1,capability:'backend-connectivity',outcome,observedAt:new Date(now).toISOString(),phoneResourceId:phone.id,binding:host.frameworkBinding!,controller:p.candidate.controller,
      app:{headSha:build.headSha,archiveSha256:build.archive.sha256,receiptSha256:build.receipt.sha256},target:p.backendTarget,targetSource:'verified-apk-configuration',
      qualification:{jobId:row.requestId,targetInputSha256:p.targetInputSha256,inputSha256:requestInputDigest(p.target.proposedInput),candidate:p.candidate},bootId:'0c9af811-d3ad-4f91-a21e-31505b6014b2',
      tool:{path:'/trusted/python',sha256:hash('e')},check:{operationId:op,resultSha256:hash('f'),readersSha256:hash('a'),closedAt:new Date(now).toISOString()},releasedGeneration:3,appRouteVerified:false}
    if(returnAck)p.returnReceipt={claimId:'d0af6e63-513c-43d5-9392-ff2e672bab86',authorityHostId:host.hostId,resourceId:phone.id,intentSha256:hash('e'),inputSha256:p.targetInputSha256,
      originalOwner:{id:'original-check-owner',kind:'boundary-cleanup'},laneId:'android',controller:{incarnation:host.incarnation,generation:1,sequence:2},release:{kind:'resource-check',operationId:op,subjectGeneration:3,releasedAt:new Date(now).toISOString(),eventId:'released'}}
    if(rawClosed)host.resourceReservations!.candidatePrerequisites=[{targetInputSha256:p.targetInputSha256,candidate:p.candidate,outcome,hostWorkSettled:true,checkOperationId:op}]
  }
  return {service,rows,hosts,settle,get row(){return row},set row(v){row=v},get writes(){return writes},get bindWrites(){return bindWrites},advance(ms:number){now+=ms;for(const h of hosts){h.observedAt=h.receivedAt=new Date(now).toISOString();for(const subject of h.resourceLifecycle?.subjects??[])subject.observedAt=h.observedAt;h.lanes[0]!.resources.find(r=>r.kind==='recorder')!.storage!.observedAt=new Date(now).toISOString()}},get now(){return now}}
}

export function routingGraphFixture(platform: 'android' | 'ios-on-mac' = 'android') {
  const f = backendCandidateFixture()
  if (platform === 'ios-on-mac') {
    const row = f.row, prepared = row.fleetPreparation!, definition = prepared.definition
    definition.platforms = [platform]
    definition.execution!.resourceKinds = ['app', 'recorder', 'glasses', 'network']
    definition.resourceRequirements = [{kind: 'app', capabilities: []}, {kind: 'recorder', capabilities: []},
      {kind: 'glasses', capabilities: ['connection']}, {kind: 'network', capabilities: ['independent-uplink']}]
    definition.glasses = {models: ['mentra-live']}
    prepared.requirements = {platform, resources: definition.resourceRequirements, glasses: {models: ['mentra-live'], capabilities: ['connection']}}
    prepared.definitionSha256 = requestInputDigest(definition)
    row.fleetSelection = {...row.fleetSelection, platform, build: {...row.fleetSelection.build, kind: 'mac-ci-package',
      manifest: {url: 'https://artifactscdn.mentraglass.com/firmware-live.json', sha256: hash('b'), size: 10}, manifestSha256: hash('b')}}
    row.fleetSelectionSha256 = requestInputDigest(row.fleetSelection); row.fleetInputSha256 = routineJobInputDigest(row)
    for (const host of f.hosts) {
      const lane = host.lanes[0]!
      lane.id = 'mac'; lane.platform = platform
      lane.resources = [...lane.resources.filter(ref => ref.kind !== 'phone'),
        {id: `${host.hostId}:glasses`, kind: 'glasses', capabilities: ['connection']}]
      lane.glasses = [{resourceId: `${host.hostId}:glasses`, deviceId: `${host.hostId}-live`, model: 'mentra-live', capabilities: ['connection']}]
    }
    f.rows.selectedLanes = async () => [{requestId: 'other', hostId: 'air2', laneId: 'mac'}]
  }
  for (const host of f.hosts) {
    host.resourceReservations!.resourceReadiness = true
    const physical = host.lanes[0]!.resources.filter(ref => ref.kind !== 'network'), phoneSubject = host.resourceLifecycle!.subjects[0]!
    host.resourceLifecycle!.subjects = physical.map(ref => {
      ref.idleContract = {version: `${ref.kind}-baseline`, maximumAgeMs: 120_000,
        qualifiedScope: {kind: 'same-controller', controllerId: host.hostId}, conditions: ['original-baseline'],
        repairConfigured: true, dependencies: []}
      return {...structuredClone(phoneSubject), subject: {kind: 'resource' as const, id: ref.id, authorityHostId: host.hostId},
        supportedActions: ['mark-out-of-service' as const], idle: {...phoneSubject.idle, contractVersion: ref.idleContract.version},
        resource: {kind: ref.kind, capabilities: ref.capabilities ?? [], memberships: [{hostId: host.hostId, laneId: host.lanes[0]!.id}],
          dependencies: [], placement: 'installed' as const}}
    })
  }
  function settleGraph(outcome: 'qualified' | 'unqualified' | 'unknown', returnAck = true,
    physicalPhoneOutcome?: 'passed' | 'failed' | 'unknown') {
    const pending = f.row.fleetCandidatePreparation!, purpose = pending.target.purpose
    expect(purpose?.kind).toBe('resource-readiness')
    if (purpose?.kind !== 'resource-readiness') throw Error('Expected graph fixture')
    const host = f.hosts.find(host => host.hostId === pending.hostId)!, owner = {kind: 'boundary-cleanup' as const,
      id: `resource-graph:${pending.targetInputSha256}`}, checkedAt = new Date(f.now).toISOString(), generation = Math.max(...purpose.resources.map(member => member.subjectGeneration)) + 3,
      backendTarget = {schemaVersion: 1 as const, coreUrl: 'https://core.example/'},
      prerequisite = {kind: 'resource-readiness' as const, jobId: f.row.requestId, targetInputSha256: pending.targetInputSha256,
        resourceId: purpose.resourceId, resources: purpose.resources, binding: pending.target.acceptedBinding!, candidate: pending.candidate, ...(platform === 'android' ? {target: backendTarget} : {})},
      checks: ResourceReadinessCheck[] = purpose.resources.map(member => ({resourceId: member.id, checkOperationId:
        (['phone', 'glasses'].includes(member.kind) ? graphFinalCheckOperationId : graphCheckOperationId)(pending.targetInputSha256, member.id),
        outcome: ['phone', 'glasses'].includes(member.kind) ? physicalPhoneOutcome ?? (outcome === 'qualified' ? 'passed' : outcome === 'unknown' ? 'unknown' : 'failed') : 'passed',
        subjectGeneration: generation, contractVersion: member.contractVersion, resultSha256: hash('a'), checkedAt})),
      claims = purpose.resources.map((member, index) => ({kind: 'exclusive', id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        authorityHostId: host.hostId, borrowerHostId: host.hostId, laneId: pending.laneId, resourceId: member.id,
        operationId: `graph-prerequisite:${pending.targetInputSha256}`, inputSha256: pending.targetInputSha256, intentSha256: hash('a'), owner,
        controllerIncarnation: host.incarnation, controllerGeneration: host.incarnationGeneration, borrowerSequence: 1,
        reservedAt: pending.candidate.requestedAt, prerequisite,
        resourceCheck: {resourceId: member.id, subjectGeneration: member.subjectGeneration, contractVersion: member.contractVersion,
          deadlineAt: f.row.fleetDeadline.getTime(), binding: pending.target.acceptedBinding, controller: pending.candidate.controller}})),
      returns = claims.map((claim, index) => ({claimId: claim.id, authorityHostId: host.hostId, resourceId: claim.resourceId,
        inputSha256: claim.inputSha256, intentSha256: claim.intentSha256, originalOwner: owner, laneId: pending.laneId,
        controller: {...pending.candidate.controller, sequence: 2}, release: {kind: 'resource-check', operationId: checks[index]!.checkOperationId,
          subjectGeneration: generation, releasedAt: checkedAt, eventId: `returned:${claim.id}`}})),
      build = pending.target.selection.build,
      backend = {schemaVersion: 1 as const, capability: 'backend-connectivity' as const, outcome, observedAt: checkedAt,
        phoneResourceId: purpose.resources.find(member => member.kind === 'phone')?.id ?? 'no-phone', binding: pending.target.acceptedBinding!,
        controller: pending.candidate.controller, app: {headSha: build.headSha, archiveSha256: build.archive.sha256, receiptSha256: build.receipt.sha256},
        target: backendTarget, targetSource: 'verified-apk-configuration' as const, bootId: '0c9af811-d3ad-4f91-a21e-31505b6014b2',
        qualification: {jobId: f.row.requestId, targetInputSha256: pending.targetInputSha256,
          inputSha256: requestInputDigest(pending.target.proposedInput), candidate: pending.candidate}, tool: {path: '/trusted/python', sha256: hash('a')},
        check: {operationId: graphFinalCheckOperationId(pending.targetInputSha256, purpose.resources.find(member => member.kind === 'phone')?.id ?? 'no-phone'),
          resultSha256: hash('a'), readersSha256: hash('a'), closedAt: checkedAt}, releasedGeneration: generation, appRouteVerified: false as const}
    if (platform === 'android') {
      checks.find(check => check.resourceId === backend.phoneResourceId)!.backendConnectivity = backend
      host.lanes[0]!.resources.find(ref => ref.kind === 'phone')!.backendConnectivity = backend
      pending.backendTarget = backendTarget
    }
    pending.resourceClaims = claims
    if (returnAck) pending.resourceReturns = returns
    for (const check of checks) {
      const subject = host.resourceLifecycle!.subjects.find(subject => subject.subject.id === check.resourceId)!
      subject.generation = generation; subject.status = check.outcome === 'passed' ? 'idle' : 'in-repair'
      subject.idle = {...subject.idle, outcome: check.outcome, checkedAt, acceptedCheck: {
        operationId: check.checkOperationId, subjectGeneration: generation, resultSha256: hash('a'), acceptedAt: checkedAt}}
    }
    host.resourceReservations!.candidatePrerequisites = [{candidate: pending.candidate, targetInputSha256: pending.targetInputSha256,
      outcome, hostWorkSettled: true, checkOperationId: `graph-prerequisite:${pending.targetInputSha256}`, graphChecks: checks}]
  }
  function settleNeverRequested() {
    const pending = f.row.fleetCandidatePreparation!, host = f.hosts.find(value => value.hostId === pending.hostId)!
    host.resourceReservations!.candidatePrerequisites = [{candidate: pending.candidate, targetInputSha256: pending.targetInputSha256,
      outcome: 'unknown', hostWorkSettled: true, checkOperationId: `graph-prerequisite:${pending.targetInputSha256}`,
      graphChecks: [], neverRequested: true}]
    return {pending, host, receipt: host.resourceReservations!.candidatePrerequisites![0]!}
  }
  return {...f, get row() {return f.row}, set row(row) {f.row = row}, get writes() {return f.writes}, get bindWrites() {return f.bindWrites},
    get now() {return f.now}, settleGraph, settleNeverRequested}
}
