import {createHash} from "node:crypto"
import {readFileSync, statSync} from "node:fs"

export function mergeReleaseResultRecords({plan, records}) {
  const publications = {}
  const artifacts = []

  for (const record of records) {
    if (record.releaseSetId !== plan.releaseSetId) throw new Error("Publication record belongs to another release set")
    for (const [member, targets] of Object.entries(record.publications || {})) {
      publications[member] ||= {}
      for (const [target, publication] of Object.entries(targets)) {
        if (publications[member][target]) throw new Error(`Duplicate publication record for ${member}:${target}`)
        publications[member][target] = publication
      }
    }
    artifacts.push(...(record.artifacts || []))
  }

  for (const [member, definition] of Object.entries(plan.members)) {
    for (const target of definition.publishTargets) {
      if (!publications[member]?.[target]) throw new Error(`Missing publication result for ${member}:${target}`)
    }
  }

  return {publications, artifacts}
}

export function createEnginePackageArtifact({plan, publications, packageFile, assetBaseUrl}) {
  const enginePublication = publications["@mentra/engine"]?.npm
  if (!enginePublication) throw new Error("Engine package artifact has no matching npm publication")

  const bytes = readFileSync(packageFile)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  if (sha256 !== enginePublication.sha256) throw new Error("Engine release asset differs from the npm package")

  return {
    status: enginePublication.status,
    coordinate: plan.artifactNames.enginePackage,
    url: `${assetBaseUrl}/${plan.artifactNames.enginePackage}`,
    sha256,
    size: statSync(packageFile).size,
    provenanceUrl: enginePublication.provenanceUrl,
  }
}
