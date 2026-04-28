import {statusTone} from "../utils"

export function StatusBadge({status}: {status: string}) {
  return <span className={`status-badge status-${statusTone(status)}`}>{status}</span>
}
