import {createHash} from "node:crypto"
import type {PutObjectInput, StorageProvider, StoredObject} from "../storage.service"

function env(...names: string[]): string | undefined {
  for (const name of names) {
    if (process.env[name]) return process.env[name]
  }
  return undefined
}

export class S3StorageProvider implements StorageProvider {
  private readonly client: Bun.S3Client

  constructor(opts: {endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string}) {
    this.client = new Bun.S3Client(opts)
  }

  async putObject(input: PutObjectInput): Promise<StoredObject> {
    const file = this.client.file(input.key)
    await file.write(input.body, {type: input.contentType})
    return {
      key: input.key,
      contentType: input.contentType,
      sizeBytes: input.body.byteLength,
      sha256: createHash("sha256").update(input.body).digest("hex"),
    }
  }

  async getObject(key: string): Promise<Uint8Array> {
    const file = this.client.file(key)
    if (!(await file.exists())) {
      throw new Error(`storage object not found: ${key}`)
    }
    return new Uint8Array(await file.arrayBuffer())
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.delete(key)
  }
}

export function createS3StorageProvider(provider: "r2" | "s3" = "r2"): S3StorageProvider {
  const endpoint = env(
    "CLOUD_STORAGE_S3_ENDPOINT",
    "CLOUD_CORE_STORAGE_S3_ENDPOINT",
    "CLOUD_CORE_R2_ENDPOINT",
    "R2_ENDPOINT",
  )
  const bucket = env("CLOUD_STORAGE_S3_BUCKET", "CLOUD_CORE_STORAGE_S3_BUCKET", "CLOUD_CORE_R2_BUCKET", "R2_BUCKET")
  const accessKeyId = env(
    "CLOUD_STORAGE_S3_ACCESS_KEY_ID",
    "CLOUD_CORE_STORAGE_S3_ACCESS_KEY_ID",
    "CLOUD_CORE_R2_ACCESS_KEY_ID",
    "R2_ACCESS_KEY_ID",
  )
  const secretAccessKey = env(
    "CLOUD_STORAGE_S3_SECRET_ACCESS_KEY",
    "CLOUD_CORE_STORAGE_S3_SECRET_ACCESS_KEY",
    "CLOUD_CORE_R2_SECRET_ACCESS_KEY",
    "R2_SECRET_ACCESS_KEY",
  )
  // R2 accepts the sentinel "auto" region, but real AWS S3 requires a valid
  // region name, so fall back to a standard AWS region when one is not set.
  // For provider "s3" the R2-only region vars are intentionally ignored: an
  // R2_REGION=auto would otherwise sign AWS requests with an invalid region.
  const defaultRegion = provider === "s3" ? "us-east-1" : "auto"
  const resolvedRegion =
    (provider === "s3"
      ? env("CLOUD_STORAGE_S3_REGION", "CLOUD_CORE_STORAGE_S3_REGION")
      : env("CLOUD_STORAGE_S3_REGION", "CLOUD_CORE_STORAGE_S3_REGION", "CLOUD_CORE_R2_REGION", "R2_REGION")) ??
    defaultRegion
  // "auto" is an R2-only sentinel and is invalid for real AWS S3 signing; never
  // let it through for provider "s3", even if it was set explicitly in a generic
  // S3 region var.
  const region = provider === "s3" && resolvedRegion === "auto" ? "us-east-1" : resolvedRegion

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "CLOUD_STORAGE_PROVIDER=r2/s3 requires CLOUD_STORAGE_S3_ENDPOINT, " +
        "CLOUD_STORAGE_S3_BUCKET, CLOUD_STORAGE_S3_ACCESS_KEY_ID, " +
        "and CLOUD_STORAGE_S3_SECRET_ACCESS_KEY (CLOUD_CORE_STORAGE_*, CLOUD_CORE_R2_* and R2_* fallbacks accepted).",
    )
  }

  return new S3StorageProvider({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region,
  })
}
