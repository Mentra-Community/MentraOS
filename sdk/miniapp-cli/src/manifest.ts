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

// Action parameter types — the MCP-compatible subset. "number" (not
// "integer") since the runtime is JavaScript; arrays of primitives allowed.
export const ALLOWED_ACTION_PARAM_TYPES = ['string', 'number', 'boolean', 'array'] as const;
export type AllowedActionParamType = (typeof ALLOWED_ACTION_PARAM_TYPES)[number];

export interface ManifestActionParameter {
  type: AllowedActionParamType;
  description?: string;
  enum?: Array<string | number | boolean>;
  /** For type: "array" — the primitive item type. */
  items?: { type: 'string' | 'number' | 'boolean' };
}

/** JSON-Schema input descriptor for an action. Maps to an MCP tool inputSchema. */
export interface ManifestActionParameters {
  type: 'object';
  properties?: Record<string, ManifestActionParameter>;
  required?: string[];
}

/**
 * A declared action this miniapp exposes for other (system) miniapps to invoke
 * via session.actions. Shape maps 1:1 onto an MCP tool.
 */
export interface ManifestAction {
  /** Unique-within-app id, ^[a-z][a-z0-9_]*$, ≤64 chars. */
  id: string;
  /** AI-facing contract — when to use the action. Required, non-empty. */
  description: string;
  parameters?: ManifestActionParameters;
  /** JSON-Schema descriptor for the structured value returned by the handler. */
  outputSchema?: Record<string, unknown>;
  /**
   * Runtime lifecycle after a headless invocation. `persistent` starts normal,
   * user-visible miniapp activity; `transient` keeps the wake invisible and
   * tears it down after the invocation settles. Defaults to `persistent`.
   */
  lifecycle?: 'persistent' | 'transient';
  /** Restrict an internal action to direct host invocation. Defaults to `system`. */
  audience?: 'system' | 'host';
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
  /** Actions other (system) miniapps can invoke via session.actions. */
  actions?: ManifestAction[];
}

const ACTION_ID_RE = /^[a-z][a-z0-9_]*$/;

function validateActionParameters(parameters: unknown, actionIndex: number, errors: string[]): void {
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
    errors.push(`actions[${actionIndex}].parameters must be a JSON-Schema object with "type": "object"`);
    return;
  }
  const p = parameters as Record<string, unknown>;
  if (p.type !== 'object') {
    errors.push(`actions[${actionIndex}].parameters.type must be "object"`);
  }
  if (p.properties !== undefined) {
    if (typeof p.properties !== 'object' || p.properties === null || Array.isArray(p.properties)) {
      errors.push(`actions[${actionIndex}].parameters.properties must be an object`);
    } else {
      for (const [key, prop] of Object.entries(p.properties as Record<string, unknown>)) {
        if (typeof prop !== 'object' || prop === null) {
          errors.push(`actions[${actionIndex}].parameters.properties.${key} must be an object`);
          continue;
        }
        const pr = prop as Record<string, unknown>;
        if (typeof pr.type !== 'string' || !(ALLOWED_ACTION_PARAM_TYPES as readonly string[]).includes(pr.type)) {
          errors.push(
            `actions[${actionIndex}].parameters.properties.${key}.type must be one of: ${ALLOWED_ACTION_PARAM_TYPES.join(', ')} (use "number", not "integer")`,
          );
        }
        if (pr.type === 'array') {
          const items = pr.items as Record<string, unknown> | undefined;
          const itemType = items?.type;
          if (typeof itemType !== 'string' || !['string', 'number', 'boolean'].includes(itemType)) {
            errors.push(
              `actions[${actionIndex}].parameters.properties.${key}.items.type must be "string" | "number" | "boolean" for an array param`,
            );
          }
        }
        if (pr.description !== undefined && typeof pr.description !== 'string') {
          errors.push(`actions[${actionIndex}].parameters.properties.${key}.description must be a string if set`);
        }
        if (pr.enum !== undefined && !Array.isArray(pr.enum)) {
          errors.push(`actions[${actionIndex}].parameters.properties.${key}.enum must be an array if set`);
        }
      }
    }
  }
  if (p.required !== undefined && (!Array.isArray(p.required) || !p.required.every((x) => typeof x === 'string'))) {
    errors.push(`actions[${actionIndex}].parameters.required must be an array of strings if set`);
  }
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
      errors.push('entry must be an object like {"background": "background/index.js", "ui": "ui/index.html"}');
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

  // actions — optional array of {id, description, parameters?}. The MCP-shaped
  // capability surface other (system) miniapps invoke via session.actions.
  if (m.actions !== undefined) {
    if (!Array.isArray(m.actions)) {
      errors.push('actions must be an array of {id, description, parameters?} objects');
    } else {
      const seenIds = new Set<string>();
      m.actions.forEach((action, i) => {
        if (typeof action !== 'object' || action === null) {
          errors.push(`actions[${i}] must be an object like {"id": "add_todo", "description": "..."}`);
          return;
        }
        const a = action as Record<string, unknown>;
        if (typeof a.id !== 'string' || !ACTION_ID_RE.test(a.id)) {
          errors.push(
            `actions[${i}].id must match ^[a-z][a-z0-9_]*$ (lowercase, start with a letter). Got: ${JSON.stringify(a.id)}`,
          );
        } else if (a.id.length > 64) {
          errors.push(`actions[${i}].id must be 64 characters or fewer`);
        } else if (seenIds.has(a.id)) {
          errors.push(`actions[${i}].id "${a.id}" is duplicated — action ids must be unique within a miniapp`);
        } else {
          seenIds.add(a.id);
        }
        if (typeof a.description !== 'string' || !a.description.trim()) {
          errors.push(
            `actions[${i}].description is required and must be a non-empty string (it's the AI-facing contract — say when to use the action)`,
          );
        }
        if (a.parameters !== undefined) {
          validateActionParameters(a.parameters, i, errors);
        }
        if (
          a.outputSchema !== undefined &&
          (typeof a.outputSchema !== 'object' || a.outputSchema === null || Array.isArray(a.outputSchema))
        ) {
          errors.push(`actions[${i}].outputSchema must be a JSON-Schema object when set`);
        }
        if (a.lifecycle !== undefined && a.lifecycle !== 'persistent' && a.lifecycle !== 'transient') {
          errors.push(`actions[${i}].lifecycle must be "persistent" or "transient" when set`);
        }
        if (a.audience !== undefined && a.audience !== 'system' && a.audience !== 'host') {
          errors.push(`actions[${i}].audience must be "system" or "host" when set`);
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
