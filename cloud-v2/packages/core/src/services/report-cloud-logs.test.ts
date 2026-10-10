import {afterEach, beforeEach, describe, expect, spyOn, test} from 'bun:test';

import {collectServerLogs, parseServerLogs, SERVER_LOG_MAX_ENTRIES, serverLogQuery} from './report-cloud-logs';

const USER = `mu_${'A'.repeat(26)}`;
const OTHER_USER = `mu_${'B'.repeat(26)}`;
const CREATED_AT = new Date('2026-10-09T16:30:00.123Z');
const ENV_KEYS = ['BETTERSTACK_V2_USERNAME', 'BETTERSTACK_V2_PASSWORD', 'BETTERSTACK_V2_HOST', 'CLOUD_CORE_ENVIRONMENT'] as const;
let originalEnvironment: Partial<Record<typeof ENV_KEYS[number], string>>;

function row(fields: Record<string, unknown>, dt = '2026-10-09 16:29:59.123'): string {
  return JSON.stringify({dt, raw: JSON.stringify(fields)});
}

function fakeTransport(handler: (input: Parameters<typeof fetch>[0], options?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(handler, {preconnect() {}});
}

beforeEach(() => {
  originalEnvironment = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  process.env.BETTERSTACK_V2_USERNAME = 'test-query-user';
  process.env.BETTERSTACK_V2_PASSWORD = 'PRIVATE_QUERY_PASSWORD';
  process.env.BETTERSTACK_V2_HOST = 'https://logs.example.invalid';
  process.env.CLOUD_CORE_ENVIRONMENT = 'dev';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
});

describe('report server log query', () => {
  test('uses the frozen report window and exact authenticated identity on live and archived sources', () => {
    const query = serverLogQuery('cloud', 'dev', USER, CREATED_AT);

    expect(query).toContain("toDateTime64('2026-10-09 16:20:00.123',3,'UTC')");
    expect(query).toContain("toDateTime64('2026-10-09 16:30:10.123',3,'UTC')");
    expect(query).toContain(`unhex('${Buffer.from(USER).toString('hex')}')`);
    expect(query).toContain('remote(t373499_mentracloud_v2_dev_2_logs)');
    expect(query).toContain('s3Cluster(primary,t373499_mentracloud_v2_dev_2_s3)');
    expect(query).toContain('GROUP BY dt,raw ORDER BY dt DESC LIMIT 1001 FORMAT JSONEachRow');
    expect(query).not.toContain('mentra_miniapps_');
  });

  test.each([
    ['dev', 'mentra_miniapps_dev'],
    ['prod', 'mentra_miniapps_prod'],
    ['staging', 'mentra_miniapps_other'],
    ['debug', 'mentra_miniapps_other'],
  ])('routes %s miniapp logs only to the configured miniapp source', (environment, table) => {
    const query = serverLogQuery('miniapp_server', environment, USER, CREATED_AT);
    expect(query).toContain(`remote(t373499_${table}_logs)`);
    expect(query).toContain(`s3Cluster(primary,t373499_${table}_s3)`);
    expect(query).not.toContain('mentracloud_v2_');
  });

  test('rejects unknown environments and unauthenticated/injected identities before querying', () => {
    expect(() => serverLogQuery('cloud', 'unknown', USER, CREATED_AT)).toThrow('environment is not configured');
    for (const user of ['', 'automation:test-run', `${USER}' OR 1=1`, USER.toLowerCase()]) {
      expect(() => serverLogQuery('cloud', 'dev', user, CREATED_AT)).toThrow('authenticated device user');
    }
    expect(() => serverLogQuery('cloud', 'dev', USER, new Date(NaN))).toThrow();
  });
});

describe('report server log parsing', () => {
  test('keeps exact structured identities and whole user tokens while refusing another user and prefixes', () => {
    const text = [
      row({mentraUserId: USER, message: 'structured mentra identity'}, '2026-10-09 16:29:59.123'),
      row({userId: USER, message: 'structured identity'}, '2026-10-09 16:29:58.123'),
      row({message: `request user=${USER} finished`}, '2026-10-09 16:29:57.123'),
      row({userId: OTHER_USER, message: 'another user'}),
      row({message: `request user=${USER}SUFFIX finished`}),
      row({message: 'global backend status without a user'}),
    ].join('\n');
    const entries = parseServerLogs(text, USER);

    expect(entries).toHaveLength(3);
    expect(entries.map(entry => JSON.parse(entry.message).message)).toEqual([
      `request user=${USER} finished`, 'structured identity', 'structured mentra identity',
    ]);
    expect(entries[0].timestamp).toBe(Date.parse('2026-10-09T16:29:57.123Z'));
    expect(parseServerLogs('', USER)).toEqual([]);
  });

  test('never falls back to a message mention when structured ownership names another user', () => {
    expect(parseServerLogs([
      row({userId: OTHER_USER, message: `target user=${USER} was mentioned`}),
      row({mentraUserId: OTHER_USER, userId: USER, message: 'contradictory identities'}),
    ].join('\n'), USER)).toEqual([]);
  });

  test('redacts opaque credentials in standard, camelCase and nested fields and message values', () => {
    const entries = parseServerLogs(row({
      mentraUserId: USER,
      authorization: 'PRIVATE_AUTHORIZATION',
      accessToken: 'PRIVATE_ACCESS_TOKEN',
      refreshToken: 'PRIVATE_REFRESH_TOKEN',
      coreToken: 'PRIVATE_CORE_TOKEN',
      apiKey: 'PRIVATE_API_KEY',
      api_key: 'PRIVATE_API_KEY_SNAKE',
      nested: [{cookie: 'PRIVATE_COOKIE', password: 'PRIVATE_PASSWORD'}],
      message: 'Authorization: Bearer PRIVATE_BEARER access_token=PRIVATE_QUERY_TOKEN password=PRIVATE_QUERY_PASSWORD msk_PRIVATE_API_TOKEN xoxb-PRIVATE_SLACK_TOKEN',
    }), USER);

    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain('PRIVATE_');
    expect(entries[0].message).toContain('[REDACTED]');
    expect(entries[0].message).toContain(USER);
  });

  test('bounds nested values and string size without losing the original timestamp', () => {
    const nested: Record<string, unknown> = {};
    let cursor = nested;
    for (let index = 0; index < 12; index++) {
      cursor.child = {};
      cursor = cursor.child as Record<string, unknown>;
    }
    cursor.message = 'UNBOUNDED_DEEP_SENTINEL';
    const entries = parseServerLogs(row({userId: USER, message: 'x'.repeat(20_000), nested}), USER);
    const fields = JSON.parse(entries[0].message);
    expect(fields.message).toHaveLength(16_384);
    expect(entries[0].message).toContain('[TRUNCATED]');
    expect(entries[0].message).not.toContain('UNBOUNDED_DEEP_SENTINEL');
  });

  test('retains the latest bounded entries in chronological order with a truthful truncation notice', () => {
    const text = Array.from({length: SERVER_LOG_MAX_ENTRIES + 1}, (_, index) => row({userId: USER, message: `row ${index}`})).join('\n');
    const entries = parseServerLogs(text, USER);
    expect(entries).toHaveLength(SERVER_LOG_MAX_ENTRIES + 1);
    expect(JSON.parse(entries[0].message).message).toBe('row 999');
    expect(JSON.parse(entries[SERVER_LOG_MAX_ENTRIES - 1].message).message).toBe('row 0');
    expect(entries.at(-1)?.message).toContain('earlier entries were omitted');
    expect(() => parseServerLogs(`${text}\n${row({userId: USER})}`, USER)).toThrow('entry limit');
  });

  test.each([
    'invalid json',
    JSON.stringify({dt: '2026-10-09 16:29:59.123', raw: 'invalid json'}),
    JSON.stringify({dt: '2026-10-09 16:29:59.123', raw: '[]'}),
    JSON.stringify({dt: '2026-10-09 16:29:59.123', raw: 'null'}),
    row({userId: USER}, 'invalid time'),
  ])('refuses malformed source data', text => {
    expect(() => parseServerLogs(text, USER)).toThrow();
  });
});

describe('report server log transport', () => {
  test('queries once with bounded cancellation and returns only parsed matching user logs', async () => {
    let requests = 0;
    const transport = fakeTransport(async (url, options) => {
      requests++;
      expect(url).toBe('https://logs.example.invalid');
      expect(options?.method).toBe('POST');
      expect(options?.redirect).toBe('error');
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.body).toBe(serverLogQuery('cloud', 'dev', USER, CREATED_AT));
      return new Response(row({userId: USER, message: 'captured backend event'}));
    });

    const entries = await collectServerLogs({source: 'cloud', mentraUserId: USER, createdAt: CREATED_AT}, transport);
    expect(requests).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toContain('captured backend event');
  });

  test('fails before transport when the existing query credentials are unavailable', async () => {
    delete process.env.BETTERSTACK_V2_PASSWORD;
    let requests = 0;
    const transport = fakeTransport(async () => { requests++; return new Response(''); });
    await expect(collectServerLogs({source: 'cloud', mentraUserId: USER, createdAt: CREATED_AT}, transport)).rejects.toThrow('credentials are not configured');
    expect(requests).toBe(0);
  });

  test('refuses oversized streams and cancels the original response body', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    });
    const transport = fakeTransport(async () => new Response(stream));
    await expect(collectServerLogs({source: 'cloud', mentraUserId: USER, createdAt: CREATED_AT}, transport)).rejects.toThrow('exceeded 2 MiB');
    expect(cancelled).toBe(true);
  });

  test('preserves a precise HTTP failure without copying response bodies or credentials', async () => {
    const transport = fakeTransport(async () => new Response('PRIVATE_QUERY_PASSWORD', {status: 403}));
    await expect(collectServerLogs({source: 'cloud', mentraUserId: USER, createdAt: CREATED_AT}, transport)).rejects.toThrow('HTTP 403');
  });

  test.each([
    ['invalid json PRIVATE_QUERY_PASSWORD', 'Server log response contained invalid row JSON'],
    [JSON.stringify({dt: 123, raw: 'PRIVATE_QUERY_PASSWORD'}), 'Server log response row was malformed'],
    [JSON.stringify({dt: '2026-10-09 16:29:59.123', raw: 'PRIVATE_QUERY_PASSWORD'}), 'Server log entry contained invalid JSON'],
    [null, 'Better Stack V2 log query returned no response body'],
  ])('reports a sanitized data failure without exposing the provider response', async (body, reason) => {
    let requests = 0;
    const transport = fakeTransport(async () => { requests++; return new Response(body); });
    await expect(collectServerLogs({source: 'cloud', mentraUserId: USER, createdAt: CREATED_AT}, transport)).rejects.toThrow(reason);
    expect(requests).toBe(1);
  });

  test.each([
    ['TimeoutError', 'timed out before receiving a response', 'timed out while reading the response'],
    ['TypeError', 'transport failed before receiving a response', 'response was interrupted'],
  ])('distinguishes %s during transport and response reading without leaking its message or retrying', async (name, requestReason, responseReason) => {
    const failure = new Error('PRIVATE_QUERY_PASSWORD https://private-provider.invalid PRIVATE_LOG_ENTRY');
    failure.name = name;
    let requests = 0;
    const beforeResponse = fakeTransport(async () => { requests++; throw failure; });
    const interruptedResponse = fakeTransport(async () => {
      requests++;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(failure); },
      }));
    });
    for (const [transport, reason] of [[beforeResponse, requestReason], [interruptedResponse, responseReason]] as const) {
      let caught: unknown;
      try { await collectServerLogs({source: 'miniapp_server', mentraUserId: USER, createdAt: CREATED_AT}, transport); }
      catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(`Better Stack V2 log query ${reason}`);
      expect((caught as Error).message).not.toContain('PRIVATE_');
    }
    expect(requests).toBe(2);
  });

  test('uses the timeout signal reason when the transport reports a generic abort', async () => {
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      expect(milliseconds).toBe(15_000);
      return AbortSignal.abort(new DOMException('PRIVATE_TIMEOUT_DETAILS', 'TimeoutError'));
    });
    try {
      const transport = fakeTransport(async () => { throw new DOMException('PRIVATE_ABORT_DETAILS', 'AbortError'); });
      await expect(collectServerLogs({source: 'cloud', mentraUserId: USER, createdAt: CREATED_AT}, transport)).rejects.toThrow('timed out before receiving a response');
    } finally { timeout.mockRestore(); }
  });
});
