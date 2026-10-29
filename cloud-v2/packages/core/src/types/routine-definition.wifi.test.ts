import {expect, test} from 'bun:test';
import {routineEnrollmentSchema, routineResourceRequirementSchema} from './routine-definition.types';

test.each(['android', 'ios-on-mac'] as const)('enrolls explicit glasses Wi-Fi setup and teardown on %s', platform => {
  const revision = 'a'.repeat(40);
  const resourceRequirements = [
    {kind: 'app', capabilities: []},
    {kind: 'recorder', capabilities: []},
    ...(platform === 'android' ? [{kind: 'phone', capabilities: []}] : []),
    {kind: 'glasses', capabilities: ['connection', 'software', 'wifi']},
  ];
  const definition = {
    id: 'wifi-update', minimumRoutineApiVersion: 33, title: 'Wi-Fi update', purpose: 'Update over glasses Wi-Fi',
    platforms: [platform], entry: 'home', account: 'lane', glasses: {models: ['mentra-live']},
    requirements: [], resourceRequirements, fixtures: [], execution: {resourceKinds: resourceRequirements.map(resource => resource.kind)},
    setup: [{id: 'connect', instruction: 'Connect the enrolled glasses network', expected: 'Connected'}],
    steps: [{id: 'update', instruction: 'Install the offered update', expected: 'Update complete'}],
    teardown: [{id: 'disconnect', instruction: 'Remove station networks', expected: 'Disconnected'}],
    source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision, path: 'routines/wifi-update/routine.ts'},
  };
  const input = {
    routineId: definition.id, platform, definitionRevision: revision, definitionSha256: 'b'.repeat(64), definition,
    routineSource: {repository: definition.source.repository, commit: revision, minimumRoutineApiVersion: 33,
      bundle: {url: 'https://example.invalid/routines.tar.gz', size: 100, sha256: 'c'.repeat(64)}},
  };
  const parsed = routineEnrollmentSchema.parse(input);
  expect(parsed.definition.resourceRequirements.at(-1)?.capabilities).toEqual(['connection', 'software', 'wifi']);
  expect(parsed.definition.setup).toEqual(definition.setup);
  expect(parsed.definition.teardown).toEqual(definition.teardown);
  expect(routineEnrollmentSchema.safeParse({...input, routineSource: {...input.routineSource, minimumRoutineApiVersion: 32}}).success).toBe(false);
});

test('Wi-Fi remains a glasses capability and cannot admit unsupported or duplicate operations', () => {
  expect(routineResourceRequirementSchema.safeParse({kind: 'phone', capabilities: ['wifi']}).success).toBe(false);
  expect(routineResourceRequirementSchema.safeParse({kind: 'glasses', capabilities: ['wifi', 'wifi']}).success).toBe(false);
  expect(routineResourceRequirementSchema.safeParse({kind: 'glasses', capabilities: ['wifi', 'arbitrary-shell']}).success).toBe(false);
});
