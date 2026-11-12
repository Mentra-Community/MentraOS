import {appendFile, writeFile} from 'node:fs/promises'

const sha = value => /^[a-f0-9]{40}$/.test(value ?? '')
// MentraOS, and the Mentra monorepo that builds it from public/mentraos.
const REPOSITORIES = ['Mentra-Community/MentraOS', 'Mentra-Community/Mentra']
export function explicitRoutinePr(pr, inputs, repository) {
  if (!REPOSITORIES.includes(repository) || !/^[1-9]\d*$/.test(inputs.routine_pr ?? '') ||
      pr.number !== Number(inputs.routine_pr) || pr.state !== 'open' || pr.head?.repo?.full_name !== repository ||
      !sha(inputs.routine_head_sha) || pr.head.sha !== inputs.routine_head_sha ||
      !['dev', 'staging'].includes(inputs.routine_base) || pr.base?.ref !== inputs.routine_base || !sha(pr.merge_commit_sha))
    throw new Error('Explicit routine PR build no longer matches an open trusted PR head/base')
  return {number: pr.number, headSha: pr.head.sha, headRef: pr.head.ref, baseRef: pr.base.ref, mergeSha: pr.merge_commit_sha}
}
/** Resolve trusted metadata before checkout; PR code never receives reporting credentials. */
export async function prepareExplicitRoutinePr({github, context, core, env = process.env}) {
  const {data: pr} = await github.rest.pulls.get({...context.repo, pull_number: Number(env.ROUTINE_PR)})
  const repository = `${context.repo.owner}/${context.repo.repo}`
  const value = explicitRoutinePr(pr, {routine_pr: env.ROUTINE_PR, routine_head_sha: env.ROUTINE_HEAD_SHA,
    routine_base: env.ROUTINE_BASE}, repository)
  core.setOutput('merge_sha', value.mergeSha)
  core.setOutput('number', String(value.number)); core.setOutput('head_sha', value.headSha)
  core.setOutput('head_ref', value.headRef); core.setOutput('base_ref', value.baseRef)
  await writeFile(env.RUNNER_TEMP + '/routine-pr.json', JSON.stringify({pull_request: pr}))
  await appendFile(env.GITHUB_ENV, Object.entries({MENTRA_EXPLICIT_ROUTINE_PR: 'true', PR_NUMBER: value.number,
    PR_HEAD_SHA: value.headSha, MENTRA_PR_BASE_REF: value.baseRef, MENTRA_PR_HEAD_REF: value.headRef,
    MENTRA_PR_BUILD_SHA: value.mergeSha,
    PR_OTA_MANIFEST_URL: `https://artifactscdn.mentraglass.com/${repository}/releases/pr-builds/ota-pr-${value.number}-${value.headSha}.json`})
    .map(([key, item]) => `${key}=${item}\n`).join(''))
}
