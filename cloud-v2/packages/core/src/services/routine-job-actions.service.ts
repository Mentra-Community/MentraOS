import {z} from 'zod';
import {frameworkIdentitySchema} from '../types/framework-request.types';
import {TestRunGithubApp} from './test-run-github-app';
import {TestRunError} from './test-result-error';
import {configuredTestingTarget, retainedTestingTarget, type TestingTarget} from '../types/testing-source.types';

export interface RoutineActionsRun {actionsRunId: string; status: string; conclusion: string | null}
export interface RoutineActionsDispatch {
  attempts: number; firstAttemptAt?: string; lastAttemptAt: string; acknowledgedAt?: string; checkedAt?: string; error?: string;
  target?: TestingTarget;
}
/** A transport for the existing logical record; GitHub owns the queue and lane selection. */
export interface RoutineJobActions {
  dispatch(jobId: string, target?: TestingTarget): Promise<void>;
  runs?(jobId: string, since: string, target?: TestingTarget): Promise<RoutineActionsRun[]>;
  cancel(actionsRunId: string, target?: TestingTarget): Promise<void>;
}
const run = z.object({id:z.number().int().positive().safe(),display_title:z.string(),event:z.string(),head_branch:z.string().nullable(),
  path:z.string(),created_at:z.string().datetime(),status:z.string(),conclusion:z.string().nullable()}).passthrough();
