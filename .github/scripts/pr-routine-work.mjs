import {ensure, requestIdentity} from './routine-api.mjs'

/** A trusted manual wake uses Core's durable reporter; Actions never owns a competing PR comment. */
export async function publishPrRoutineWorkReport({token, workId, fetchImpl = fetch}) {
  ensure(
    typeof token === 'string' && token && requestIdentity(workId),
    'Authoring report requires its capability and identity',
  )
  const response = await fetchImpl(
    `https://core.dev.us-west-2.mentraglass.com/api/internal/routine-work/${encodeURIComponent(workId)}/report`,
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {Authorization: `Bearer ${token}`},
    },
  )
  ensure(
    response.ok,
    `Authoring report delivery is unavailable (${response.status}); Core retains the same reporting intent`,
  )
  const receipt = await response.json()
  ensure(receipt?.workId === workId && receipt.retained === true, 'Authoring report receipt changed its work identity')
  return receipt
}
