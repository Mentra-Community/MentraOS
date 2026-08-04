import crypto from "node:crypto";
import { DeveloperSigningKeyModel } from "../../models/developer-signing-key.model";
import { MiniAppModel } from "../../models/miniapp.model";
import type { DeveloperIdentity } from "./miniapp.service";

export type DeveloperJwk = Record<string, unknown> & {
  kty?: string;
  crv?: string;
  x?: string;
  d?: string;
};

export interface RegisterDeveloperSigningKeyInput {
  publicKeyJwk: DeveloperJwk;
}

export interface BundleSignaturePayload {
  packageName: string;
  version: string;
  bundleSha256: string;
  manifestSha256: string;
  createdAt: string;
}

export interface SignedBundleMetadata {
  payload: BundleSignaturePayload;
  signingKeyId: string;
  signature: string;
}

export interface DevMiniappAttestation {
  packageName: string;
  devServerUrl: string;
  nonce: string;
  expiresAt: string;
  signingKeyId: string;
  signature: string;
}

export class DeveloperSigningService {
  async listKeys(developer: DeveloperIdentity) {
    const keys = await DeveloperSigningKeyModel.find({ orgId: developer.orgId })
      .sort({ createdAt: -1 })
      .lean();
    return keys.map(serializeSigningKey);
  }

  async registerKey(developer: DeveloperIdentity, input: RegisterDeveloperSigningKeyInput) {
    assertPublicEd25519Jwk(input.publicKeyJwk);
    const created = await DeveloperSigningKeyModel.create({
      orgId: developer.orgId,
      workosUserId: developer.developerId,
      publicKeyJwk: input.publicKeyJwk,
      status: "active",
    });
    return serializeSigningKey(created.toObject());
  }

  async verifyBundleSignature(developer: DeveloperIdentity, metadata: SignedBundleMetadata): Promise<void> {
    if (!metadata.payload || typeof metadata.payload !== "object") {
      throw new DeveloperSigningServiceError("invalid_signature_payload", "release signature payload is required", 400);
    }
    if (metadata.payload.packageName !== metadata.payload.packageName.trim().toLowerCase()) {
      throw new DeveloperSigningServiceError("invalid_package_name", "signed packageName must be normalized", 400);
    }
    assertPackagePrefix(developer.packagePrefix, metadata.payload.packageName);
    const key = await this.requireActiveKey(metadata.signingKeyId);
    if (key.orgId !== developer.orgId) {
      throw new DeveloperSigningServiceError("signing_key_forbidden", "signing key does not belong to this developer org", 403);
    }
    verifySignature(key.publicKeyJwk as DeveloperJwk, metadata.payload, metadata.signature);
    await DeveloperSigningKeyModel.updateOne({ _id: metadata.signingKeyId }, { $set: { lastUsedAt: new Date() } });
  }

  async verifyDevAttestation(packageName: string, attestation: DevMiniappAttestation): Promise<void> {
    const normalizedPackage = normalizePackageName(packageName);
    if (attestation.packageName !== normalizedPackage) {
      throw new DeveloperSigningServiceError("invalid_dev_attestation", "attestation packageName does not match request", 403);
    }
    if (!attestation.devServerUrl || !attestation.nonce) {
      throw new DeveloperSigningServiceError("invalid_dev_attestation", "attestation is missing required fields", 400);
    }
    const expiresAt = Date.parse(attestation.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new DeveloperSigningServiceError("dev_attestation_expired", "dev attestation expired", 403);
    }
    const key = await this.requireActiveKey(attestation.signingKeyId);
    const app = await MiniAppModel.findOne({ packageName: normalizedPackage, status: { $ne: "archived" } }).lean();
    if (!app || app.orgId !== key.orgId) {
      throw new DeveloperSigningServiceError(
        "dev_attestation_forbidden",
        "signing key is not allowed to develop this package",
        403,
      );
    }
    verifySignature(key.publicKeyJwk as DeveloperJwk, attestationPayload(attestation), attestation.signature);
    await DeveloperSigningKeyModel.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } });
  }

  private async requireActiveKey(signingKeyId: string) {
    if (!signingKeyId) {
      throw new DeveloperSigningServiceError("signing_key_required", "signingKeyId is required", 400);
    }
    const key = await DeveloperSigningKeyModel.findById(signingKeyId).lean();
    if (!key || key.status !== "active") {
      throw new DeveloperSigningServiceError("signing_key_not_found", "active signing key was not found", 404);
    }
    return key;
  }
}

export class DeveloperSigningServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DeveloperSigningServiceError";
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function verifySignature(publicKeyJwk: DeveloperJwk, payload: unknown, signature: string): void {
  try {
    const publicKey = crypto.createPublicKey({ key: publicKeyJwk, format: "jwk" } as unknown as crypto.PublicKeyInput);
    const ok = crypto.verify(null, Buffer.from(canonicalJson(payload)), publicKey, Buffer.from(signature, "base64url"));
    if (!ok) throw new Error("signature mismatch");
  } catch {
    throw new DeveloperSigningServiceError("invalid_signature", "signature could not be verified", 403);
  }
}

function attestationPayload(attestation: DevMiniappAttestation) {
  return {
    packageName: attestation.packageName,
    devServerUrl: attestation.devServerUrl,
    nonce: attestation.nonce,
    expiresAt: attestation.expiresAt,
    signingKeyId: attestation.signingKeyId,
  };
}

function assertPublicEd25519Jwk(jwk: DeveloperJwk): void {
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new DeveloperSigningServiceError("invalid_public_key", "publicKeyJwk must be an Ed25519 public JWK", 400);
  }
}

function normalizePackageName(packageName: string): string {
  const normalized = packageName.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(normalized)) {
    throw new DeveloperSigningServiceError(
      "invalid_package_name",
      "package name must be lowercase reverse-DNS text",
      400,
    );
  }
  return normalized;
}

function assertPackagePrefix(prefix: string, packageName: string): void {
  const normalizedPrefix = prefix.replace(/\.+$/, "").toLowerCase();
  if (!packageName.startsWith(`${normalizedPrefix}.`)) {
    throw new DeveloperSigningServiceError(
      "invalid_package_prefix",
      `package name must start with ${normalizedPrefix}. for this developer org`,
      400,
    );
  }
}

function serializeSigningKey(key: {
  _id: unknown;
  orgId: string;
  workosUserId: string;
  publicKeyJwk: unknown;
  status: string;
  lastUsedAt?: Date | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}) {
  return {
    id: String(key._id),
    orgId: key.orgId,
    workosUserId: key.workosUserId,
    publicKeyJwk: key.publicKeyJwk,
    status: key.status,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    createdAt: key.createdAt?.toISOString() ?? null,
    updatedAt: key.updatedAt?.toISOString() ?? null,
  };
}
