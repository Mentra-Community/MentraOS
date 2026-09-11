import {statusTone} from "../utils"

function formatStatusLabel(status: string): string {
  return status
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ")
}

export function StatusBadge({status}: {status: string}) {
  return <span className={`status-badge status-${statusTone(status)}`}>{formatStatusLabel(status)}</span>
}
