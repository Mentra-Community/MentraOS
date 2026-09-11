import { z } from "zod";
import { apiRequest } from "@/api/http";

export const developerAppSchema = z.object({
  id: z.string(),
  packageName: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(["active", "archived", "suspended"]),
  activeRelease: z
    .object({
      id: z.string(),
      version: z.string(),
      status: z.enum(["draft", "submitted", "in_review", "accepted", "rejected", "published", "suspended"]),
      releaseBundleAssetId: z.string().nullable(),
      bundleSha256: z.string().nullable(),
      bundleSizeBytes: z.number().nullable(),
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
      status: z.enum(["draft", "submitted", "in_review", "accepted", "rejected", "published", "suspended"]),
      releaseBundleAssetId: z.string().nullable(),
      bundleSha256: z.string().nullable(),
      bundleSizeBytes: z.number().nullable(),
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
  status: z.enum(["draft", "submitted", "in_review", "accepted", "rejected", "published", "suspended"]),
  releaseBundleAssetId: z.string().nullable().optional(),
  bundleSha256: z.string().nullable().optional(),
  bundleSizeBytes: z.number().nullable().optional(),
  reviewedBy: z.string().nullable().optional(),
  reviewNotes: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
});

export type DeveloperRelease = z.infer<typeof developerReleaseSchema>;

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
