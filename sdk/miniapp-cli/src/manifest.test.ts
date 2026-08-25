import {describe, expect, test} from 'bun:test';
import {validateManifest} from './manifest';

const minimalValid = {
  packageName: 'com.example.app',
  version: '1.0.0',
  name: 'Example',
  hardwareRequirements: [{type: 'DISPLAY', level: 'REQUIRED'}],
};

describe('validateManifest', () => {
  test('accepts a minimal valid manifest', () => {
    const {valid, errors} = validateManifest(minimalValid);
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });

  test('rejects non-object input', () => {
    expect(validateManifest(null).valid).toBe(false);
    expect(validateManifest('not an object').valid).toBe(false);
    expect(validateManifest(42).valid).toBe(false);
  });

  describe('required top-level fields', () => {
    test('packageName must be a non-empty string', () => {
      const {errors} = validateManifest({...minimalValid, packageName: ''});
      expect(errors.some((e) => e.includes('packageName'))).toBe(true);
    });

    test('version must be a non-empty string', () => {
      const {errors} = validateManifest({...minimalValid, version: ''});
      expect(errors.some((e) => e.includes('version'))).toBe(true);
    });

    test('name must be a non-empty string', () => {
      const {errors} = validateManifest({...minimalValid, name: undefined});
      expect(errors.some((e) => e.includes('name'))).toBe(true);
    });
  });

  describe('hardwareRequirements (required)', () => {
    test('missing field fails with a helpful message', () => {
      const m = {...minimalValid} as Record<string, unknown>;
      delete m.hardwareRequirements;
      const {valid, errors} = validateManifest(m);
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('hardwareRequirements is required'))).toBe(true);
      expect(errors.some((e) => e.includes('DISPLAY'))).toBe(true); // listed example
    });

    test('empty array is allowed', () => {
      const {valid} = validateManifest({...minimalValid, hardwareRequirements: []});
      expect(valid).toBe(true);
    });

    test('non-array fails', () => {
      const {errors} = validateManifest({
        ...minimalValid,
        hardwareRequirements: 'DISPLAY' as unknown as never,
      });
      expect(errors.some((e) => e.includes('must be an array'))).toBe(true);
    });

    test('unknown hardware type is rejected', () => {
      const {errors} = validateManifest({
        ...minimalValid,
        hardwareRequirements: [{type: 'BRAINWAVE', level: 'REQUIRED'}],
      });
      expect(errors.some((e) => e.includes('unknown hardware "BRAINWAVE"'))).toBe(true);
    });

    test('unknown level is rejected', () => {
      const {errors} = validateManifest({
        ...minimalValid,
        hardwareRequirements: [{type: 'DISPLAY', level: 'MAYBE'}],
      });
      expect(errors.some((e) => e.includes('unknown level "MAYBE"'))).toBe(true);
    });

    test('EXIST cannot be declared by authors', () => {
      const {errors} = validateManifest({
        ...minimalValid,
        hardwareRequirements: [{type: 'EXIST', level: 'REQUIRED'}],
      });
      // EXIST is omitted from ALLOWED_HARDWARE_TYPES; it's injected at runtime.
      expect(errors.some((e) => e.includes('unknown hardware "EXIST"'))).toBe(true);
    });

    test('entry must be an object', () => {
      const {errors} = validateManifest({
        ...minimalValid,
        hardwareRequirements: ['DISPLAY'] as unknown as never,
      });
      expect(errors.some((e) => e.includes('must be an object'))).toBe(true);
    });

    test('description must be a string if set', () => {
      const {errors} = validateManifest({
        ...minimalValid,
        hardwareRequirements: [{type: 'DISPLAY', level: 'REQUIRED', description: 42}],
      });
      expect(errors.some((e) => e.includes('description'))).toBe(true);
    });

    test('all real-world types accepted', () => {
      const all = ['CAMERA', 'DISPLAY', 'MICROPHONE', 'SPEAKER', 'IMU', 'BUTTON', 'LIGHT', 'WIFI'];
      const {valid} = validateManifest({
        ...minimalValid,
        hardwareRequirements: all.map((type) => ({type, level: 'OPTIONAL'})),
      });
      expect(valid).toBe(true);
    });
  });

  describe('permissions (now validates objects, not strings)', () => {
    test('string entries are rejected (pre-existing bug fixed)', () => {
      const {errors} = validateManifest({
        ...minimalValid,
        permissions: ['MICROPHONE'] as unknown as never,
      });
      expect(errors.some((e) => e.includes('must be an object'))).toBe(true);
    });

    test('valid object entry passes', () => {
      const {valid} = validateManifest({
        ...minimalValid,
        permissions: [{type: 'MICROPHONE', description: 'For transcription'}],
      });
      expect(valid).toBe(true);
    });

    test('unknown permission type is rejected', () => {
      const {errors} = validateManifest({
        ...minimalValid,
        permissions: [{type: 'TELEPATHY'}],
      });
      expect(errors.some((e) => e.includes('unknown permission "TELEPATHY"'))).toBe(true);
    });

    test('missing type field is rejected', () => {
      const {errors} = validateManifest({
        ...minimalValid,
        permissions: [{description: 'oops'}],
      });
      expect(errors.some((e) => e.includes('permissions[0].type'))).toBe(true);
    });

    test('bad required type is rejected', () => {
      const {errors} = validateManifest({
        ...minimalValid,
        permissions: [{type: 'MICROPHONE', required: 'yes'}],
      });
      expect(errors.some((e) => e.includes('required'))).toBe(true);
    });

    test('permissions is optional', () => {
      const m = {...minimalValid} as Record<string, unknown>;
      delete m.permissions;
      const {valid} = validateManifest(m);
      expect(valid).toBe(true);
    });
  });

  describe('Two-layer fields (sdkVersion / minHostVersion / entry / type)', () => {
    test('accepts a two-layer manifest with full two-layer fields', () => {
      const {valid, errors} = validateManifest({
        ...minimalValid,
        sdkVersion: '0.2.0',
        minHostVersion: '1.42.0',
        entry: {background: 'dist/background/index.js', ui: 'dist/ui/index.html'},
        type: 'standard',
      });
      expect(errors).toEqual([]);
      expect(valid).toBe(true);
    });

    test('sdkVersion must be a non-empty string when set', () => {
      const {errors} = validateManifest({...minimalValid, sdkVersion: ''});
      expect(errors.some((e) => e.includes('sdkVersion'))).toBe(true);
    });

    test('minHostVersion must be a non-empty string when set', () => {
      const {errors} = validateManifest({...minimalValid, minHostVersion: 42});
      expect(errors.some((e) => e.includes('minHostVersion'))).toBe(true);
    });

    test('entry.background is required when entry is set', () => {
      const {errors} = validateManifest({...minimalValid, entry: {ui: 'dist/ui/index.html'}});
      expect(errors.some((e) => e.includes('entry.background'))).toBe(true);
    });

    test('entry.ui must be a string when set', () => {
      const {errors} = validateManifest({
        ...minimalValid,
        entry: {background: 'dist/background/index.js', ui: 42},
      });
      expect(errors.some((e) => e.includes('entry.ui'))).toBe(true);
    });

    test('entry must be an object (not array, not string)', () => {
      const {errors} = validateManifest({...minimalValid, entry: 'dist/index.js'});
      expect(errors.some((e) => e.includes('entry'))).toBe(true);
    });

    test('type must be "standard" or "background" when set', () => {
      const {errors} = validateManifest({...minimalValid, type: 'weird'});
      expect(errors.some((e) => e.includes('type'))).toBe(true);
    });

    test('type accepts "background" miniapps', () => {
      const {valid} = validateManifest({...minimalValid, type: 'background'});
      expect(valid).toBe(true);
    });

    test('manifests without two-layer fields still validate (legacy single-layer)', () => {
      const {valid, errors} = validateManifest(minimalValid);
      expect(errors).toEqual([]);
      expect(valid).toBe(true);
    });
  });

  describe('actions', () => {
    test('accepts a well-formed action with typed parameters', () => {
      const {valid, errors} = validateManifest({
        ...minimalValid,
        actions: [
          {
            id: 'add_todo',
            description: 'Add an item to the user\'s todo list.',
            activation: 'transient',
            audience: 'host',
            parameters: {
              type: 'object',
              properties: {
                text: {type: 'string', description: 'The todo text'},
                tags: {type: 'array', items: {type: 'string'}},
              },
              required: ['text'],
            },
            outputSchema: {
              type: 'object',
              properties: {
                ok: {type: 'boolean'},
                message: {type: 'string'},
              },
              required: ['ok'],
            },
          },
        ],
      });
      expect(errors).toEqual([]);
      expect(valid).toBe(true);
    });

    test('rejects unknown action activation and audience values', () => {
      const {valid, errors} = validateManifest({
        ...minimalValid,
        actions: [{id: 'sync', description: 'Sync.', activation: 'daemon', audience: 'everyone'}],
      });
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('activation'))).toBe(true);
      expect(errors.some((e) => e.includes('audience'))).toBe(true);
    });

    test('rejects a non-object output schema', () => {
      const {valid, errors} = validateManifest({
        ...minimalValid,
        actions: [{id: 'go', description: 'x', outputSchema: 'not-a-schema'}],
      });
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('outputSchema'))).toBe(true);
    });

    test('accepts an action with no parameters', () => {
      const {valid} = validateManifest({
        ...minimalValid,
        actions: [{id: 'snooze', description: 'Snooze the current reminder.'}],
      });
      expect(valid).toBe(true);
    });

    test('rejects an id that breaks the pattern', () => {
      const {valid, errors} = validateManifest({
        ...minimalValid,
        actions: [{id: 'Add-Todo', description: 'x'}],
      });
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('actions[0].id'))).toBe(true);
    });

    test('rejects duplicate action ids', () => {
      const {valid, errors} = validateManifest({
        ...minimalValid,
        actions: [
          {id: 'go', description: 'one'},
          {id: 'go', description: 'two'},
        ],
      });
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('duplicated'))).toBe(true);
    });

    test('rejects a missing/empty description', () => {
      const {valid, errors} = validateManifest({
        ...minimalValid,
        actions: [{id: 'go', description: '   '}],
      });
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('description'))).toBe(true);
    });

    test('rejects "integer" param type (use "number")', () => {
      const {valid, errors} = validateManifest({
        ...minimalValid,
        actions: [
          {id: 'go', description: 'x', parameters: {type: 'object', properties: {n: {type: 'integer'}}}},
        ],
      });
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('.type must be one of'))).toBe(true);
    });

    test('rejects an array param without items.type', () => {
      const {valid, errors} = validateManifest({
        ...minimalValid,
        actions: [
          {id: 'go', description: 'x', parameters: {type: 'object', properties: {a: {type: 'array'}}}},
        ],
      });
      expect(valid).toBe(false);
      expect(errors.some((e) => e.includes('items.type'))).toBe(true);
    });
  });
});
