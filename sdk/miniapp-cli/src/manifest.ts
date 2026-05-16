// Note: these enum string values must stay in sync with @mentra/types.
// We cannot depend on @mentra/types here because this lightweight CLI package
// is intentionally dependency-minimal (so `bunx @mentra/miniapp-cli` starts
// fast). Mirror string lists manually; failing validations point authors at
// the allowed values directly.
//
// Sources of truth:
//   - AppPermissionType: cloud/packages/types/src/applet.ts
//   - HardwareType:      cloud/packages/types/src/enums.ts
//   - HardwareRequirementLevel: same
//   - AppletPermission shape: {type, required?, description?}
//   - HardwareRequirement shape: {type, level, description?}

export const ALLOWED_PERMISSIONS = [
  'MICROPHONE',
  'CAMERA',
  'CALENDAR',
  'LOCATION',
  'BACKGROUND_LOCATION',
  'READ_NOTIFICATIONS',
  'POST_NOTIFICATIONS',
] as const;

export type AllowedPermission = (typeof ALLOWED_PERMISSIONS)[number];

export const ALLOWED_HARDWARE_TYPES = [
  'CAMERA',
  'DISPLAY',
  'MICROPHONE',
  'SPEAKER',
  'IMU',
  'BUTTON',
  'LIGHT',
  'WIFI',
  // EXIST is injected by the phone at runtime (every miniapp needs glasses
  // present). Do not allow authors to declare it — keep the surface minimal.
] as const;

export type AllowedHardwareType = (typeof ALLOWED_HARDWARE_TYPES)[number];

export const ALLOWED_HARDWARE_LEVELS = ['REQUIRED', 'OPTIONAL'] as const;

export type AllowedHardwareLevel = (typeof ALLOWED_HARDWARE_LEVELS)[number];

export interface ManifestPermission {
  type: AllowedPermission;
  required?: boolean;
  description?: string;
}

export interface ManifestHardwareRequirement {
  type: AllowedHardwareType;
  level: AllowedHardwareLevel;
  description?: string;
}

export interface ManifestEntry {
  /** Path to the background bundle entry, relative to the project root.
   * Required for two-layer bundles. */
  background: string;
  /** Path to the UI HTML entry. Optional — pure-background miniapps
   * don't include a WebView. */
  ui?: string;
}

export interface MiniappManifestV1 {
  packageName: string;
  version: string;
  name: string;
  description?: string;
  icon?: string;
  port?: number;
  permissions?: ManifestPermission[];
  hardwareRequirements: ManifestHardwareRequirement[];
  /** Semver of the @mentra/miniapp SDK ABI this bundle targets. */
  sdkVersion?: string;
  /** Lowest MentraOS Manager host version that can run this bundle. */
  minHostVersion?: string;
  /** Two-layer bundle entry points. */
  entry?: ManifestEntry;
  /** Miniapp shape — defaults to "standard" (background + on-demand UI). */
  type?: "standard" | "background";
}

