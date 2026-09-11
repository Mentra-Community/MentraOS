import {EmptyState} from "../components/EmptyState"
import {SectionCard} from "../components/SectionCard"
import type {MonitorSnapshot} from "../types"
import {formatClockWithMs} from "../utils"

interface DebugTabProps {
  compareDevice?: boolean
  snapshot: MonitorSnapshot
}

export function DebugTab({compareDevice = false, snapshot}: DebugTabProps) {
  const debugPayload = compareDevice
    ? {
        backend_url: snapshot.backend_url,
        ws_url: snapshot.ws_url,
        last_logcat_event_ts_ms: snapshot.last_logcat_event_ts_ms,
        ongoing_incidents: snapshot.ongoing_incidents,
        alerts: snapshot.alerts.slice(-3),
        logcat_visible_lines: snapshot.logcat_visible_lines,
      }
    : {
        status: snapshot.status,
        status_detail: snapshot.status_detail,
        last_error: snapshot.last_error,
        ongoing_incidents: snapshot.ongoing_incidents,
        alerts: snapshot.alerts.slice(-3),
        logcat_visible_lines: snapshot.logcat_visible_lines,
      }

  return (
    <div className="tab-layout">
      <div className="content-grid two-up">
        <SectionCard
          title={compareDevice ? "Device Snapshot Highlights" : "Raw Snapshot Highlights"}
          subtitle={
            compareDevice ? "Per-phone fields from this device snapshot" : "Key state fields for debugging the monitor"
          }>
          <div className="detail-list">
            {compareDevice ? null : (
              <div>
                <span>Monitor started</span>
                <strong>{formatClockWithMs(snapshot.started_at_ms)}</strong>
              </div>
            )}
            <div>
              <span>Last logcat event</span>
              <strong>{formatClockWithMs(snapshot.last_logcat_event_ts_ms)}</strong>
            </div>
            {compareDevice ? null : (
              <div>
                <span>Last error</span>
                <strong>{snapshot.last_error || "None"}</strong>
              </div>
            )}
          </div>
        </SectionCard>

        <SectionCard title="Current JSON Snapshot" subtitle="Subset of the current /state payload">
          <pre className="terminal-block terminal-tall">{JSON.stringify(debugPayload, null, 2)}</pre>
        </SectionCard>
      </div>

      {compareDevice || !snapshot.last_error ? null : (
        <SectionCard title="Monitor Error" subtitle="Most recent collector error from the Python worker">
          <EmptyState title="Last error" detail={snapshot.last_error} />
        </SectionCard>
      )}
    </div>
  )
}
