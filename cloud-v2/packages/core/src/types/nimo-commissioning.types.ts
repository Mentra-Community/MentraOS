import {z} from 'zod'
import {createHash} from 'node:crypto'
import {testBuildSourceSchema} from './test-build.types'
import {frameworkBindingSchema} from './framework-version.types'
// Exact finite Mac selection, matching the harness. No firmware is admissible for NIMO.
const pin=z.object({url:z.string().url(),sha256:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().positive().safe()}).strict()
const macPackageSelectionSchema=z.object({kind:z.literal('mac-ci-package'),repository:z.literal('Mentra-Community/MentraOS'),headSha:z.string().regex(/^[a-f0-9]{40}$/),
 channel:z.enum(['dev','staging','pr']),prNumber:z.number().int().positive().optional(),releaseIdentity:z.string().regex(/^\d+\.\d+\.\d+-(dev|beta)\.[1-9]\d*$/).optional(),
 source:testBuildSourceSchema,archive:pin.extend({name:z.string().regex(/^[A-Za-z0-9._-]+\.zip$/)}),receipt:pin}).strict().refine(value=>value.source.channel===value.channel&&(value.channel==='pr'
 ?value.prNumber!==undefined&&value.source.channel==='pr'&&value.source.prNumber===value.prNumber&&value.releaseIdentity===undefined
 :value.prNumber===undefined&&value.releaseIdentity!==undefined),'Mac selection source/channel differs')
function ordered(value:unknown):unknown{if(Array.isArray(value))return value.map(ordered);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,child])=>[key,ordered(child)]));return value}
function inputDigest(value:unknown){return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')}


const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/)
const digest=z.string().regex(/^[a-f0-9]{64}$/)
const revision=z.string().regex(/^[a-f0-9]{40}$/)
const address=z.string().regex(/^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/)
export const nimoCommissioningPairSchema=z.object({name:z.string().regex(/^Nimo-[A-Za-z0-9]+$/i),bluetooth:address}).strict()
export const nimoCommissioningReturnControllerSchema=z.object({phoneResourceId:id,serial:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)}).strict()
export const nimoCommissioningQualificationSchema=z.object({configurationSha256:digest,sourceSha256:digest,evidenceSha256:digest,ownerId:id}).strict()
/** Eligibility references an existing resource. It is neither an offered membership nor qualification. */
export const nimoCommissioningReferenceSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('nimo-mac-commissioning-v1'),
  id,resourceId:id,pair:nimoCommissioningPairSchema,targetLaneId:id,returnLaneId:id,
  requiredCapabilities:z.object({macSession:z.literal('nimo-macos-resource-v1'),androidReturn:z.literal('original-app-absent-v1')}).strict(),
  returnController:nimoCommissioningReturnControllerSchema,returnQualification:nimoCommissioningQualificationSchema,
}).strict().refine(value=>value.targetLaneId!==value.returnLaneId,'Commissioning target and original return lane must differ')
export type NimoCommissioningReference=z.infer<typeof nimoCommissioningReferenceSchema>

export const nimoCommissioningAuthoritySchema=z.object({references:z.array(nimoCommissioningReferenceSchema).min(1).max(1),
  framework:frameworkBindingSchema,sourceManifestSha256:digest,machineProfileSha256:digest}).strict()
export type NimoCommissioningAuthority=z.infer<typeof nimoCommissioningAuthoritySchema>

/** Accepted once by the parent authority; caller timestamps and pins are not proof of acceptance. */
export const nimoCommissioningPlanSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('nimo-mac-commissioning-v1'),planId:id,
  reference:nimoCommissioningReferenceSchema,referenceSha256:digest,hostId:id,
  source:z.object({revision,manifestSha256:digest}).strict(),framework:frameworkBindingSchema,machineProfileSha256:digest,
  mac:z.union([
    z.object({laneId:id,controllerAddress:address,peripheralUuid:z.string().uuid(),build:macPackageSelectionSchema}).strict(),
    z.object({laneId:id,controllerAddress:address,peripheralSelection:z.literal('connected-service-exact-name-v1'),build:macPackageSelectionSchema}).strict(),
  ]),
  window:z.object({admittedAt:z.number().int().nonnegative().safe(),deadlineAt:z.number().int().positive().safe()}).strict(),
  maximumAttempts:z.literal(1),
}).strict().superRefine((value,context)=>{
  const fail=(message:string)=>context.addIssue({code:'custom',message})
  if(inputDigest(value.reference)!==value.referenceSha256)fail('Commissioning reference digest differs')
  if(value.mac.laneId!==value.reference.targetLaneId)fail('Commissioning plan target differs from its reference')
  if(value.source.revision!==value.framework.revision)fail('Commissioning source differs from its accepted framework')
  if(value.window.deadlineAt<=value.window.admittedAt||value.window.deadlineAt-value.window.admittedAt>3600000)
    fail('Commissioning requires a finite window of at most one hour')
})
export type NimoCommissioningPlan=z.infer<typeof nimoCommissioningPlanSchema>

