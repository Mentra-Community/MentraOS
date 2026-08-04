/**
 * @fileoverview Tests for the maps service: cache behavior + provider dispatch.
 *
 * These exercise the REAL Mapbox provider (createMapboxProvider) against a
 * stubbed `globalThis.fetch`, so we cover the full path — service -> promise
 * cache -> provider -> normalization — without a network or a real token. The
 * fetch stub also counts calls, which is how we assert the cache's headline
 * behaviors: a hit serves without a second upstream call, and concurrent
 * identical calls coalesce onto ONE call (in-flight dedup).
 *
 * Env + cache state is module-global (provider singleton, two caches), so each
 * test restores `MAPBOX_ACCESS_TOKEN`, resets the provider, clears the caches,
 * and restores the original fetch in afterEach.
 */
import { describe, test, expect, afterEach } from "bun:test";

import {
  directions,
  reverseGeocode,
  placeAutocomplete,
  placeDetails,
  resetMapsProvider,
  clearMapsCaches,
} from "./maps.service";

const realFetch = globalThis.fetch;
const savedToken = process.env.MAPBOX_ACCESS_TOKEN;

/**
 * Install a fake `fetch` that returns `body` (JSON) for every call and counts
 * how many times it was invoked. Returns the counter so a test can assert the
 * cache suppressed/coalesced upstream calls.
 */
