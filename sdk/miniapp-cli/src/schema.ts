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
import {
  ALLOWED_PERMISSIONS,
  ALLOWED_HARDWARE_TYPES,
  ALLOWED_HARDWARE_LEVELS,
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
  // Resolve relative to this file: sdk/miniapp-cli/src/schema.ts → ../schema/miniapp.schema.json
  const here = new URL(import.meta.url).pathname;
  const target = resolve(here, '..', '..', 'schema', 'miniapp.schema.json');
  writeSchemaFile(target);
  process.stdout.write(`Wrote ${target}\n`);
}
