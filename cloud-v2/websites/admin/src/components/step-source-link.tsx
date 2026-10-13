import {stepSourceSchema} from '../../../../packages/core/src/types/framework-run.types';
import {TESTING_LINK} from './testing-ui';

export function stepSourceHref(source: unknown): string | null {
  const parsed = stepSourceSchema.safeParse(source);
  if (!parsed.success) return null;
  const {repository, revision, path, line} = parsed.data;
  return `https://github.com/${repository}/blob/${revision}/${path.split('/').map(encodeURIComponent).join('/')}#L${line}`;
}
export function StepSourceLink({source}: {source: unknown}) {
  const href = stepSourceHref(source);
  if (!href) return null;
  return <a href={href} target="_blank" rel="noreferrer" className={`${TESTING_LINK} inline-flex shrink-0 items-center rounded p-1`}
    aria-label="View this step on GitHub" title="View this step on GitHub at the recorded commit">
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.57.11.78-.25.78-.55v-2.14c-3.2.69-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.16 1.18a11 11 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.24 2.75.12 3.04.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.06.78 2.14v3.14c0 .3.2.67.79.55A11.5 11.5 0 0 0 12 .7Z"/></svg>
  </a>;
}
