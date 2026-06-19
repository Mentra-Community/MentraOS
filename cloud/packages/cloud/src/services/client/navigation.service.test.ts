import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  ROUTE_CACHE_TTL_MS,
  clearNavigationProxyCaches,
  computeRoute,
  reverseGeocode,
  type FetchLike,
} from "./navigation.service";

/** Counting fetch stub. Returns queued responses, then repeats the last. */
function makeFetchStub(...responses: Array<() => Response | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const make = responses[Math.min(calls.length, responses.length) - 1];
    const result = make();
    if (result instanceof Error) throw result;
    return result;
  };
  return { fetchFn, calls };
}

const okJson = () => new Response('{"routes":[]}', { status: 200 });

const ROUTE_BODY = {
  origin: { location: { latLng: { latitude: 37.77, longitude: -122.42 } } },
  destination: { location: { latLng: { latitude: 37.78, longitude: -122.41 } } },
  travelMode: "DRIVE",
};

let originalKey: string | undefined;

beforeEach(() => {
  originalKey = process.env.GOOGLE_NAV_API_KEY;
  process.env.GOOGLE_NAV_API_KEY = "test-key";
  clearNavigationProxyCaches();
});

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.GOOGLE_NAV_API_KEY;
  } else {
    process.env.GOOGLE_NAV_API_KEY = originalKey;
  }
});

describe("computeRoute caching", () => {
  test("100 identical requests hit the cache, not Google", async () => {
    const { fetchFn, calls } = makeFetchStub(okJson);
    const now = () => 1_000; // frozen clock — everything inside one TTL window

    for (let i = 0; i < 100; i++) {
      const result = await computeRoute(ROUTE_BODY, { fetchFn, now });
      expect(result).toEqual({ kind: "ok", body: '{"routes":[]}' });
    }

    expect(calls.length).toBe(1);
  });

  test("100 CONCURRENT identical requests share one in-flight upstream call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      calls.push(url);
      await gate; // hold every request open so callers genuinely overlap
      return okJson();
    };

    const pending = Array.from({ length: 100 }, () => computeRoute(ROUTE_BODY, { fetchFn, now: () => 0 }));
    release();
    const results = await Promise.all(pending);

    expect(calls.length).toBe(1);
    for (const result of results) {
      expect(result.kind).toBe("ok");
    }
  });

  test("different bodies are cached separately", async () => {
    const { fetchFn, calls } = makeFetchStub(okJson);
    const now = () => 0;

    await computeRoute(ROUTE_BODY, { fetchFn, now });
    await computeRoute({ ...ROUTE_BODY, travelMode: "WALK" }, { fetchFn, now });

    expect(calls.length).toBe(2);
  });

  test("entries expire after ROUTE_CACHE_TTL_MS", async () => {
    const { fetchFn, calls } = makeFetchStub(okJson);
    let t = 0;
    const now = () => t;

    await computeRoute(ROUTE_BODY, { fetchFn, now });
    t = ROUTE_CACHE_TTL_MS - 1;
    await computeRoute(ROUTE_BODY, { fetchFn, now });
    expect(calls.length).toBe(1); // still inside the window

    t = ROUTE_CACHE_TTL_MS + 1;
    await computeRoute(ROUTE_BODY, { fetchFn, now });
    expect(calls.length).toBe(2); // expired → refetched
  });

  test("upstream errors are returned but not cached", async () => {
    const { fetchFn, calls } = makeFetchStub(() => new Response("INVALID_ARGUMENT", { status: 400 }), okJson);
    const now = () => 0;

    const first = await computeRoute(ROUTE_BODY, { fetchFn, now });
    expect(first).toEqual({ kind: "upstream_error", status: 400, body: "INVALID_ARGUMENT" });

    const second = await computeRoute(ROUTE_BODY, { fetchFn, now });
    expect(second.kind).toBe("ok");
    expect(calls.length).toBe(2);
  });

  test("network failures are returned as error and not cached", async () => {
    const { fetchFn, calls } = makeFetchStub(() => new Error("ECONNRESET"), okJson);
    const now = () => 0;

    const first = await computeRoute(ROUTE_BODY, { fetchFn, now });
    expect(first.kind).toBe("error");

    const second = await computeRoute(ROUTE_BODY, { fetchFn, now });
    expect(second.kind).toBe("ok");
    expect(calls.length).toBe(2);
  });

  test("reports not_configured without calling Google when the key is missing", async () => {
    delete process.env.GOOGLE_NAV_API_KEY;
    const { fetchFn, calls } = makeFetchStub(okJson);

    const result = await computeRoute(ROUTE_BODY, { fetchFn, now: () => 0 });

    expect(result).toEqual({ kind: "not_configured" });
    expect(calls.length).toBe(0);
  });
});

describe("reverseGeocode caching", () => {
  test("coordinates within ~1 m share a cache entry", async () => {
    const { fetchFn, calls } = makeFetchStub(okJson);
    const now = () => 0;

    await reverseGeocode(37.123451, -122.000004, { fetchFn, now });
    await reverseGeocode(37.123449, -122.000001, { fetchFn, now }); // same 5-decimal grid cell

    expect(calls.length).toBe(1);
  });

  test("distinct coordinates fetch separately and pass result_type + key upstream", async () => {
    const { fetchFn, calls } = makeFetchStub(okJson);
    const now = () => 0;

    await reverseGeocode(37.1, -122.0, { fetchFn, now });
    await reverseGeocode(37.2, -122.0, { fetchFn, now });

    expect(calls.length).toBe(2);
    expect(calls[0].url).toContain("latlng=37.1,-122");
    expect(calls[0].url).toContain("result_type=route");
    expect(calls[0].url).toContain("key=test-key");
  });

  test("spamming one coordinate 100 times hits Google once", async () => {
    const { fetchFn, calls } = makeFetchStub(okJson);
    const now = () => 0;

    for (let i = 0; i < 100; i++) {
      const result = await reverseGeocode(37.77, -122.42, { fetchFn, now });
      expect(result.kind).toBe("ok");
    }

    expect(calls.length).toBe(1);
  });
});
