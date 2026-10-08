import {expect, test} from 'bun:test';
import {pendingQueueItem} from './test-pending-queue.service';
import {routineJobInputDigest, routinePortableRequirements} from './routine-job.service';
import {requestInputDigest} from './test-request.service';
import {testRoutineSource} from '../testing/framework-fixtures';
import type {StoredRoutineJob} from '../types/routine-job.types';
import type {ReceivedTestHostState} from './test-host-state.service';
const now = Date.parse('2026-10-08T01:00:00Z');
const definition = {id:'check',minimumRoutineApiVersion:1,title:'Check',purpose:'Verify',platforms:['android'],entry:'home',account:'lane',
  requirements:[],fixtures:[],steps:[{id:'check',instruction:'Check',expected:'Checked'}],
  execution:{resourceKinds:['phone']},resourceRequirements:[{kind:'phone',capabilities:['bluetooth-observe']}],
  source:{repository:'Mentra-Community/Mentra-Automated-Testing',revision:'a'.repeat(40),path:'routines/check/routine.ts'}};
function fixture() {
  const source = {channel:'pr' as const,prNumber:12,buildRunId:55,publicationAttempt:1};
  const selection = {requestId:'request',routineId:'check',platform:'android' as const,routineRevision:'a'.repeat(40),source,
    build:{repository:'Mentra-Community/MentraOS',kind:'android-apk',headSha:'b'.repeat(40),channel:'pr',prNumber:12,source,
      archive:{url:'https://artifactscdn.mentraglass.com/app.apk',name:'app.apk',sha256:'c'.repeat(64),size:100},
      receipt:{url:'https://artifactscdn.mentraglass.com/receipt.json',sha256:'d'.repeat(64),size:100}}};
  const row: StoredRoutineJob = {requestId:'request',state:'awaiting-runner',fleetSelection:selection as any,
    fleetSelectionSha256:requestInputDigest(selection),fleetDeadline:new Date(now+3600_000),createdAt:new Date(now-1000),
    fleetPreparation:{routineSource:testRoutineSource('a'.repeat(40)),definition:definition as any,definitionSha256:requestInputDigest(definition),
      requirements:routinePortableRequirements({platform:'android',definition} as any)}};
  row.fleetInputSha256 = routineJobInputDigest(row);
  const host: ReceivedTestHostState = {hostId:'mini',receivedAt:new Date(now).toISOString(), lanes:[
    {id:'idle',platform:'android',state:'idle',dispatchMode:'automatic',resources:[{id:'phone',kind:'phone',capabilities:['bluetooth-observe']}]},
    {id:'busy',platform:'android',state:'running',dispatchMode:'automatic',resources:[{id:'phone',kind:'phone',capabilities:['bluetooth-observe']}]},
    {id:'paused',platform:'android',state:'idle',dispatchMode:'paused',resources:[{id:'phone',kind:'phone',capabilities:['bluetooth-observe']}]},
    {id:'incompatible',platform:'android',state:'idle',dispatchMode:'automatic',resources:[{id:'phone',kind:'phone',capabilities:[]}]},
  ]} as any;
  return {row,host};
}
test('pending projection labels every compatible lane and keeps availability separate', () => {
  const {row,host} = fixture(), item = pendingQueueItem(row,[host],now);
  expect(item.compatibilityKnown).toBe(true);
  expect(item.compatibleLanes.map(lane=>lane.laneId)).toEqual(['idle','busy','paused']);
  expect(item.compatibleLanes[1]!.state).toBe('running'); expect(item.compatibleLanes[2]!.dispatchMode).toBe('paused');
  host.receivedAt = new Date(now-120_001).toISOString();
  expect(pendingQueueItem(row,[host],now).compatibleLanes.every(lane=>!lane.fresh)).toBe(true);
});
test('exact targets restrict compatibility and unknown source preparation has only candidates', () => {
  const {row,host} = fixture(); row.fleetTarget={hostId:'mini',laneId:'busy'}; row.fleetInputSha256=routineJobInputDigest(row);
  expect(pendingQueueItem(row,[host],now).compatibleLanes.map(lane=>lane.laneId)).toEqual(['busy']);
  delete row.fleetPreparation; delete row.fleetInputSha256; row.state='awaiting-source';
  const unknown=pendingQueueItem(row,[host],now);
  expect(unknown.compatibilityKnown).toBe(false); expect(unknown.compatibleLanes).toEqual([]);
  expect(unknown.platformCandidates.map(lane=>lane.laneId)).toEqual(['busy']);
});
test('corrupt exact requirements cannot produce compatible lane claims or hide neighboring rows', () => {
  const {row,host} = fixture(); row.fleetPreparation!.requirements.resources[0]!.capabilities=[];
  const item=pendingQueueItem(row,[host],now); expect(item.compatibleLanes).toEqual([]); expect(item.reason).toContain('unavailable');
  expect(pendingQueueItem(fixture().row,[host],now).compatibleLanes).toHaveLength(3);
});
