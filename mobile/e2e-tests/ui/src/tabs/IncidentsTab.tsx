import {EmptyState} from "../components/EmptyState"
import {SectionCard} from "../components/SectionCard"
import type {MonitorSnapshot} from "../types"
import {formatClock, formatDuration} from "../utils"

function currentDurationMs(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs)
}

function timeToAlertMs(startedAtMs: number, primarySinceMs?: number | null, alertThresholdMs?: number): number | null {
  if (!alertThresholdMs) {
    return null
  }
  const effectiveStartMs = primarySinceMs ?? startedAtMs
  return Math.max(0, alertThresholdMs - (Date.now() - effectiveStartMs))
}

export function IncidentsTab({snapshot}: {snapshot: MonitorSnapshot}) {
  return (
    <div className="tab-layout">
      <div className="content-grid two-up">
        <SectionCard title="Ongoing Incidents" subtitle="Open incidents for the current monitor session">
          {snapshot.ongoing_incidents.length ? (
            <div className="table-scroll">
              <table className="data-table incident-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Role</th>
                    <th>Started</th>
                    <th>Duration</th>
                    <th>Alert</th>
                  </tr>
                </thead>
                <tbody>
                  {[...snapshot.ongoing_incidents]
                    .sort(
                      (left, right) =>
                        Number(Boolean(right.is_primary)) - Number(Boolean(left.is_primary)) ||
                        right.started_at_ms - left.started_at_ms,
                    )
                    .map((incident) => (
                      <tr key={incident.incident_id}>
                        <td>{incident.incident_name || incident.incident_type}</td>
                        <td>
                          {incident.is_primary
                            ? `Primary since ${formatClock(incident.primary_since_ms)}`
                            : `Secondary to ${incident.secondary_to_incident_name || incident.secondary_to_incident_type || "primary"}`}
                        </td>
                        <td>{formatClock(incident.started_at_ms)}</td>
                        <td>{formatDuration(currentDurationMs(incident.started_at_ms))}</td>
                        <td>
                          {incident.alerted_at_ms
                            ? `Alerted at ${formatClock(incident.alerted_at_ms)}`
                            : incident.is_primary
                              ? `In ${formatDuration(timeToAlertMs(incident.started_at_ms, incident.primary_since_ms, incident.alert_threshold_ms))}`
                              : "Suppressed while secondary"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No ongoing incidents"
              detail="The monitor is not tracking any active incident right now."
            />
          )}
        </SectionCard>

        <SectionCard title="Incident History" subtitle="Resolved incidents, newest first">
          {snapshot.completed_incidents.length ? (
            <div className="table-scroll">
              <table className="data-table incident-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Role</th>
                    <th>Started</th>
                    <th>Ended</th>
                    <th>Duration</th>
                    <th>Alert</th>
                  </tr>
                </thead>
                <tbody>
                  {[...snapshot.completed_incidents]
                    .sort((left, right) => (right.ended_at_ms || 0) - (left.ended_at_ms || 0))
                    .map((incident) => (
                      <tr key={`${incident.incident_id}:${incident.ended_at_ms || 0}`}>
                        <td>{incident.incident_name || incident.incident_type}</td>
                        <td>{incident.is_primary ? "Primary" : "Secondary"}</td>
                        <td>{formatClock(incident.started_at_ms)}</td>
                        <td>{formatClock(incident.ended_at_ms)}</td>
                        <td>{formatDuration(incident.duration_ms)}</td>
                        <td>
                          {incident.alerted_at_ms ? `Alerted at ${formatClock(incident.alerted_at_ms)}` : "No alert"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No incident history yet"
              detail="Resolved incidents will appear here once the monitor closes them out."
            />
          )}
        </SectionCard>
      </div>
    </div>
  )
}
