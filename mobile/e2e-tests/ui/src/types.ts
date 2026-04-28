export interface WordState {
  index: number
  text: string
  normalized_text: string
  start_ms: number
  end_ms: number
  expected_ts_ms: number
  rn_first_visible_ts_ms?: number | null
  rn_true_first_visible_ts_ms?: number | null
  logcat_true_first_visible_ts_ms?: number | null
}

export interface CurrentUtterance {
  dataset_row_idx: number
  text: string
  start_ts_ms: number
  end_ts_ms: number
  word_count: number
  rn_matched_word_count: number
  words: WordState[]
}

export interface IncidentRecord {
  incident_id: string
  incident_type: string
  incident_name?: string
  status: string
  started_at_ms: number
  ended_at_ms?: number
  duration_ms?: number
  current_duration_ms?: number
  alerted_at_ms?: number | null
  time_to_alert_ms?: number | null
  dataset_row_idx?: number | null
  utterance_text?: string | null
  reason?: string | null
}

export interface AlertRecord {
  alert_id: string
  incident_id: string
  incident_type: string
  incident_name?: string
  status: string
  started_at_ms: number
  alerted_at_ms: number
  duration_ms: number
  alert_threshold_ms: number
  dataset_row_idx?: number | null
  utterance_text?: string | null
  reason?: string | null
  report_state?: string | null
  report_error?: string | null
  report_reason?: string | null
  reported_incident_id?: string | null
  reported_incident_url?: string | null
}

export interface DelayPoint {
  source: string
  dataset_row_idx: number
  word_index: number
  word_text: string
  ts_ms: number
  delay_ms: number
  expected_ts_ms: number
}

export interface CompletedUtterance {
  dataset_row_idx: number
  text: string
  average_logcat_true_delay_ms?: number | null
  max_logcat_true_delay_ms?: number | null
}

export interface MonitorSnapshot {
  status: string
  status_detail?: string | null
  last_error?: string | null
  started_at_ms: number
  last_logcat_event_ts_ms?: number | null
  logcat_visible_lines: string[]
  current_utterance?: CurrentUtterance | null
  ongoing_incidents: IncidentRecord[]
  completed_incidents: IncidentRecord[]
  alerts: AlertRecord[]
  logcat_true_word_delay_points: DelayPoint[]
  word_delay_points: DelayPoint[]
  completed_utterances: CompletedUtterance[]
}
