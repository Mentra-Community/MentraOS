import reference from "../../../../cloud-v2/deploy/azure/enterprise-reference/mentra-deployment.json"
import {createWorkspaceManifestAliases} from "../../../../cloud-v2/packages/runtime/src/services/deployment-workspace-aliases"
import {resolveDeploymentCandidate} from "./resolver"

function response(body: string, url: string): Response {
  const bytes = new TextEncoder().encode(body)
  let consumed = false
  return {
    ok: true, status: 200, url, headers: new Headers(),
    body: {getReader: () => ({
      read: async () => {
        if (consumed) return {done: true, value: undefined}
        consumed = true
        return {done: false, value: bytes}
      },
      cancel: async () => undefined,
    })},
  } as Response
}

it("allows fresh enrollment and reselection through both configured workspace addresses", async () => {
  const canonical = reference.services.runtimeUrl
  const legacy = "https://legacy.enterprise.example"
  const body = JSON.stringify(reference)
  const aliases = createWorkspaceManifestAliases(body, [legacy])
  const fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    return response(aliases.get(new URL(url).host) ?? body, url)
  })
  for (const origin of [canonical, legacy, canonical, legacy]) {
    const candidate = await resolveDeploymentCandidate(origin, {fetch})
    expect(candidate.workspaceOrigin).toBe(origin)
    expect(candidate.manifest.services.runtimeUrl).toBe(origin)
    expect(candidate.manifest.miniapps.managed[0].bundleUrl).toBe(
      origin + new URL(reference.miniapps.managed[0].bundleUrl).pathname,
    )
    expect(candidate.manifest.services.coreUrl).toBe(reference.services.coreUrl)
    expect(candidate.manifest.deploymentId).toBe(reference.deploymentId)
    expect(candidate.manifest.auth).toEqual(reference.auth)
  }
  expect(fetch).toHaveBeenCalledTimes(4)
  // Keep the shipped arbitrary-origin restriction; the server fixes its response.
  await expect(resolveDeploymentCandidate(legacy, {
    fetch: async () => response(body, `${legacy}/.well-known/mentra-deployment.json`),
  })).rejects.toMatchObject({code: "origin-mismatch"})
})
