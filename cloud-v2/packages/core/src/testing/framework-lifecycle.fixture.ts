import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {frameworkRunSchema} from '../types/framework-run.types';

/** Actual frozen producer output, parsed by the publication contract before use. */
export const lifecycleFixture = z.object({runs: z.array(z.object({
  scenario: z.enum(['routine-teardown', 'diagnostic-failure', 'cleaned-provider-error']),
  definition: z.unknown(), run: z.unknown(),
}))}).parse(JSON.parse(readFileSync(new URL('./framework-lifecycle.harness.fixture.json', import.meta.url), 'utf8')));

export const lifecycleRuns = lifecycleFixture.runs.map(fixture => ({
  ...fixture, producedRun: fixture.run, run: frameworkRunSchema.parse(fixture.run),
}));
