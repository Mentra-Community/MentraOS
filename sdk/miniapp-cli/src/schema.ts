// JSON Schema generator for miniapp.json.
//
// The schema is built from the same constants the validator uses (ALLOWED_PERMISSIONS,
// ALLOWED_HARDWARE_TYPES, ALLOWED_HARDWARE_LEVELS) so the two never drift.
//
// Surface:
//   - generateSchema(): returns the JSON Schema object
//   - mentra-miniapp schema print : prints the schema to stdout
//
// Authors point their IDE at the schema via $schema in miniapp.json:
//   "$schema": "./node_modules/@mentra/miniapp-cli/schema/miniapp.schema.json"
//
// The scaffolder injects this $schema line so new projects get autocomplete on
// day one without anyone having to know it exists.

import {writeFileSync, mkdirSync} from 'fs';
import {dirname, resolve} from 'path';
import {fileURLToPath} from 'url';
import {
  ALLOWED_PERMISSIONS,
  ALLOWED_HARDWARE_TYPES,
  ALLOWED_HARDWARE_LEVELS,
  ALLOWED_ACTION_PARAM_TYPES,
} from './manifest.js';

const SCHEMA_ID = 'https://schemas.mentra.glass/miniapp/v1.json';

export function generateSchema(): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: SCHEMA_ID,
    title: 'MentraOS miniapp manifest',
    description: 'Manifest schema for a Mentra miniapp (miniapp.json)',
    type: 'object',
    required: ['packageName', 'version', 'name', 'hardwareRequirements'],
    additionalProperties: true,
    properties: {
      $schema: {type: 'string'},
      packageName: {
        type: 'string',
        pattern: '^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+$',
        description: 'Reverse-DNS app identifier (e.g. com.example.app)',
      },
      version: {
        type: 'string',
        description: 'Semver version string (e.g. 1.0.0)',
      },
      name: {
        type: 'string',
        description: 'Human-readable app name',
      },
      description: {
        type: 'string',
        description: 'Short description shown in the store / dev tools',
      },
      icon: {
        type: 'string',
        description: 'Path or URL to the app icon (e.g. icon.png)',
      },
      port: {
        type: 'integer',
        minimum: 1,
        maximum: 65535,
        description: 'Port the dev server listens on (default 3000)',
      },
      sdkVersion: {
        type: 'string',
        description: 'Semver of the @mentra/miniapp SDK this bundle targets. Host refuses to spawn a miniapp whose sdkVersion is incompatible with the runtime it ships.',
      },
      minHostVersion: {
        type: 'string',
        description: 'Semver of the lowest MentraOS Manager host version that can run this bundle. The host re-validates this on every install and after host upgrades; bundles that no longer meet the bar are disabled (not deleted) with a clear UI.',
      },
      entry: {
        type: 'object',
        description: 'Two-layer bundle entry points. Background is the always-running JSContext entry; UI is the on-demand WebView entry.',
        additionalProperties: false,
        required: ['background'],
        properties: {
          background: {
            type: 'string',
            description: 'Path to the background bundle, relative to the bundle root (e.g. background/index.js). Required for V2+ two-layer bundles.',
          },
          ui: {
            type: 'string',
            description: "Path to the UI bundle entry HTML, relative to the bundle root (e.g. ui/index.html). Optional  -- pure-background miniapps don't need a WebView.",
          },
        },
      },
      type: {
        type: 'string',
        enum: ['standard', 'background'],
        description: "Miniapp type. 'standard' includes a UI WebView; 'background' is JSContext-only. Defaults to 'standard'.",
      },
      permissions: {
        type: 'array',
        description: 'Phone permissions the miniapp needs to declare',
        items: {
          type: 'object',
          required: ['type'],
          additionalProperties: false,
          properties: {
            type: {
              type: 'string',
              enum: [...ALLOWED_PERMISSIONS],
              description: 'Permission type',
            },
            required: {
              type: 'boolean',
              description: 'If false, the permission is optional. Defaults to required at runtime.',
            },
            description: {
              type: 'string',
              description: "User-facing reason this permission is needed (shown in OS prompts)",
            },
          },
        },
      },
      hardwareRequirements: {
        type: 'array',
        description: 'Glasses hardware capabilities the miniapp needs',
        items: {
          type: 'object',
          required: ['type', 'level'],
          additionalProperties: false,
          properties: {
            type: {
              type: 'string',
              enum: [...ALLOWED_HARDWARE_TYPES],
              description: 'Hardware capability type',
            },
            level: {
              type: 'string',
              enum: [...ALLOWED_HARDWARE_LEVELS],
              description: 'REQUIRED hides the app on glasses without it; OPTIONAL still lets it run',
            },
            description: {
              type: 'string',
              description: 'How the miniapp uses this hardware',
            },
          },
        },
      },
      actions: {
        type: 'array',
        description: 'Actions other (system) miniapps can invoke via session.actions. Maps 1:1 onto MCP tools.',
        items: {
          type: 'object',
          required: ['id', 'description'],
          additionalProperties: false,
          properties: {
            id: {
              type: 'string',
              pattern: '^[a-z][a-z0-9_]*$',
              maxLength: 64,
              description: 'Unique-within-app action id (lowercase, starts with a letter).',
            },
            description: {
              type: 'string',
              description: 'AI-facing contract  -- say when to use the action.',
            },
            parameters: {
              type: 'object',
              description: 'JSON-Schema input descriptor (the MCP inputSchema subset).',
              properties: {
                type: {const: 'object'},
                properties: {
                  type: 'object',
                  additionalProperties: {
                    type: 'object',
                    properties: {
                      type: {type: 'string', enum: [...ALLOWED_ACTION_PARAM_TYPES]},
                      description: {type: 'string'},
                      enum: {type: 'array'},
                      items: {
                        type: 'object',
                        properties: {
                          type: {type: 'string', enum: ['string', 'number', 'boolean']},
                        },
                      },
                    },
                  },
                },
                required: {type: 'array', items: {type: 'string'}},
              },
            },
            outputSchema: {
              type: 'object',
              description: 'JSON-Schema descriptor for the structured action result (MCP outputSchema).',
            },
            activation: {
              type: 'string',
              enum: ['user', 'transient'],
              description:
                "Action lifecycle. 'user' opens or preserves the miniapp as user-visible activity; 'transient' may run in an invisible context that is released after the invocation.",
            },
            audience: {
              type: 'string',
              enum: ['system', 'host'],
              description: 'Who may invoke the action. Host actions are omitted from miniapp action discovery.',
            },
          },
        },
      },
    },
  };
}

/** Returns the schema as a pretty-printed JSON string. */
export function generateSchemaString(): string {
  return JSON.stringify(generateSchema(), null, 2) + '\n';
}

/** Write the schema to disk. Used at build time to produce `schema/miniapp.schema.json`. */
export function writeSchemaFile(absPath: string): void {
  mkdirSync(dirname(absPath), {recursive: true});
  writeFileSync(absPath, generateSchemaString(), 'utf8');
}

/** CLI entry: `mentra-miniapp schema print` writes JSON to stdout. */
export function schemaPrint(): void {
  process.stdout.write(generateSchemaString());
}

/**
 * CLI entry: regenerate the on-disk schema file. Run from the CLI package's
 * own scripts (e.g. as a build step) so the published file stays in sync.
 */
export function regenerateSchemaFile(): void {
  // Resolve relative to this file: sdk/miniapp-cli/src/schema.ts  -> ../schema/miniapp.schema.json
  const here = fileURLToPath(import.meta.url);
  const target = resolve(here, '..', '..', 'schema', 'miniapp.schema.json');
  writeSchemaFile(target);
  process.stdout.write(`Wrote ${target}\n`);
}
