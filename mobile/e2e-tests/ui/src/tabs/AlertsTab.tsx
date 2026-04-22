import {EmptyState} from "../components/EmptyState"
import {SectionCard} from "../components/SectionCard"
import type {MonitorSnapshot} from "../types"
import {formatClock, formatDuration} from "../utils"

export function AlertsTab({snapshot}: {snapshot: MonitorSnapshot}) {
  return (
    <div className="tab-layout">
      <SectionCard
        title="Alert History"
        subtitle="One row per alert threshold crossing, including dispatch and bug report status">
        {snapshot.alerts.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Alerted</th>
                <th>Duration</th>
                <th>Dispatch</th>
                <th>Report</th>
                <th>Incident</th>
              </tr>
            </thead>
            <tbody>
              {[...snapshot.alerts]
                .sort((left, right) => right.alerted_at_ms - left.alerted_at_ms)
                .map((alert) => (
                  <tr key={alert.alert_id}>
                    <td>{alert.incident_name || alert.incident_type}</td>
                    <td>{formatClock(alert.alerted_at_ms)}</td>
                    <td>{formatDuration(alert.duration_ms)}</td>
                    <td>{alert.status}</td>
                    <td>{alert.report_state || "-"}</td>
                    <td>
                      {alert.reported_incident_url ? (
                        <a href={alert.reported_incident_url} target="_blank" rel="noreferrer">
                          {alert.reported_incident_id || "Open"}
                        </a>
                      ) : (
                        alert.report_error || alert.report_reason || "-"
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title="No alerts yet"
            detail="Alerts will show up here after an incident stays open past its alert threshold."
          />
        )}
      </SectionCard>
    </div>
  )
}
