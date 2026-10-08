import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {TESTING_PANEL, TESTING_LINK, TestingButton} from '../components/testing-ui';
import {LoadingIndicator} from '../components/loading-indicator';
import {restorationHostIsFresh, type LaneOverviewHost, type LaneRestorationHost, type LaneRestorationList} from '../../../../packages/core/src/types/lane-restoration.types';
import {api} from '../lib/api';
import {readableLaneIdentity} from '../lib/lane-links';
import {laneOverviewQuery} from './lane-health';

const time = (value: string) => new Date(value).toLocaleString();

export function FrameworkHealth({host, fresh, showHistory = true}: {host: LaneOverviewHost | LaneRestorationHost; fresh: boolean; showHistory?: boolean}) {
  const history = 'restoration' in host ? host.frameworkHistory ?? [] : [],
    last = 'frameworkCurrentInterval' in host ? host.frameworkCurrentInterval : history.at(-1),
    binding = host.frameworkBinding ?? last?.binding
  const stopped = last?.endedAt && last.binding.installationId === binding?.installationId
  const current = !!host.frameworkBinding && fresh && !stopped
  const target = host.deployment?.desiredTarget
  const source = (revision: string) => `https://github.com/Mentra-Community/Mentra-Automated-Testing/commit/${revision}`
  return (
    <article className="mt-3 rounded-xl border border-[#e0e4de] p-4" aria-label="Framework deployment">
      <h4 className="font-semibold">{current ? "Running framework" : "Last confirmed framework"}</h4>
      {binding ? (
        <p className="mt-2 text-sm">
          Version {binding.version} · Routine API {binding.routineApiVersion} ·{" "}
          <a className={TESTING_LINK} href={source(binding.revision)}>
            {binding.revision.slice(0, 10)}
          </a>
        </p>
      ) : (
        <p className="mt-2 text-sm text-[#747780]">Installed framework has not been reported.</p>
      )}
      {!current && binding && (
        <p className="mt-2 text-sm text-[#747780]">
          {stopped
            ? "Controller stop was observed."
            : "Current framework status is unknown because the controller report is stale."}
        </p>
      )}
      {(host.frameworkAcceptedAt ?? last?.effectiveAt) && (
        <p className="mt-1 text-xs text-[#747780]">
          Startup accepted {time((host.frameworkAcceptedAt ?? last?.effectiveAt)!)}
        </p>
      )}
      {host.deployment && (
        <div className="mt-3 text-sm">
          <p className="font-medium">
            Pending framework update:{" "}
            {target ? (
              <>
                <a className={TESTING_LINK} href={source(target.revision)}>
                  Version {target.version} · Routine API {target.routineApiVersion} · {target.revision.slice(0, 10)}
                </a>
              </>
            ) : (
              "None reported"
            )}
          </p>
          {host.deployment.activeTarget && host.deployment.activeTarget.installationId !== target?.installationId && (
            <p className="mt-1">
              Activating version {host.deployment.activeTarget.version} ·{" "}
              {host.deployment.activeTarget.revision.slice(0, 10)}
            </p>
          )}
          <p className="mt-1">
            Waiting for:{" "}
            {host.deployment.reason ??
              (host.deployment.consumers.length
                ? host.deployment.consumers.map((value) => value.reason).join("; ")
                : host.deployment.nextAction)}
          </p>
          <p className="mt-1 text-xs text-[#747780]">
            Deployment {host.deployment.phase} · Observed {time(host.deployment.observedAt)}
          </p>
        </div>
      )}
      {showHistory && !!history.length && <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium">Installation history</summary>
        <FrameworkInstallationHistory history={history} />
      </details>}
    </article>
  )
}

function FrameworkInstallationHistory({history}: {history: NonNullable<LaneRestorationHost['frameworkHistory']>}) {
  return <ol className="mt-2 space-y-2 text-xs">{history.map(entry => <li key={`${entry.incarnation}:${entry.binding.installationId}`}>
    <a className={TESTING_LINK} href={`https://github.com/Mentra-Community/Mentra-Automated-Testing/commit/${entry.binding.revision}`}>
      Version {entry.binding.version} · Routine API {entry.binding.routineApiVersion} · {entry.binding.revision.slice(0, 10)}
    </a>
    <p className="text-[#747780]">Accepted {time(entry.effectiveAt)}{entry.endedAt
      ? ` · Ended ${time(entry.endedAt)} (${entry.endReason === 'observed-stop' ? 'observed stop' : 'accepted replacement'})` : ' · End not observed'}</p>
  </li>)}</ol>;
}
function InstallationHistory({hostId}: {hostId: string}) {
  const query = useQuery({queryKey: ['lane-restoration', hostId], refetchInterval: 30_000,
    queryFn: () => api<LaneRestorationList>(`/api/admin/test-runs/restoration/list?hostId=${encodeURIComponent(hostId)}`)});
  const host = query.data?.hosts.find(value => value.hostId === hostId), history = host?.frameworkHistory ?? [];
  return <>
    {query.isError ? <p className="mt-2 text-sm text-red-700">Installation history could not refresh.{history.length ? ' Showing the last fetched history.' : ''}</p> : null}
    {query.isPending ? <LoadingIndicator label="Loading installation history" className="mt-2" />
      : !history.length ? <p className="mt-2 text-sm text-[#747780]">No installation history was reported.</p>
      : <FrameworkInstallationHistory history={history} />}
  </>;
}
function FrameworkHost({host, fresh}: {host: LaneOverviewHost; fresh: boolean}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  return <div className="mt-5">
    <h3 className="text-sm font-semibold">{readableLaneIdentity(host.hostId)} <span className="font-normal text-[#747780]">({host.hostId})</span></h3>
    <FrameworkHealth host={host} fresh={fresh} showHistory={false} />
    <details className="mt-3 text-sm" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">Installation history</summary>
      {historyOpen ? <InstallationHistory hostId={host.hostId} /> : null}
    </details>
  </div>;
}
export function FrameworkHealthSection({now}: {now: number}) {
  const query = useQuery(laneOverviewQuery);
  return <section className={TESTING_PANEL} aria-label="Framework installations">
    <div className="flex flex-wrap items-start justify-between gap-3"><h2 className="text-xl font-semibold">Framework</h2>
      <TestingButton className="text-sm" busy={query.isFetching} onClick={() => void query.refetch()}>Refresh</TestingButton></div>
    {query.isError ? <p role="alert" className="mt-3 text-sm text-red-700">Framework reports could not refresh. Current status is unknown.</p> : null}
    {query.data?.hosts.map(host => <FrameworkHost key={host.hostId} host={host} fresh={!query.isError && restorationHostIsFresh(host, now, query.data!.freshForMs)} />)}
    {!query.data?.hosts.length ? query.isPending ? <LoadingIndicator label="Loading framework reports" className="mt-4" />
      : <p className="mt-4 text-sm text-[#747780]">No controller framework report is available.</p> : null}
    {query.data?.truncated ? <p className="mt-3 text-sm text-amber-800">Only the first 32 reporting controllers are shown.</p> : null}
  </section>;
}
