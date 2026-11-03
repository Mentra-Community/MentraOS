import {z} from 'zod'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/)
const text = z.string().max(256)
export const resourceCheckConditionReportSchema = z.object({
  id, label: text, status: z.enum(['passed', 'failed', 'unknown', 'not-checked']),
  reportedStatus: z.enum(['passed', 'failed', 'unknown']).nullable(),
  observed: text.nullable(), expected: text.nullable(), explanation: text.nullable(), repairAction: text.nullable(),
  evidenceRefs: z.array(id).max(4),
  source: z.object({path: z.string().max(512).regex(/^[A-Za-z0-9_.\/-]+$/)
    .refine(value => value.split('/').every(part => part && part !== '.' && part !== '..'), 'Canonical repository-relative source required'), line: z.number().int().positive().safe(),
    revision: z.string().regex(/^[a-f0-9]{40}$/).optional()}).strict().nullable(),
}).strict()
export const resourceCheckReportSchema = z.object({
  resourceId: id, authorityHostId: id, contractVersion: id.nullable(), operationId: id.nullable(),
  checkedAt: z.string().datetime({offset: true}).nullable(), resultSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  outcome: z.enum(['passed', 'failed', 'unknown', 'not-checked']),
  reportedOutcome: z.enum(['passed', 'failed', 'unknown']).nullable().optional(),
  conditions: z.array(resourceCheckConditionReportSchema).max(50), evidenceRefs: z.array(id).max(100),
  currentContract: z.object({contractVersion: id, outcome: z.literal('not-checked'),
    conditions: z.array(resourceCheckConditionReportSchema).max(50)}).strict().refine(value =>
      value.conditions.every(row => row.status === 'not-checked' && row.reportedStatus === null), 'Unobserved current coverage cannot invent passed conditions').optional(),
}).strict().refine(value => new Set(value.conditions.map(row => row.id)).size === value.conditions.length, 'Condition identities must be unique')
  .refine(value => !value.currentContract || new Set(value.currentContract.conditions.map(row => row.id)).size === value.currentContract.conditions.length, 'Current condition identities must be unique')
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 131072, 'Diagnostic report exceeds 128 KiB')
export type ResourceCheckReport = z.infer<typeof resourceCheckReportSchema>
