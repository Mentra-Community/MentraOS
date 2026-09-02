import semver from "semver"
import {z} from "zod"

const nullableUrl = z.string().url().nullable()
const packageName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/)
const semanticVersion = z.string().refine((value) => semver.valid(value) !== null)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/i)

const authSchema = z.discriminatedUnion("mode", [
  z.object({mode: z.literal("mentra-account")}).strict(),
  z
    .object({
      mode: z.literal("microsoft-entra"),
      authorityUrl: z.string().url(),
      clientId: z.string().uuid(),
      runtimeScopes: z.array(z.string().min(1)).min(1),
      teamsScopes: z.array(z.string().min(1)),
    })
    .strict(),
])

export const deploymentManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    deploymentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    displayName: z.string().min(1).max(120),
    branding: z
      .object({logoUrls: z.object({light: z.string().url(), dark: z.string().url()}).strict()})
      .strict()
      .optional(),
    services: z
      .object({
        coreUrl: nullableUrl,
        runtimeUrl: nullableUrl,
      })
      .strict(),
    auth: authSchema,
    artifacts: z
      .object({
        mentraLiveOtaManifestUrl: nullableUrl,
        sttModelBaseUrl: nullableUrl,
        ttsModelBaseUrl: nullableUrl,
      })
      .strict(),
    appUpdates: z
      .object({
        mode: z.enum(["store", "managed"]),
        storeUrls: z.object({android: nullableUrl, ios: nullableUrl}).strict(),
        reviewUrls: z.object({android: nullableUrl, ios: nullableUrl}).strict(),
      })
      .strict(),
    content: z.object({wallpaperUrls: z.array(z.string().url()).max(100)}).strict(),
    links: z
      .object({
        privacyPolicyUrl: z.string().url(),
        termsOfServiceUrl: z.string().url(),
        documentationUrl: nullableUrl,
        supportUrl: nullableUrl,
      })
      .strict(),
    systemMiniapps: z.object({approvedPackageNamesOverride: z.array(packageName).max(100).nullable()}).strict(),
    miniapps: z
      .object({
        managed: z
          .array(
            z
              .object({
                packageName,
                version: semanticVersion,
                bundleUrl: z.string().url(),
                sha256,
              })
              .strict(),
          )
          .max(100),
      })
      .strict()
      .default({managed: []}),
    glasses: z.object({allowedModelsOverride: z.array(z.string().min(1).max(120)).max(100).nullable()}).strict(),
    features: z
      .object({
        runtimeRealtimeSession: z.boolean(),
        managedStreams: z.boolean(),
        nativeMeetings: z.boolean(),
        cloudSpeech: z.boolean(),
        onDeviceSpeech: z.boolean(),
        navigation: z.boolean(),
      })
      .strict(),
    telemetry: z.boolean(),
  })
  .strict()
