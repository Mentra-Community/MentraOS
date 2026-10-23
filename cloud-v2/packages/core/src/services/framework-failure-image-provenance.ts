import {z} from 'zod';
import {frameworkAssetIdSchema, type RecordedFrameworkRun} from '../types/framework-run.types';

const time = z.string().datetime({offset: true});
const process = z.object({pid: z.number().int().positive().safe(), startSeq: z.number().int().positive().safe(),
  bootId: z.string().uuid(), apkSha256: z.string().regex(/^[a-f0-9]{64}$/), build: z.string().min(1).max(100)}).strict();
const interval = z.object({assetId: frameworkAssetIdSchema, captureStartedAt: time, captureFinishedAt: time}).strict();
const witness = z.object({original: process.optional(), state: z.enum(['same', 'ceased', 'replaced', 'unknown']), observedAt: time,
  current: process.pick({pid: true, startSeq: true}).optional()}).strict();
const schema = z.object({failureObservedAt: time, phoneProcessWitness: witness.optional(),
  precedingAppImage: interval.extend({boundary: z.enum(['before-email-input', 'before-password-input', 'before-login-submit']), original: process}).optional(),
  currentPhoneImage: interval.extend({source: z.enum(['original-app', 'system'])}).optional(),
  desktopImages: z.array(interval.extend({displayId: z.number().int().nonnegative().safe(), capturedAt: time.optional()})).min(1).max(4).optional(),
}).strict();
export type FailureImageProvenance = z.infer<typeof schema>;
const keys = ['failureObservedAt', 'phoneProcessWitness', 'precedingAppImage', 'currentPhoneImage', 'desktopImages'] as const;
export const hasFailureImageProvenance = (row: Record<string, unknown>) => keys.some(key => row[key] !== undefined);

/** Validate recorded producer evidence; absent timestamps and original processes stay unknown. */
export function recordedFailureImageProvenance(run: RecordedFrameworkRun, row: Record<string, unknown>): FailureImageProvenance | undefined {
  const parsed = schema.safeParse(Object.fromEntries(keys.filter(key => row[key] !== undefined).map(key => [key, row[key]])));
  if (!parsed.success) return;
  const value = parsed.data, started = Date.parse(run.startedAt), finished = Date.parse(run.finishedAt), failed = Date.parse(value.failureObservedAt);
  if (failed < started || failed > finished) return;
  const image = (id: string) => run.assets.filter(asset => asset.id === id && asset.kind === 'screenshot'
    && ['image/png', 'image/jpeg'].includes(asset.mimeType)).length === 1;
  const bounded = (item: z.infer<typeof interval>, before = false) => {
    const start = Date.parse(item.captureStartedAt), end = Date.parse(item.captureFinishedAt);
    return image(item.assetId) && start >= started && end >= start && end <= finished && (before ? end <= failed : start >= failed);
  };
  const phone = value.phoneProcessWitness;
  if (phone) {
    const observed = Date.parse(phone.observedAt);
    if (observed < failed || observed > finished || (!phone.original && phone.state !== 'unknown')) return;
    const same = phone.original && phone.current && phone.original.pid === phone.current.pid && phone.original.startSeq === phone.current.startSeq;
    if (phone.state === 'same' && !same || phone.state === 'ceased' && phone.current || phone.state === 'replaced' && (!phone.current || same)) return;
    // Compare the exact archive when the frozen build records it. Historical absence is not filled in.
    const archive = run.build.archive as {sha256?: unknown} | undefined;
    if (archive?.sha256 !== undefined && phone.original && archive.sha256 !== phone.original.apkSha256) return;
  }
  const preceding = value.precedingAppImage;
  if (preceding && (!phone?.original || !bounded(preceding, true)
    || JSON.stringify(preceding.original) !== JSON.stringify(phone.original)
    || preceding.assetId === row.screenshotAssetId || preceding.assetId === value.currentPhoneImage?.assetId)) return;
  const current = value.currentPhoneImage;
  if (current && (!phone?.original || !bounded(current)
    || (current.source === 'original-app' ? phone.state !== 'same' || row.screenshotAssetId !== current.assetId
      : !['ceased', 'replaced'].includes(phone.state) || row.screenshotAssetId !== undefined))) return;
  if (row.screenshotAssetId !== undefined && (!current || current.source !== 'original-app')) return;
  const desktops = value.desktopImages;
  const desktopIds = row.desktopAssetIds;
  if (desktops && (new Set(desktops.map(item => item.assetId)).size !== desktops.length
    || new Set(desktops.map(item => item.displayId)).size !== desktops.length
    || !Array.isArray(desktopIds) || desktopIds.length !== desktops.length
    || desktops.some(item => !desktopIds.includes(item.assetId) || !bounded(item)
      || item.capturedAt !== undefined && (Date.parse(item.capturedAt) < Date.parse(item.captureStartedAt)
        || Date.parse(item.capturedAt) > Date.parse(item.captureFinishedAt))))) return;
  return value;
}
