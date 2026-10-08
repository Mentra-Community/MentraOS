import {ensure, platforms, routineApi, selectedCatalog} from './routine-api.mjs'

/** Known exact source describes applicability; routine names and label prefixes do not. */
export async function selectedRoutinePlatforms({token, routineIds, revision, fetchImpl = fetch}) {
  const catalog = await routineApi({token, operation: 'catalog', routineIds, revision, fetchImpl})
  ensure(revision === undefined || catalog.routineRevision === revision, 'Core changed the exact selected routine revision')
  const rows = selectedCatalog(catalog)
  ensure(rows.length === routineIds.length && rows.every(row => routineIds.includes(row.routineId)),
    'Core selected routine catalog differs from the requested identities')
  return rows.map(row => {
    const supported = catalog.routines.find(value => value.routineId === row.routineId).platforms
    if (supported === undefined) return row
    ensure(Array.isArray(supported) && supported.length > 0 && supported.length <= platforms.length &&
      supported.every(value => platforms.includes(value)) && new Set(supported).size === supported.length,
    'Exact routine platform description is unavailable')
    return {...row, platforms: supported}
  })
}

/** A public disposition contains identity/source only, never private definition data or a passing claim. */
export async function reportUnsupportedRoutinePlatforms({github, context, pr, rows}) {
  if (!rows.length) return
  const {data: current} = await github.rest.pulls.get({...context.repo, pull_number: pr.number})
  if (current.head?.sha !== pr.head.sha || current.state !== 'open') return
  const identities = rows.map(row => `${row.routineId}/${row.platform}@${row.routineRevision}`).sort()
  const marker = `<!-- routine-platforms:${pr.head.sha}:${identities.join(',')} -->`
  const comments = await github.paginate(github.rest.issues.listComments, {...context.repo, issue_number: pr.number, per_page: 100})
  ensure(comments.length < 1000, 'Routine applicability comment history exceeds its bound')
  if (comments.some(comment => comment.user?.type === 'Bot' && comment.user.login === 'github-actions[bot]' &&
    comment.body?.startsWith(`${marker}\n`))) return
  await github.rest.issues.createComment({...context.repo, issue_number: pr.number, body: [marker,
    'These routine label/platform combinations were not queued because their exact routine source does not support the app publication platform:', '',
    ...rows.map(row => `- \`${row.routineId}\` on \`${row.platform}\` at Harness \`${row.routineRevision}\` (supported: ${row.platforms.map(value => `\`${value}\``).join(', ')}).`), '',
    'Compatible label/platform combinations are handled independently. This disposition is not a device test result.'].join('\n')})
}
