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
});
