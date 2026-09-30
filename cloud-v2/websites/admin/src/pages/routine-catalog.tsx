import { ArrowUpRight, CheckCircle2, Monitor, Play, Smartphone } from "lucide-react";
import { TestDispatchPanel } from "./test-dispatches";
import { CATALOG_ROUTINE_IDS, ROUTINE_CATALOG, catalogPassingRunHref, type CatalogRoutine } from "./routine-catalog-data";

const PANEL = "rounded-2xl border border-[#e0e4de] bg-white";
const REQUIREMENTS = { software: "Software", account: "Account", network: "Network", physical: "Physical setup", data: "Test data" } as const;

export function RoutineCatalogPage({ onResult }: { onResult: (runId: string) => void }) {
  return <div className="space-y-5">
    <section className={`${PANEL} p-5`} aria-label="Catalog scope">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{ROUTINE_CATALOG.length} supported routine and platform combinations</h2>
        <span className="rounded-full bg-[#edf7f0] px-3 py-1 text-xs font-semibold text-[#087d50]">Shared foundation</span>
      </div>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-[#4f5d54]">These routines have a published full development run through shared setup, testing and cleanup. Each example includes a passing test, completed cleanup, a ready fixture and a recording.</p>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-[#68746d]">The examples qualify the recorded development run. They do not establish CI enrollment, nightly coverage or a pass on another PR or build. All four run without physical glasses; no glasses firmware is required or qualified.</p>
    </section>

    <div className="grid items-start gap-5 lg:grid-cols-2">
      {ROUTINE_CATALOG.map(routine => <RoutineCatalogCard key={routine.id} routine={routine} />)}
    </div>

    <section className={`${PANEL} overflow-hidden`} aria-label="Request a catalog routine">
      <div className="border-b border-[#eceeeb] p-5">
        <h2 className="text-lg font-semibold">Request a run</h2>
        <p className="mt-2 text-sm leading-6 text-[#4f5d54]">For a MentraOS PR targeting <code>dev</code>, add the exact <code>routine:&lt;id&gt;</code> label shown on its card. The request needs a published, compatible app artifact.</p>
        <p className="mt-3 text-xs font-semibold text-[#4f5d54]">Example: request Captions for PR 123 (replace the PR number)</p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-[#f2f4f0] p-3 text-xs leading-5"><code>gh pr edit 123 --repo Mentra-Community/MentraOS --add-label routine:captions-phone</code></pre>
        <p className="mt-2 text-sm leading-6 text-[#68746d]">For a manual request, choose a routine and a PR, dev or staging build below. Admin checks the published artifact and reports unavailable channels or routines. An enabled worker and a ready fixture are still required; a queued request is not a passing result.</p>
      </div>
      <TestDispatchPanel onResult={onResult} routineIds={CATALOG_ROUTINE_IDS} />
    </section>
  </div>;
}

export function RoutineCatalogCard({ routine }: { routine: CatalogRoutine }) {
  const run = routine.passingRun;
  const Device = routine.platform === "Android" ? Smartphone : Monitor;
  return <article className={`${PANEL} overflow-hidden`} aria-labelledby={`catalog-${routine.id}`}>
    <div className="p-5">
      <div className="flex items-center gap-2 text-xs font-semibold text-[#68746d]"><Device className="size-4" />{routine.platform}</div>
      <h3 id={`catalog-${routine.id}`} className="mt-2 text-lg font-semibold">{routine.name}</h3>
      <p className="mt-2 text-sm leading-6 text-[#4f5d54]">{routine.purpose}</p>
      <div className="mt-4 text-xs text-[#68746d]">PR label <code className="ml-1 inline-block break-all rounded-md bg-[#f2f4f0] px-2 py-1 text-[#303d34]">routine:{routine.id}</code></div>
      <details className="mt-5 border-t border-[#eceeeb] pt-4">
        <summary className="cursor-pointer text-sm font-semibold text-[#303d34]">Requirements and cleanup</summary>
        <dl className="mt-4 space-y-3 text-sm leading-6">
          {Object.entries(REQUIREMENTS).map(([key, label]) => <div key={key}>
            <dt className="font-semibold">{label}</dt>
            <dd className="text-[#68746d]">{routine.requirements[key as keyof typeof REQUIREMENTS]}</dd>
          </div>)}
          <div><dt className="font-semibold">Cleanup</dt><dd className="text-[#68746d]">{routine.cleanup}</dd></div>
          <div><dt className="font-semibold">Outside this routine</dt><dd className="text-[#68746d]">{routine.exclusions}</dd></div>
        </dl>
      </details>
    </div>
    <div className="border-t border-[#e0e4de] bg-[#f7faf6] p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#087d50]"><CheckCircle2 className="size-4" />Development pass</span>
        <time className="text-xs text-[#68746d]" dateTime={run.recordedOn}>{run.recordedOn}</time>
      </div>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-5">
        <dt className="text-[#68746d]">Build</dt><dd>{run.release} · app {run.appVersion} / {run.appBuild}</dd>
        <dt className="text-[#68746d]">Device</dt><dd>{run.device} · <span className="break-all">{run.fixture}</span></dd>
        <dt className="text-[#68746d]">App source</dt><dd><a className="inline-flex items-center gap-1 text-[#087d50] underline" href={`https://github.com/Mentra-Community/MentraOS/commit/${run.appSha}`} target="_blank" rel="noreferrer">{run.appSha.slice(0, 12)}<ArrowUpRight className="size-3" /></a></dd>
      </dl>
      <a className="mt-4 inline-flex items-center gap-2 rounded-lg border border-[#d4e6d8] bg-white px-3 py-2 text-sm font-semibold text-[#087d50] hover:bg-[#edf7f0]" href={catalogPassingRunHref(run)} target="_blank" rel="noreferrer"><Play className="size-4" />Watch passing run<ArrowUpRight className="size-3" /></a>
      <p className="mt-2 text-xs leading-5 text-[#68746d]">Opens the dev Admin result with video, steps and full build identity. Admin sign-in required.</p>
    </div>
  </article>;
}