export function validateManifest(manifest: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof manifest !== 'object' || manifest === null) {
    return { valid: false, errors: ['Manifest must be a JSON object'] };
  }

  const m = manifest as Record<string, unknown>;

  if (typeof m.packageName !== 'string' || !m.packageName) {
    errors.push('packageName must be a non-empty string');
  }

  if (typeof m.version !== 'string' || !m.version) {
    errors.push('version must be a non-empty string');
  }

  if (typeof m.name !== 'string' || !m.name) {
    errors.push('name must be a non-empty string');
  }

  // permissions — optional array of {type, required?, description?}
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) {
      errors.push('permissions must be an array of {type, required?, description?} objects');
    } else {
      m.permissions.forEach((perm, i) => {
        if (typeof perm !== 'object' || perm === null) {
          errors.push(
            `permissions[${i}] must be an object like {"type": "MICROPHONE"}. Got: ${JSON.stringify(perm)}`,
          );
          return;
        }
        const p = perm as Record<string, unknown>;
        if (typeof p.type !== 'string') {
          errors.push(`permissions[${i}].type must be a string`);
          return;
        }
        if (!(ALLOWED_PERMISSIONS as readonly string[]).includes(p.type)) {
          errors.push(
            `permissions[${i}].type: unknown permission "${p.type}". Allowed: ${ALLOWED_PERMISSIONS.join(', ')}`,
          );
        }
        if (p.required !== undefined && typeof p.required !== 'boolean') {
          errors.push(`permissions[${i}].required must be a boolean if set`);
        }
        if (p.description !== undefined && typeof p.description !== 'string') {
          errors.push(`permissions[${i}].description must be a string if set`);
        }
      });
    }
  }

  // hardwareRequirements — REQUIRED, array of {type, level, description?}
  if (m.hardwareRequirements === undefined) {
    errors.push(
      'hardwareRequirements is required. Example: [{"type": "DISPLAY", "level": "REQUIRED"}]. ' +
        `Allowed types: ${ALLOWED_HARDWARE_TYPES.join(', ')}. ` +
        `Levels: ${ALLOWED_HARDWARE_LEVELS.join(', ')}.`,
    );
  } else if (!Array.isArray(m.hardwareRequirements)) {
    errors.push('hardwareRequirements must be an array of {type, level, description?} objects');
  } else {
    m.hardwareRequirements.forEach((req, i) => {
      if (typeof req !== 'object' || req === null) {
        errors.push(
          `hardwareRequirements[${i}] must be an object like {"type": "DISPLAY", "level": "REQUIRED"}. Got: ${JSON.stringify(req)}`,
        );
        return;
      }
      const r = req as Record<string, unknown>;
      if (typeof r.type !== 'string') {
        errors.push(`hardwareRequirements[${i}].type must be a string`);
      } else if (!(ALLOWED_HARDWARE_TYPES as readonly string[]).includes(r.type)) {
        errors.push(
          `hardwareRequirements[${i}].type: unknown hardware "${r.type}". Allowed: ${ALLOWED_HARDWARE_TYPES.join(', ')}`,
        );
      }
      if (typeof r.level !== 'string') {
        errors.push(`hardwareRequirements[${i}].level must be a string`);
      } else if (!(ALLOWED_HARDWARE_LEVELS as readonly string[]).includes(r.level)) {
        errors.push(
          `hardwareRequirements[${i}].level: unknown level "${r.level}". Allowed: ${ALLOWED_HARDWARE_LEVELS.join(', ')}`,
        );
      }
      if (r.description !== undefined && typeof r.description !== 'string') {
        errors.push(`hardwareRequirements[${i}].description must be a string if set`);
      }
    });
  }

  // Optional sdkVersion / minHostVersion (semver-coercible strings).
  // We don't enforce strict semver — many real-world manifests use a
  // shorthand like "0.2" that semver.coerce normalises to "0.2.0". Reject
  // only if the field is present and not a non-empty string.
  if (m.sdkVersion !== undefined && (typeof m.sdkVersion !== 'string' || !m.sdkVersion)) {
    errors.push('sdkVersion must be a non-empty string when set');
  }
  if (m.minHostVersion !== undefined && (typeof m.minHostVersion !== 'string' || !m.minHostVersion)) {
    errors.push('minHostVersion must be a non-empty string when set');
  }

  // Optional entry object. When set, entry.background is required.
  if (m.entry !== undefined) {
    if (typeof m.entry !== 'object' || m.entry === null || Array.isArray(m.entry)) {
      errors.push('entry must be an object like {"background": "dist/background/index.js", "ui": "dist/ui/index.html"}');
    } else {
      const e = m.entry as Record<string, unknown>;
      if (typeof e.background !== 'string' || !e.background) {
        errors.push('entry.background is required and must be a non-empty string path');
      }
      if (e.ui !== undefined && (typeof e.ui !== 'string' || !e.ui)) {
        errors.push('entry.ui must be a non-empty string path when set');
      }
    }
  }

  if (m.type !== undefined) {
    if (m.type !== 'standard' && m.type !== 'background') {
      errors.push('type must be "standard" or "background" when set');
    }
  }

  return { valid: errors.length === 0, errors };
}
