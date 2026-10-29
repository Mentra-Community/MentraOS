import {useState} from 'react'
import {Copy} from 'lucide-react'
import {api} from '../lib/api'
import {TestingButton} from './testing-ui'

export function CopyRerunLabel({routineId, kind, targetId}: {routineId: string; kind: 's' | 'r'; targetId: string}) {
  const [busy, setBusy] = useState(false), [copied, setCopied] = useState(false), [error, setError] = useState('')
  async function copy() {
    setBusy(true); setError(''); setCopied(false)
    try {
      const query = new URLSearchParams({routineId, kind, targetId})
      const value = await api<{label: string}>(`/api/admin/test-runs/rerun-label?${query}`)
      await navigator.clipboard.writeText(value.label); setCopied(true)
    } catch (cause) {setError(cause instanceof Error ? cause.message : 'Could not copy rerun label')}
    finally {setBusy(false)}
  }
  return <span className="inline-flex flex-wrap items-center gap-2">
    <TestingButton variant="ghost" size="sm" busy={busy} onClick={copy}
      title="Copy a label to apply to your fixing PR. It reruns this original test with the PR build and reports to its Routine tests check.">
      <Copy size={14} aria-hidden="true"/>{copied ? 'Copied' : 'Copy rerun label'}
    </TestingButton>
    {error && <span role="alert" className="max-w-xs text-xs text-[#cf222e]">{error}</span>}
  </span>
}
