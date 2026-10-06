import {expect, test} from 'bun:test';
import {publishedRoutineDefinitionSchema} from './routine-definition.types';
const definition = {
  minimumRoutineApiVersion: 1,
  id: 'data-export',
  title: 'Export',
  purpose: 'Check export',
  platforms: ['ios-on-mac'],
  entry: 'home',
  account: 'lane',
  requires: [],
  requirements: [],
  fixtures: [],
  setup: [{id: 'setup', instruction: 'Prepare', expected: 'Ready'}],
  steps: ['copy', 'share', 'dismiss', 'home'].map(id => ({id, instruction: id, expected: 'Observed'})),
  source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision: 'a'.repeat(40), path: 'routines/data-export/routine.ts'},
}
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