async function boundedRunBody(response: Response) {
  const limit = 2 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) throw new TestRunError(503, 'Actions run discovery exceeds its bound');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new TestRunError(503, 'Actions run discovery exceeds its bound');
      }
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  return Buffer.concat(chunks).toString('utf8');
}
export class GithubRoutineJobActions implements RoutineJobActions {
  private readonly discoveryFlights = new Map<string, Promise<z.infer<typeof run>[]>>();
  constructor(private readonly app: Pick<TestRunGithubApp, 'token'> = new TestRunGithubApp(),
    private readonly transport: (url: string, init: RequestInit) => Promise<Response> = fetch) {}
  private async request(path: string, target: TestingTarget, method = 'GET', body?: unknown) {
    try {
      const response = await this.transport(`https://api.github.com/repos/${target.repository}/actions/${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000), headers: {
          Authorization: `Bearer ${await this.app.token('dispatch', target.repository)}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
      if (!response.ok) throw new Error('GitHub refused routine delivery');
      return response;
    } catch {throw new TestRunError(503, 'GitHub routine delivery is unavailable; verify the GitHub App Harness Actions write permission and retry the retained job');}
  }
  async dispatch(jobId: string, value: TestingTarget = configuredTestingTarget()) {
    const target = retainedTestingTarget(value), branch = target.ref.slice('refs/heads/'.length);
    frameworkIdentitySchema.parse(jobId);
    const response = await this.request('workflows/routine-device.yml/dispatches', target, 'POST', {ref: branch, inputs: {job_id: jobId}});
    if (![204,202].includes(response.status)) throw new TestRunError(503,'GitHub routine dispatch acknowledgement is unavailable');
  }
  async runs(jobId: string, since: string, value?: TestingTarget): Promise<RoutineActionsRun[]> {
    const target = retainedTestingTarget(value), branch = target.ref.slice('refs/heads/'.length);
    frameworkIdentitySchema.parse(jobId);
    const start=Date.parse(z.string().datetime({offset:true}).parse(since))-30_000;
    // Widen only the provider query. Exact original timestamps remain filtered below.
    const lowerBound=Math.floor(start/60_000)*60_000;
    const key = `${target.workflow}:${lowerBound}`;
    let flight=this.discoveryFlights.get(key);
    if(!flight) {
      if(this.discoveryFlights.size>=20)throw new TestRunError(503,'Concurrent Actions discovery exceeds its bound; retain the job for reconciliation');
      flight=this.discover(lowerBound, target).finally(()=>this.discoveryFlights.delete(key));
      this.discoveryFlights.set(key,flight);
    }
    return (await flight).filter(item=>item.event==='workflow_dispatch' && item.head_branch===branch &&
      ['.github/workflows/routine-device.yml',`.github/workflows/routine-device.yml@${target.ref}`].includes(item.path) &&
      item.display_title===`routine-job:${jobId}` && Date.parse(item.created_at)>=start)
      .map(item=>({actionsRunId:String(item.id),status:item.status,conclusion:item.conclusion}));
  }
  private async discover(start: number, target: TestingTarget): Promise<z.infer<typeof run>[]> {
    const result:z.infer<typeof run>[]=[];
    // Retained suite delivery history can span all ten provider pages.
    // Never interpret the provider result ceiling as absence of active work.
    for(let page=1;page<=10;page++) {
      const query=new URLSearchParams({event:'workflow_dispatch',branch:target.ref.slice('refs/heads/'.length),created:`>=${new Date(start).toISOString()}`,per_page:'100',page:String(page)});
      const response=await this.request(`workflows/routine-device.yml/runs?${query}`, target);
      const text=await boundedRunBody(response);
      const value=z.object({workflow_runs:z.array(run).max(100)}).passthrough().parse(JSON.parse(text));
      result.push(...value.workflow_runs);
      if(value.workflow_runs.length<100)return result;
    }
    throw new TestRunError(503,'Actions run discovery reached the 1,000-result GitHub bound; retain the job for reconciliation');
  }
  async cancel(actionsRunId: string, value?: TestingTarget) {
    const target = retainedTestingTarget(value);
    if (!/^[1-9][0-9]{0,19}$/.test(actionsRunId)) throw new TestRunError(400, 'Invalid Actions run identity');
    const response=await this.request(`runs/${actionsRunId}/cancel`,target,'POST');
    if(![202,204].includes(response.status))throw new TestRunError(503,'GitHub routine cancellation acknowledgement is unavailable');
  }
}
/** Bound work never reoffers; an acknowledged workflow retries only after discovery proves no active delivery. */
export function routineActionsRetry(receipt: RoutineActionsDispatch | undefined, runs: readonly RoutineActionsRun[], now: number) {
  if(receipt && now-Date.parse(receipt.lastAttemptAt)<30_000)return false;
  if(runs.some(run=>run.status!=='completed'))return false;
  if(!receipt?.acknowledgedAt)return true;
  if(runs.length===0 && !receipt.firstAttemptAt)return false;
  return runs.length>0 ? runs.every(run=>run.status==='completed') : now-Date.parse(receipt.acknowledgedAt)>=120_000;
}

export interface RoutineActionsCancellation {checkedAt:string; settled:boolean; error?:string}
/** Core cancellation remains fenced while GitHub delivery creation/cancellation is being reconciled. */
export async function cancelRoutineActions(input:{transport:RoutineJobActions|null;jobId:string;dispatch?:RoutineActionsDispatch;
  known:string[];now:number;retain(run:RoutineActionsRun):Promise<void>}) : Promise<RoutineActionsCancellation & {completedRunIds:string[]}> {
 const checkedAt=new Date(input.now).toISOString();
 if(!input.transport)return {checkedAt,settled:!input.dispatch && input.known.length===0,completedRunIds:[]};
 let runs:RoutineActionsRun[]=[];let discoveryFailed=false;
 try {runs=await input.transport.runs?.(input.jobId,input.dispatch?.firstAttemptAt??input.dispatch?.lastAttemptAt??checkedAt,retainedTestingTarget(input.dispatch?.target))??[];
  for(const run of runs)await input.retain(run);
 } catch {discoveryFailed=true;}
 const completed=new Set(runs.filter(run=>run.status==='completed').map(run=>run.actionsRunId));
 const ids=[...new Set([...input.known.filter(id=>!completed.has(id)),...runs.filter(run=>run.status!=='completed').map(run=>run.actionsRunId)])];
 const cancelled=await Promise.allSettled(ids.map(id=>input.transport!.cancel(id,retainedTestingTarget(input.dispatch?.target))));
 const failed=discoveryFailed||cancelled.some(value=>value.status==='rejected');
 const settled=!failed && (input.transport.runs ? [...new Set([...input.known,...runs.map(run=>run.actionsRunId)])].every(id=>completed.has(id)) &&
  (runs.length>0 || !input.dispatch || input.now-Date.parse(input.dispatch.lastAttemptAt)>=120_000) : true);
 return {checkedAt,settled,completedRunIds:[...completed],...(failed?{error:'GitHub workflow cancellation is pending; Core cancellation remains authoritative'}:{})};
}
