/** A manual invocation creates a new rerun; a workflow retry reconciles its frozen ID. */
export function rerunSelection(inputs) {
  const list = value => (value || '').split(',').map(v => v.trim()).filter(Boolean);
  const memberIds = list(inputs.member_ids), statuses = list(inputs.statuses), excluded = list(inputs.exclude_member_ids);
  if ((memberIds.length > 0) === (statuses.length > 0)) throw new Error('Choose either member_ids or statuses');
  if (memberIds.length && excluded.length) throw new Error('Exclusions require a status filter');
  const positive = (value, name) => {
    if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${name}`);
    return Number(value);
  };
  const override = Boolean(inputs.build_run_id);
  if (override && !['dev','staging','pr'].includes(inputs.channel)) throw new Error('Invalid app channel');
  const source = !override ? undefined : {channel: inputs.channel, buildRunId: positive(inputs.build_run_id,'build_run_id'), publicationAttempt: positive(inputs.publication_attempt,'publication_attempt')};
  if (source?.channel === 'pr') source.prNumber = positive(inputs.pr_number,'pr_number');
  if (!inputs.parent_suite_id || !inputs.reason?.trim()) throw new Error('Original suite and reason are required');
  return {parent: {suiteId: inputs.parent_suite_id}, selection: memberIds.length ? {memberIds} : {filter:{statuses,...(excluded.length?{excludeMemberIds:excluded}:{})}}, ...(source?{source}:{}), reason: inputs.reason};
}
export async function dispatchRerun({inputs, runId, token, fetchImpl=fetch}) {
  if (!token) throw new Error('Rerun ingest capability is unavailable');
  const rerunId = `manual-rerun-${runId}`;
  const post = async (path, body) => {
    const response = await fetchImpl(`https://core.dev.us-west-2.mentraglass.com/api/internal/test-reruns/${path}`, {method:'POST', headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
    if (!response.ok) throw new Error(`Rerun ${path} returned HTTP ${response.status}; reconcile ${rerunId}`);
    return response.json();
  };
  const preview = await post('preview',{rerunId,...rerunSelection(inputs)});
  const acceptance = await post('submit',{rerunId,previewDigest:preview.previewDigest});
  return {rerunId, preview, acceptance, url:`https://admin.dev.mentraglass.com/?testRerun=${encodeURIComponent(rerunId)}`};
}