function stubFetch(body: unknown, status = 200): { calls: () => number } {
  let count = 0;
  globalThis.fetch = (async () => {
    count += 1;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls: () => count };
}

/** A minimal Mapbox Directions response with one route + one step. */
function mapboxDirectionsBody() {
  return {
    routes: [
      {
        // polyline6 for a couple of points near SF; exact geometry is not
        // asserted, only that decoding produces points.
        geometry: "yapwFhhbjV???",
        distance: 1234,
        duration: 567,
        legs: [
          {
            steps: [
              {
                distance: 1234,
                name: "Fell St",
                maneuver: { type: "depart", modifier: "left", instruction: "Head out" },
                geometry: "yapwFhhbjV",
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * A minimal Mapbox reverse-geocode response carrying a street name + full
 * address. When `road` is null, returns no features (the off-grid case).
 */
function mapboxGeocodeBody(road: string | null, fullAddress?: string) {
  return {
    features: road
      ? [
          {
            properties: {
              name: road,
              full_address: fullAddress ?? `123 ${road}, San Francisco, California`,
              context: { street: { name: road } },
            },
          },
        ]
      : [],
  };
}

const REQ = {
  origin: { lat: 37.7749, lng: -122.4194 },
  stops: [{ lat: 37.7858, lng: -122.4064 }],
  mode: "walking" as const,
};

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedToken === undefined) {
    delete process.env.MAPBOX_ACCESS_TOKEN;
  } else {
    process.env.MAPBOX_ACCESS_TOKEN = savedToken;
  }
  resetMapsProvider();
  clearMapsCaches();
});

describe("maps.service directions", () => {
  test("returns normalized routes from the provider", async () => {
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test";
    stubFetch(mapboxDirectionsBody());

    const result = await directions(REQ);

    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].totalDistanceMeters).toBe(1234);
    expect(result.routes[0].totalDurationSeconds).toBe(567);
    // The neutral step carries the road name + mapped maneuver, not Mapbox shapes.
    expect(result.routes[0].steps?.[0].road).toBe("Fell St");
    expect(result.routes[0].steps?.[0].maneuver).toBe("DEPART");
  });

  test("a second identical request is served from cache (no second fetch)", async () => {
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test";
    const fetchStub = stubFetch(mapboxDirectionsBody());

    await directions(REQ);
    await directions(REQ);

    expect(fetchStub.calls()).toBe(1);
  });

  test("concurrent identical requests coalesce onto one upstream call (in-flight dedup)", async () => {
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test";
    const fetchStub = stubFetch(mapboxDirectionsBody());

    // Fire many at once, before the first resolves, so they hit the in-flight
    // promise rather than a settled cache entry.
    const results = await Promise.all(
      Array.from({ length: 50 }, () => directions(REQ)),
    );

    expect(results).toHaveLength(50);
    expect(fetchStub.calls()).toBe(1);
  });

  test("a different request is a cache miss (separate fetch)", async () => {
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test";
    const fetchStub = stubFetch(mapboxDirectionsBody());

    await directions(REQ);
    await directions({ ...REQ, mode: "driving" });

    expect(fetchStub.calls()).toBe(2);
  });

  test("an upstream failure is NOT cached: the next call retries upstream", async () => {
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test";
    // First a 500 (provider throws), then a success.
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) return new Response("upstream boom", { status: 500 });
      return new Response(JSON.stringify(mapboxDirectionsBody()), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(directions(REQ)).rejects.toThrow();
    // The failure must have been evicted, so this re-hits upstream and succeeds.
    const ok = await directions(REQ);
    expect(ok.routes).toHaveLength(1);
    expect(call).toBe(2);
  });

  test("throws a clear error when MAPBOX_ACCESS_TOKEN is unset", async () => {
    delete process.env.MAPBOX_ACCESS_TOKEN;
    stubFetch(mapboxDirectionsBody());

    await expect(directions(REQ)).rejects.toThrow(/MAPBOX_ACCESS_TOKEN/);
  });
});

describe("maps.service reverseGeocode", () => {
  test("returns the resolved road name + full address", async () => {
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test";
    stubFetch(mapboxGeocodeBody("Market St", "1 Market St, San Francisco, California 94105"));

    const result = await reverseGeocode({ lat: 37.7749, lng: -122.4194 });

    expect(result.road).toBe("Market St");
    expect(result.address).toBe("1 Market St, San Francisco, California 94105");
  });

  test("returns { road: null, address: null } when nothing is found nearby", async () => {
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test";
    stubFetch(mapboxGeocodeBody(null));

    const result = await reverseGeocode({ lat: 0, lng: 0 });

    expect(result.road).toBeNull();
    expect(result.address).toBeNull();
  });

  test("coordinates within ~1 m share a cache entry (one fetch)", async () => {
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test";
    const fetchStub = stubFetch(mapboxGeocodeBody("Market St"));

    // Same 5-decimal grid cell (~1 m) -> one cache key -> one upstream call.
    await reverseGeocode({ lat: 37.774901, lng: -122.419401 });
    await reverseGeocode({ lat: 37.774902, lng: -122.419402 });

    expect(fetchStub.calls()).toBe(1);
  });
});

/** A minimal Mapbox Search Box /suggest response. */
function mapboxSuggestBody(name: string) {
  return {
    suggestions: [
      { mapbox_id: "abc123", name, place_formatted: `${name}, San Francisco` },
      // A suggestion without a mapbox_id must be dropped (un-retrievable).
      { name: "no id place", place_formatted: "somewhere" },
    ],
  };
}

/** A minimal Mapbox Search Box /retrieve FeatureCollection. */
function mapboxRetrieveBody() {
  return {
    features: [
      {
        geometry: { coordinates: [-122.4194, 37.7749] },
        properties: {
          mapbox_id: "abc123",
          name: "Blue Bottle Coffee",
          full_address: "66 Mint St, San Francisco, California 94103",
        },
      },
    ],
  };
}

describe("maps.service placeAutocomplete", () => {
  test("returns normalized suggestions, dropping ones with no id", async () => {
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test";
    stubFetch(mapboxSuggestBody("Blue Bottle Coffee"));

    const result = await placeAutocomplete("blue bottle", undefined, "sess-1");

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toEqual({
      placeId: "abc123",
      mainText: "Blue Bottle Coffee",
      secondaryText: "Blue Bottle Coffee, San Francisco",
    });
  });

  test("an empty query short-circuits with no upstream call", async () => {
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test";
    const fetchStub = stubFetch(mapboxSuggestBody("x"));

    const result = await placeAutocomplete("   ", undefined, "sess-1");

    expect(result.suggestions).toEqual([]);
    expect(fetchStub.calls()).toBe(0);
  });

  test("identical (query, session) coalesces onto one upstream call", async () => {
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test";
    const fetchStub = stubFetch(mapboxSuggestBody("Blue Bottle Coffee"));

    await placeAutocomplete("blue bottle", undefined, "sess-1");
    await placeAutocomplete("Blue Bottle", undefined, "sess-1"); // case-insensitive key

    expect(fetchStub.calls()).toBe(1);
  });
});

describe("maps.service placeDetails", () => {
  test("resolves a suggestion to coordinates + address", async () => {
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test";
    stubFetch(mapboxRetrieveBody());

    const place = await placeDetails("abc123", "sess-1");

    expect(place).toEqual({
      placeId: "abc123",
      name: "Blue Bottle Coffee",
      address: "66 Mint St, San Francisco, California 94103",
      lat: 37.7749,
      lng: -122.4194,
    });
  });

  test("is not cached: a second identical call re-hits upstream", async () => {
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test";
    const fetchStub = stubFetch(mapboxRetrieveBody());

    await placeDetails("abc123", "sess-1");
    await placeDetails("abc123", "sess-1");

    expect(fetchStub.calls()).toBe(2);
  });
});
