import {describe, expect, test} from 'bun:test';
import {createLoggerWithOutput} from './logger';
const USER = `mu_${'A'.repeat(26)}`, OTHER = `mu_${'B'.repeat(26)}`;
function fixture() {
  const lines: string[] = [];
  const logger = createLoggerWithOutput({packageName: 'com.mentra.notes', environment: 'dev'}, line => lines.push(line));
  return {logger, lines, rows: () => lines.map(line => JSON.parse(line))};
}
describe('backend logger', () => {
  test('isolates overlapping asynchronous work and protects identity in children', async () => {
    const {logger, rows} = fixture();
    await Promise.all([USER, OTHER].map(async mentraUserId => {
      const log = logger.forUser({mentraUserId});
      await Promise.resolve();
      log.child({mentraUserId: OTHER, packageName: 'wrong', task: 'background'}).info('done', {mentraUserId: OTHER, level: 'error'});
    }));
    expect(rows().map(row => row.mentraUserId)).toEqual([USER, OTHER]);
    expect(rows().every(row => row.packageName === 'com.mentra.notes' && row.level === 'info')).toBe(true);
    expect(() => logger.forUser({mentraUserId: USER}).forUser({mentraUserId: OTHER})).toThrow('rebind');
    expect(() => logger.forUser({mentraUserId: 'unverified'})).toThrow('authenticated');
    logger.info('startup');
    expect(rows().at(-1).mentraUserId).toBeUndefined();
  });
  test('serializes errors and circular values, redacts credentials before writing', () => {
    const {logger, rows, lines} = fixture();
    const error = new Error('Bearer PRIVATE_BEARER password=PRIVATE_PASSWORD');
    const circular: Record<string, unknown> = {accessToken: 'PRIVATE_TOKEN'}; circular.self = circular;
    logger.forUser({mentraUserId: USER}).error('request failed', {error, circular});
    expect(lines.join('')).not.toContain('PRIVATE_');
    expect(rows()[0].error.name).toBe('Error');
    expect(rows()[0].error.stack).toContain('[REDACTED]');
    expect(rows()[0].circular.self).toBe('[CIRCULAR]');
    expect(Number.isFinite(Date.parse(rows()[0].timestamp))).toBe(true);
  });
  test('bounds unicode data, oversized keys and optional fields without losing custody', () => {
    const {logger, lines, rows} = fixture();
    logger.forUser({mentraUserId: USER}).info('🙂'.repeat(9000), Object.fromEntries(Array.from({length: 100}, (_, i) => ['x'.repeat(10000) + i, '🙂'.repeat(8000)])));
    expect(Buffer.byteLength(lines[0])).toBeLessThanOrEqual(32768);
    expect(rows()[0]).toMatchObject({mentraUserId: USER, packageName: 'com.mentra.notes', truncated: true});
  });
  test('contains bad values and output errors and honors level', () => {
    const logger = createLoggerWithOutput({packageName: 'com.mentra.notes', environment: 'dev'}, () => {throw new Error('write failed');});
    expect(() => logger.error('failure', {get error() {throw new Error('getter failed');}})).not.toThrow();
    expect(() => logger.info('event')).not.toThrow();
    const {logger: normal, rows} = fixture(); normal.debug('debug'); expect(rows()).toHaveLength(0);
  });
});
