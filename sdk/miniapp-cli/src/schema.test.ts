import {expect, test, describe} from 'bun:test';
import {generateSchema} from './schema.js';
import {ALLOWED_PERMISSIONS, ALLOWED_HARDWARE_TYPES, ALLOWED_HARDWARE_LEVELS} from './manifest.js';

describe('generateSchema', () => {
  test('declares the required top-level fields', () => {
    const schema = generateSchema() as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['packageName', 'version', 'name', 'hardwareRequirements']);
  });

  test('permission enum mirrors ALLOWED_PERMISSIONS exactly', () => {
    const schema = generateSchema() as any;
    const enumValues = schema.properties.permissions.items.properties.type.enum;
    expect(enumValues).toEqual([...ALLOWED_PERMISSIONS]);
  });

  test('hardware enum mirrors ALLOWED_HARDWARE_TYPES exactly', () => {
    const schema = generateSchema() as any;
    const enumValues = schema.properties.hardwareRequirements.items.properties.type.enum;
    expect(enumValues).toEqual([...ALLOWED_HARDWARE_TYPES]);
  });

  test('hardware level enum mirrors ALLOWED_HARDWARE_LEVELS exactly', () => {
    const schema = generateSchema() as any;
    const enumValues = schema.properties.hardwareRequirements.items.properties.level.enum;
    expect(enumValues).toEqual([...ALLOWED_HARDWARE_LEVELS]);
  });

  test('permission item disallows extra properties (catches typos)', () => {
    const schema = generateSchema() as any;
    expect(schema.properties.permissions.items.additionalProperties).toBe(false);
  });

  test('actions expose MCP outputSchema metadata', () => {
    const schema = generateSchema() as any;
    expect(schema.properties.actions.items.properties.outputSchema.type).toBe('object');
  });

  test('actions expose lifecycle and audience metadata', () => {
    const schema = generateSchema() as any;
    expect(schema.properties.actions.items.properties.lifecycle.enum).toEqual(['persistent', 'transient']);
    expect(schema.properties.actions.items.properties.audience.enum).toEqual(['system', 'host']);
  });

  test('top-level allows extras for forward-compat', () => {
    const schema = generateSchema() as any;
    expect(schema.additionalProperties).toBe(true);
  });

  test('packageName has reverse-DNS pattern', () => {
    const schema = generateSchema() as any;
    expect(schema.properties.packageName.pattern).toBeDefined();
    const re = new RegExp(schema.properties.packageName.pattern);
    expect(re.test('com.mentra.example')).toBe(true);
    expect(re.test('com.mentra.example.app')).toBe(true);
    expect(re.test('justone')).toBe(false);
    expect(re.test('a.b.c.d')).toBe(true);
  });
});
