import {z} from 'zod';

export const testingRepositorySchema = z.enum(['Mentra-Community/Mentra-Automated-Testing', 'Mentra-Community/Mentra']);
export type TestingRepository = z.infer<typeof testingRepositorySchema>;
export const appRepositorySchema = z.enum(['Mentra-Community/MentraOS', 'Mentra-Community/Mentra']);
export type AppRepository = z.infer<typeof appRepositorySchema>;

const legacy = {repository: 'Mentra-Community/Mentra-Automated-Testing', ref: 'refs/heads/main', sourceRoot: '',
  workflow: 'Mentra-Community/Mentra-Automated-Testing/.github/workflows/routine-device.yml@refs/heads/main'} as const;
const monorepo = {repository: 'Mentra-Community/Mentra', ref: 'refs/heads/dev', sourceRoot: 'testing/',
  workflow: 'Mentra-Community/Mentra/.github/workflows/routine-device.yml@refs/heads/dev'} as const;
export const testingTargetSchema = z.discriminatedUnion('repository', [
  z.object({repository: z.literal(legacy.repository), ref: z.literal(legacy.ref), sourceRoot: z.literal(legacy.sourceRoot),
    workflow: z.literal(legacy.workflow)}).strict(),
  z.object({repository: z.literal(monorepo.repository), ref: z.literal(monorepo.ref), sourceRoot: z.literal(monorepo.sourceRoot),
    workflow: z.literal(monorepo.workflow)}).strict(),
]);
export type TestingTarget = z.infer<typeof testingTargetSchema>;

/** Missing persisted identity always means the old source, independently of deployment settings. */
export function testingTarget(repository: TestingRepository = legacy.repository): TestingTarget {
  return testingRepositorySchema.parse(repository) === legacy.repository ? {...legacy} : {...monorepo};
}
/** Select only new work. Repository determines the branch, source root and exact trusted root workflow. */
export function configuredTestingTarget(env: {TESTING_REPOSITORY?: string} = {TESTING_REPOSITORY: process.env.TESTING_REPOSITORY}): TestingTarget {
  return testingTarget(testingRepositorySchema.parse(env.TESTING_REPOSITORY ?? legacy.repository));
}
/** New build inventories follow the active producer; retained source omissions remain legacy. */
export function configuredAppRepository(env: {TESTING_REPOSITORY?: string} = {TESTING_REPOSITORY: process.env.TESTING_REPOSITORY}): AppRepository {
  return configuredTestingTarget(env).repository === monorepo.repository ? monorepo.repository : 'Mentra-Community/MentraOS';
}
export function retainedTestingTarget(target?: TestingTarget): TestingTarget {
  return target === undefined ? testingTarget() : testingTargetSchema.parse(target);
}
export function routineSourceRepository(value: {routineRepository?: TestingRepository; routineSource?: {repository: TestingRepository}}): TestingRepository {
  if (value.routineRepository && value.routineSource && value.routineRepository !== value.routineSource.repository)
    throw new Error('Routine repository differs from its exact source');
  return testingRepositorySchema.parse(value.routineRepository ?? value.routineSource?.repository ?? legacy.repository);
}
