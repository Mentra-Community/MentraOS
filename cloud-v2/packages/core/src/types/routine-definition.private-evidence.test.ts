import {expect, test} from 'bun:test';
import {publishedRoutineDefinitionSchema, routineEnrollmentSchema, routineResourceRequirementSchema} from './routine-definition.types';
const definition = {
  minimumRoutineApiVersion: 1,
  id: 'data-export',
  title: 'Export',
  purpose: 'Check export',
  platforms: ['ios-on-mac'],
  entry: 'home',
  account: 'lane',
  resourceRequirements: [],
  requirements: [],
  fixtures: [],
  setup: [{id: 'setup', instruction: 'Prepare', expected: 'Ready'}],
  steps: ['copy', 'share', 'dismiss', 'home'].map(id => ({id, instruction: id, expected: 'Observed'})),
  source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision: 'a'.repeat(40), path: 'routines/data-export/routine.ts'},
}
test('audio recognition is an explicit requested capability; undeclared and unsupported operations are rejected', () => {
  expect(routineResourceRequirementSchema.safeParse({kind: 'audio', capabilities: ['witness', 'recognition']}).success).toBe(true);
  expect(routineResourceRequirementSchema.safeParse({kind: 'audio', capabilities: ['playback']}).success).toBe(false);
  expect(routineResourceRequirementSchema.safeParse({kind: 'phone', capabilities: ['recognition']}).success).toBe(false);
});
test('private recording intervals retain the exact source declaration without replacing step results', () => {
  const interval = {startStepId: 'share', endStepId: 'dismiss', reason: 'Native share previews contain account data'};
  const parsed = publishedRoutineDefinitionSchema.parse({...definition, privateEvidenceIntervals: [interval]});
  expect(parsed.privateEvidenceIntervals).toEqual([interval]); expect(parsed.steps).toEqual(definition.steps);
  expect(publishedRoutineDefinitionSchema.safeParse(definition).success).toBe(true);
});
test('privacy metadata cannot claim missing, lifecycle, reordered or overlapping product boundaries', () => {
  for (const intervals of [
    [{startStepId: 'missing', endStepId: 'dismiss', reason: 'Private'}],
    [{startStepId: 'setup', endStepId: 'dismiss', reason: 'Private'}],
    [{startStepId: 'dismiss', endStepId: 'share', reason: 'Private'}],
    [{startStepId: 'share', endStepId: 'dismiss', reason: 'Private'}, {startStepId: 'dismiss', endStepId: 'home', reason: 'Private'}],
  ]) expect(publishedRoutineDefinitionSchema.safeParse({...definition, privateEvidenceIntervals: intervals}).success).toBe(false);
});

test('executable resource metadata has one canonical typed shape and cannot omit platform allocation', () => {
  const full = {...definition, resourceRequirements: [{kind:'app',capabilities:[]},{kind:'recorder',capabilities:[]}],
    execution: {resourceKinds:['app','recorder']}}
  const enrollment = {routineId:full.id, platform:'ios-on-mac', definitionRevision:full.source.revision,
    definitionSha256:'a'.repeat(64), definition:full, routineSource:{repository:'Mentra-Community/Mentra-Automated-Testing',
      commit:full.source.revision,minimumRoutineApiVersion:1,bundle:{url:'https://example.invalid/source.tar.gz',sha256:'b'.repeat(64),size:100}}}
  expect(routineEnrollmentSchema.safeParse(enrollment).success).toBe(true)
  const {execution:__,...unexecutable}=full
  expect(publishedRoutineDefinitionSchema.safeParse(unexecutable).success).toBe(false)
  expect(routineEnrollmentSchema.safeParse({...enrollment,definition:unexecutable}).success).toBe(false)
  expect(publishedRoutineDefinitionSchema.safeParse({...full,requires:[]}).success).toBe(false)
  const {resourceRequirements:_,...missing}=full
  expect(publishedRoutineDefinitionSchema.safeParse(missing).success).toBe(false)
  expect(publishedRoutineDefinitionSchema.safeParse({...full,resourceRequirements:[{kind:'app',capabilities:['camera']},{kind:'recorder',capabilities:[]}]}).success).toBe(false)
  expect(routineEnrollmentSchema.safeParse({...enrollment,definition:{...full,resourceRequirements:[{kind:'app',capabilities:[]}],execution:{resourceKinds:['app']}}}).success).toBe(false)
  expect(publishedRoutineDefinitionSchema.safeParse({...full,resourceRequirements:[...full.resourceRequirements,{kind:'fixture-data',capabilities:[]}]}).success).toBe(false)
})
