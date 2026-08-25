import { z } from "zod";
import { apiRequest } from "@/api/http";

export const storeAssetSchema = z.object({
  id: z.string(),
  role: z.enum(["store_icon", "store_cover", "gallery_screenshot"]),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  sha256: z.string(),
  sortOrder: z.number().nullable(),
  createdAt: z.string().nullable(),
});

export const storeListingSchema = z.object({
  subtitle: z.string().nullable(),
  longDescription: z.string().nullable(),
  categories: z.array(z.string()),
  privacyPolicyUrl: z.string().nullable(),
  supportUrl: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  reviewTier: z.enum(["community", "verified"]),
  featured: z.boolean(),
  iconAssetId: z.string().nullable(),
  coverAssetId: z.string().nullable(),
  screenshotAssetIds: z.array(z.string()),
});

export const developerAppSchema = z.object({
  id: z.string(),
  packageName: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  storeListing: storeListingSchema,
  status: z.enum(["active", "archived", "suspended"]),
  activeRelease: z
    .object({
      id: z.string(),
      version: z.string(),
      releaseTrack: z.enum(["stable", "beta"]),
      status: z.enum(["draft", "submitted", "in_review", "accepted", "rejected", "published", "suspended"]),
      releaseBundleAssetId: z.string().nullable(),
      bundleSha256: z.string().nullable(),
      bundleSizeBytes: z.number().nullable(),
      manifestSha256: z.string().nullable().optional(),
      manifest: z.record(z.string(), z.unknown()).nullable().optional(),
      signingKeyId: z.string().nullable().optional(),
      signedAt: z.string().nullable().optional(),
      reviewedBy: z.string().nullable().optional(),
      reviewNotes: z.string().nullable().optional(),
      createdAt: z.string().nullable(),
      updatedAt: z.string().nullable(),
    })
    .nullable(),
  activeBetaRelease: z
    .object({
      id: z.string(),
      version: z.string(),
      releaseTrack: z.enum(["stable", "beta"]),
      status: z.enum(["draft", "submitted", "in_review", "accepted", "rejected", "published", "suspended"]),
      releaseBundleAssetId: z.string().nullable(),
      bundleSha256: z.string().nullable(),
      bundleSizeBytes: z.number().nullable(),
      manifestSha256: z.string().nullable().optional(),
      manifest: z.record(z.string(), z.unknown()).nullable().optional(),
      signingKeyId: z.string().nullable().optional(),
      signedAt: z.string().nullable().optional(),
      reviewedBy: z.string().nullable().optional(),
      reviewNotes: z.string().nullable().optional(),
      createdAt: z.string().nullable(),
      updatedAt: z.string().nullable(),
    })
    .nullable(),
  latestRelease: z
    .object({
      id: z.string(),
      version: z.string(),
      releaseTrack: z.enum(["stable", "beta"]),
      status: z.enum(["draft", "submitted", "in_review", "accepted", "rejected", "published", "suspended"]),
      releaseBundleAssetId: z.string().nullable(),
      bundleSha256: z.string().nullable(),
      bundleSizeBytes: z.number().nullable(),
      manifestSha256: z.string().nullable().optional(),
      manifest: z.record(z.string(), z.unknown()).nullable().optional(),
      signingKeyId: z.string().nullable().optional(),
      signedAt: z.string().nullable().optional(),
      reviewedBy: z.string().nullable().optional(),
      reviewNotes: z.string().nullable().optional(),
      createdAt: z.string().nullable(),
      updatedAt: z.string().nullable(),
    })
    .nullable(),
  releaseCount: z.number(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const developerAppsResponseSchema = z.object({
  apps: z.array(developerAppSchema),
});

export type DeveloperApp = z.infer<typeof developerAppSchema>;

export const developerReleaseSchema = z.object({
  id: z.string(),
  version: z.string(),
  releaseTrack: z.enum(["stable", "beta"]),
  status: z.enum(["draft", "submitted", "in_review", "accepted", "rejected", "published", "suspended"]),
  releaseBundleAssetId: z.string().nullable().optional(),
  bundleSha256: z.string().nullable().optional(),
  bundleSizeBytes: z.number().nullable().optional(),
  manifestSha256: z.string().nullable().optional(),
  manifest: z.record(z.string(), z.unknown()).nullable().optional(),
  signingKeyId: z.string().nullable().optional(),
  signedAt: z.string().nullable().optional(),
  reviewedBy: z.string().nullable().optional(),
  reviewNotes: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
});

export type DeveloperRelease = z.infer<typeof developerReleaseSchema>;
export type StoreAsset = z.infer<typeof storeAssetSchema>;
export type StoreListing = z.infer<typeof storeListingSchema> & { assets: StoreAsset[] };

export function listDeveloperApps(): Promise<{ apps: DeveloperApp[] }> {
  return apiRequest("/console/apps", developerAppsResponseSchema);
}

export function listDeveloperReleases(packageName: string): Promise<{ releases: DeveloperRelease[] }> {
  return apiRequest(
    `/console/apps/${encodeURIComponent(packageName)}/releases`,
    z.object({ releases: z.array(developerReleaseSchema) }),
  );
}

export function createDeveloperApp(input: {
  packageName: string;
  displayName: string;
  description?: string | null;
}): Promise<{ app: DeveloperApp }> {
  return apiRequest("/console/apps", z.object({ app: developerAppSchema }), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function submitDeveloperRelease(input: {
  packageName: string;
  releaseId: string;
}): Promise<{ release: NonNullable<DeveloperApp["latestRelease"]> }> {
  return apiRequest(
    `/console/apps/${encodeURIComponent(input.packageName)}/releases/${encodeURIComponent(input.releaseId)}/submit`,
    z.object({ release: developerAppSchema.shape.latestRelease.unwrap() }),
    { method: "POST" },
  );
}

export function getStoreListing(packageName: string): Promise<{ listing: StoreListing }> {
  return apiRequest(
    `/console/apps/${encodeURIComponent(packageName)}/listing`,
    z.object({ listing: storeListingSchema.extend({ assets: z.array(storeAssetSchema) }) }),
  );
}

export function updateStoreListing(
  packageName: string,
  input: {
    subtitle: string | null;
    longDescription: string | null;
    categories: string[];
    privacyPolicyUrl: string | null;
    supportUrl: string | null;
    websiteUrl: string | null;
  },
): Promise<{ listing: StoreListing }> {
  return apiRequest(
    `/console/apps/${encodeURIComponent(packageName)}/listing`,
    z.object({ listing: storeListingSchema.extend({ assets: z.array(storeAssetSchema) }) }),
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
  );
}

export function uploadStoreAsset(
  packageName: string,
  input: {
    role: "store_icon" | "store_cover" | "gallery_screenshot";
    file: File;
  },
): Promise<{ asset: StoreAsset }> {
  return fileToBase64(input.file).then(base64 =>
    apiRequest(
      `/console/apps/${encodeURIComponent(packageName)}/listing/assets`,
      z.object({ asset: storeAssetSchema }),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: input.role,
          fileName: input.file.name,
          contentType: input.file.type,
          base64,
        }),
      },
    ),
  );
}

export function deleteStoreAsset(packageName: string, assetId: string): Promise<{ ok: boolean }> {
  return apiRequest(
    `/console/apps/${encodeURIComponent(packageName)}/listing/assets/${encodeURIComponent(assetId)}`,
    z.object({ ok: z.boolean() }),
    { method: "DELETE" },
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read asset"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}
