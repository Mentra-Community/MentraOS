import {MetricCard} from "../components/MetricCard"
import {RelativeAge} from "../components/RelativeAge"
import {SectionCard} from "../components/SectionCard"
import {StatusBadge} from "../components/StatusBadge"
import type {MonitorSnapshot} from "../types"
import {formatClockWithMs} from "../utils"

interface OverviewTabProps {
  compareDevice?: boolean
  snapshot: MonitorSnapshot
}

export function OverviewTab({compareDevice = false, snapshot}: OverviewTabProps) {
  const visibleWords = snapshot.current_utterance?.words.filter((word) => word.logcat_true_first_visible_ts_ms) ?? []
  const currentWord = visibleWords[visibleWords.length - 1]
  const nextWord = snapshot.current_utterance?.words?.find((word) => !word.logcat_true_first_visible_ts_ms)

  return (
    <div className="tab-layout">
      <div className="metric-grid">
        {compareDevice ? null : (
          <>
            <MetricCard
              label="Status"
              value={<StatusBadge status={snapshot.status} />}
              detail={snapshot.status_detail || "Live monitor health"}
            />
            <MetricCard
              label="Current Row"
              value={snapshot.current_utterance ? `#${snapshot.current_utterance.dataset_row_idx}` : "-"}
              detail={
                snapshot.current_utterance
                  ? `${snapshot.current_utterance.word_count} words in flight`
                  : "Waiting for the next utterance"
              }
            />
          </>
        )}
        <MetricCard
          label="Logcat Feed"
          value={snapshot.logcat_visible_lines.length ? "Active" : "Idle"}
          detail={<RelativeAge ms={snapshot.last_logcat_event_ts_ms} prefix="Last event " />}
        />
        <MetricCard
          label="Open Incidents"
          value={snapshot.ongoing_incidents.length}
          detail={snapshot.ongoing_incidents.length ? "Something needs attention right now" : "No active incidents"}
        />
        <MetricCard label="Alert History" value={snapshot.alerts.length} detail="Alerts persisted to alerts.ndjson" />
        <MetricCard
          label="Incident History"
          value={snapshot.completed_incidents.length}
          detail="Resolved incidents on disk"
        />
      </div>

      <div className="content-grid two-up">
        <SectionCard title="Visible Text" subtitle="Current caption lines from logcat">
          <pre className="terminal-block">
            {snapshot.logcat_visible_lines.length
              ? snapshot.logcat_visible_lines.join("\n")
              : "(no visible caption text right now)"}
          </pre>
        </SectionCard>

        <SectionCard
          title={compareDevice ? "Device Timing" : "Current Timing"}
          subtitle={
            compareDevice
              ? "Caption progress observed on this phone"
              : "Ground-truth alignment for the active utterance"
          }>
          <div className="detail-list">
            {compareDevice ? null : (
              <>
                <div>
                  <span>Utterance start</span>
                  <strong>{formatClockWithMs(snapshot.current_utterance?.start_ts_ms)}</strong>
                </div>
                <div>
                  <span>Utterance end</span>
                  <strong>{formatClockWithMs(snapshot.current_utterance?.end_ts_ms)}</strong>
                </div>
              </>
            )}
            <div>
              <span>Last matched word</span>
              <strong>
                {currentWord ? `${currentWord.text} @ ${formatClockWithMs(currentWord.expected_ts_ms)}` : "-"}
              </strong>
            </div>
            <div>
              <span>Next expected word</span>
              <strong>{nextWord ? `${nextWord.text} @ ${formatClockWithMs(nextWord.expected_ts_ms)}` : "-"}</strong>
            </div>
          </div>
        </SectionCard>
      </div>

      {compareDevice ? null : (
        <SectionCard title="Current Utterance" subtitle="Active reference row being monitored against live captions">
          <div className="large-text">{snapshot.current_utterance?.text || "No utterance is active right now."}</div>
        </SectionCard>
      )}
    </div>
  )
}
