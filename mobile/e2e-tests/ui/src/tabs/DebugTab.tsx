import {EmptyState} from "../components/EmptyState"
import {SectionCard} from "../components/SectionCard"
import type {MonitorSnapshot} from "../types"
import {formatClockWithMs} from "../utils"

export function DebugTab({snapshot}: {snapshot: MonitorSnapshot}) {
  return (
    <div className="tab-layout">
      <div className="content-grid two-up">
        <SectionCard title="Raw Snapshot Highlights" subtitle="Key state fields for debugging the monitor">
          <div className="detail-list">
            <div>
              <span>Monitor started</span>
              <strong>{formatClockWithMs(snapshot.started_at_ms)}</strong>
            </div>
            <div>
              <span>Last logcat event</span>
              <strong>{formatClockWithMs(snapshot.last_logcat_event_ts_ms)}</strong>
            </div>
            <div>
              <span>Last error</span>
              <strong>{snapshot.last_error || "None"}</strong>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Current JSON Snapshot" subtitle="Subset of the current /state payload">
          <pre className="terminal-block terminal-tall">
            {JSON.stringify(
              {
                status: snapshot.status,
                status_detail: snapshot.status_detail,
                ongoing_incidents: snapshot.ongoing_incidents,
                alerts: snapshot.alerts.slice(-3),
                logcat_visible_lines: snapshot.logcat_visible_lines,
              },
              null,
              2,
            )}
          </pre>
        </SectionCard>
      </div>

      {!snapshot.last_error ? null : (
        <SectionCard title="Monitor Error" subtitle="Most recent collector error from the Python worker">
          <EmptyState title="Last error" detail={snapshot.last_error} />
        </SectionCard>
      )}
    </div>
  )
}
