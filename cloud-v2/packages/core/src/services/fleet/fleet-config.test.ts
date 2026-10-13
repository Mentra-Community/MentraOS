import {afterEach, describe, expect, test} from "bun:test"
import {enabledFeatures, fleetConfig, fleetInstalled, fleetLimits} from "./fleet-config"

const SECRET = "fleet-shared-secret-value"

/** An environment for one call: nothing is read from the process unless a test says so. */
const env = (values: Record<string, string>): NodeJS.ProcessEnv => ({...values})

const hosted = (url: string) => env({CLOUD_CORE_FLEET_URL: url, CLOUD_CORE_FLEET_SECRET: SECRET})

describe("whether Fleet is installed", () => {
  test("no URL means Fleet is not installed, whatever else is set", () => {
    expect(fleetConfig(env({}))).toEqual({state: "not_installed"})
    expect(fleetConfig(env({CLOUD_CORE_FLEET_URL: ""}))).toEqual({state: "not_installed"})
    expect(fleetConfig(env({CLOUD_CORE_FLEET_URL: "   "}))).toEqual({state: "not_installed"})
    // A secret without a URL is inert.
    expect(fleetConfig(env({CLOUD_CORE_FLEET_SECRET: SECRET}))).toEqual({state: "not_installed"})
    expect(fleetInstalled(env({CLOUD_CORE_FLEET_SECRET: SECRET}))).toBe(false)
  })

  test("a URL and a secret make Fleet ready", () => {
    const config = fleetConfig(hosted("https://mfm.mentraglass.com"))
    expect(config.state).toBe("ready")
    if (config.state !== "ready") throw new Error("unreachable")
    expect(config.baseUrl).toBeInstanceOf(URL)
    expect(config.baseUrl.href).toBe("https://mfm.mentraglass.com/")
    expect(config.secret).toBe(SECRET)
    expect(fleetInstalled(hosted("https://mfm.mentraglass.com"))).toBe(true)
  })

  test("a path prefix is kept and the URL is trimmed", () => {
    const config = fleetConfig(hosted("  https://mfm.example.test/fleet  "))
    expect(config.state === "ready" && config.baseUrl.href).toBe("https://mfm.example.test/fleet")
  })

  test("a URL without a secret is misconfigured, and still installed", () => {
    for (const secret of [undefined, "", "   "]) {
      const values = env({CLOUD_CORE_FLEET_URL: "https://mfm.mentraglass.com"})
      if (secret !== undefined) values.CLOUD_CORE_FLEET_SECRET = secret
      const config = fleetConfig(values)
      expect(config.state).toBe("misconfigured")
      if (config.state === "misconfigured") expect(config.reason).toContain("CLOUD_CORE_FLEET_SECRET")
      expect(fleetInstalled(values)).toBe(true)
    }
  })

  test("a URL that is unusable is misconfigured, and the reason names the variable and never its value", () => {
    const unusable = [
      "not a url",
      "mfm.mentraglass.com",
      "ftp://mfm.mentraglass.com",
      "https://user:pass@mfm.mentraglass.com",
      "https://mfm.mentraglass.com/?token=1",
      "https://mfm.mentraglass.com/#frag",
    ]
    for (const url of unusable) {
      const config = fleetConfig(hosted(url))
      expect(config.state).toBe("misconfigured")
      if (config.state === "misconfigured") {
        expect(config.reason).toContain("CLOUD_CORE_FLEET_URL")
        expect(config.reason).not.toContain(url)
        expect(config.reason).not.toContain("pass")
        expect(config.reason).not.toContain(SECRET)
      }
      expect(fleetInstalled(hosted(url))).toBe(true)
    }
  })

  test("a missing secret and an unusable URL are both reported", () => {
    const config = fleetConfig(env({CLOUD_CORE_FLEET_URL: "ftp://mfm.example.test"}))
    expect(config.state === "misconfigured" && config.reason).toContain("CLOUD_CORE_FLEET_URL")
    expect(config.state === "misconfigured" && config.reason).toContain("CLOUD_CORE_FLEET_SECRET")
  })
})

describe("plain http", () => {
  test("is refused for any other host on a deployed Core", () => {
    const deployments = [
      {CLOUD_CORE_ENVIRONMENT: "dev"},
      {CLOUD_CORE_ENVIRONMENT: "staging"},
      {CLOUD_CORE_ENVIRONMENT: "prod"},
      {CLOUD_CORE_ENVIRONMENT: "production"},
      {CLOUD_CORE_ENVIRONMENT: " PROD "},
      {NODE_ENV: "production"},
    ]
    for (const deployment of deployments) {
      const config = fleetConfig({...hosted("http://mfm.internal"), ...deployment})
      expect(config.state).toBe("misconfigured")
      if (config.state === "misconfigured") expect(config.reason).toContain("CLOUD_CORE_FLEET_URL")
    }
  })

  test("is accepted for localhost and 127.0.0.1 on a deployed Core", () => {
    for (const url of ["http://localhost:8080", "http://127.0.0.1:8080/fleet"]) {
      expect(fleetConfig({...hosted(url), CLOUD_CORE_ENVIRONMENT: "prod"}).state).toBe("ready")
      expect(fleetConfig({...hosted(url), NODE_ENV: "production"}).state).toBe("ready")
    }
  })

  test("is accepted for any host on a local or test Core", () => {
    expect(fleetConfig(hosted("http://mfm.internal")).state).toBe("ready")
    expect(fleetConfig({...hosted("http://mfm.internal"), CLOUD_CORE_ENVIRONMENT: "local"}).state).toBe("ready")
    expect(fleetConfig({...hosted("http://mfm.internal"), NODE_ENV: "test"}).state).toBe("ready")
  })

  test("https is accepted everywhere", () => {
    expect(fleetConfig({...hosted("https://mfm.internal"), CLOUD_CORE_ENVIRONMENT: "prod"}).state).toBe("ready")
  })
})

describe("CLOUD_CORE_ENABLED_FEATURES", () => {
  test("a blank setting keeps hosted semantics: Fleet is installed once it is configured", () => {
    for (const features of ["", "   "]) {
      const values = {...hosted("https://mfm.mentraglass.com"), CLOUD_CORE_ENABLED_FEATURES: features}
      expect(fleetConfig(values).state).toBe("ready")
      expect(fleetInstalled(values)).toBe(true)
    }
  })

  test("a setting that does not list fleet.managed means Fleet is not installed", () => {
    const values = {
      ...hosted("https://mfm.mentraglass.com"),
      CLOUD_CORE_ENABLED_FEATURES: "call.unlimited:com.mentra.call",
    }
    expect(fleetConfig(values)).toEqual({state: "not_installed"})
    expect(fleetInstalled(values)).toBe(false)
  })

  test("a setting without a feature name counts as set: only a listed fleet.managed installs Fleet", () => {
    expect(fleetConfig({...hosted("https://mfm.mentraglass.com"), CLOUD_CORE_ENABLED_FEATURES: " , ,"})).toEqual({
      state: "not_installed",
    })
  })

  test("a setting that lists fleet.managed means Fleet is ready", () => {
    const values = {
      ...hosted("https://mfm.mentraglass.com"),
      CLOUD_CORE_ENABLED_FEATURES: "call.unlimited:com.mentra.call, fleet.managed",
    }
    expect(fleetConfig(values).state).toBe("ready")
    expect(fleetInstalled(values)).toBe(true)
  })

  test("without fleet.managed Fleet is not installed even when the Fleet settings are unusable", () => {
    const values = {CLOUD_CORE_FLEET_URL: "ftp://nope", CLOUD_CORE_ENABLED_FEATURES: "call.unlimited"}
    expect(fleetConfig(values)).toEqual({state: "not_installed"})
  })

  test("with fleet.managed but no URL Fleet is not installed", () => {
    expect(fleetConfig({CLOUD_CORE_ENABLED_FEATURES: "fleet.managed", CLOUD_CORE_FLEET_SECRET: SECRET})).toEqual({
      state: "not_installed",
    })
  })

  test("with fleet.managed an unusable setup is still reported as misconfigured", () => {
    const config = fleetConfig({
      CLOUD_CORE_FLEET_URL: "https://mfm.example.test",
      CLOUD_CORE_ENABLED_FEATURES: "fleet.managed",
    })
    expect(config.state).toBe("misconfigured")
  })

  test("enabledFeatures reads the feature names, ignoring the package lists, blanks and repeats", () => {
    expect(enabledFeatures(env({}))).toEqual(new Set())
    expect(enabledFeatures(env({CLOUD_CORE_ENABLED_FEATURES: "  "}))).toEqual(new Set())
    expect(
      enabledFeatures(
        env({
          CLOUD_CORE_ENABLED_FEATURES: " call.unlimited:com.mentra.call+com.mentra.notes ,fleet.managed,, fleet.managed ,:orphan",
        }),
      ),
    ).toEqual(new Set(["call.unlimited", "fleet.managed"]))
  })
})

describe("Fleet limits", () => {
  const DEFAULTS = {maxBodyBytes: 1_048_576, maxResponseBytes: 10_485_760, timeoutMs: 10_000, maxAssetBytes: 26_214_400}

  test("default to 1 MiB, 10 MiB, 10 s and 25 MiB", () => {
    expect(fleetLimits(env({}))).toEqual(DEFAULTS)
    expect(DEFAULTS.maxBodyBytes).toBe(1024 * 1024)
    expect(DEFAULTS.maxResponseBytes).toBe(10 * 1024 * 1024)
    expect(DEFAULTS.maxAssetBytes).toBe(25 * 1024 * 1024)
  })

  test("take positive integers from the environment", () => {
    expect(
      fleetLimits(
        env({
          CLOUD_CORE_FLEET_MAX_BODY_BYTES: "2048",
          CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES: " 4096 ",
          CLOUD_CORE_FLEET_TIMEOUT_MS: "2500",
          CLOUD_CORE_FLEET_MAX_ASSET_BYTES: "1000000",
        }),
      ),
    ).toEqual({maxBodyBytes: 2048, maxResponseBytes: 4096, timeoutMs: 2500, maxAssetBytes: 1_000_000})
  })

  test("fall back to the default for a value that is not a positive integer", () => {
    for (const bad of ["", "   ", "abc", "1.5", "-1", "0", "+5", "1e3", "10 MB", "0x10", "99999999999999999999"]) {
      expect(
        fleetLimits(
          env({
            CLOUD_CORE_FLEET_MAX_BODY_BYTES: bad,
            CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES: bad,
            CLOUD_CORE_FLEET_TIMEOUT_MS: bad,
            CLOUD_CORE_FLEET_MAX_ASSET_BYTES: bad,
          }),
        ),
      ).toEqual(DEFAULTS)
    }
  })

  test("a timeout is clamped to the longest a timer can hold, 2147483647 ms", () => {
    expect(fleetLimits(env({CLOUD_CORE_FLEET_TIMEOUT_MS: "2147483647"})).timeoutMs).toBe(2_147_483_647)
    // Past 2^31 - 1 a timer overflows and fires at once on some runtimes, which would fail every request.
    for (const huge of ["2147483648", "4294967296", "9007199254740991"]) {
      expect([huge, fleetLimits(env({CLOUD_CORE_FLEET_TIMEOUT_MS: huge})).timeoutMs]).toEqual([huge, 2_147_483_647])
    }
    // Only the timeout is clamped: a byte limit may be as large as a safe integer.
    expect(fleetLimits(env({CLOUD_CORE_FLEET_MAX_BODY_BYTES: "9007199254740991"})).maxBodyBytes).toBe(9_007_199_254_740_991)
  })

  test("a bad value for one limit leaves the others alone", () => {
    expect(fleetLimits(env({CLOUD_CORE_FLEET_TIMEOUT_MS: "soon", CLOUD_CORE_FLEET_MAX_BODY_BYTES: "512"}))).toEqual({
      ...DEFAULTS,
      maxBodyBytes: 512,
    })
  })
})

describe("the process environment", () => {
  const names = [
    "CLOUD_CORE_FLEET_URL",
    "CLOUD_CORE_FLEET_SECRET",
    "CLOUD_CORE_FLEET_TIMEOUT_MS",
    "CLOUD_CORE_ENABLED_FEATURES",
    "CLOUD_CORE_ENVIRONMENT",
  ] as const
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  afterEach(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  })

  test("is read at call time when no environment is passed", () => {
    for (const name of names) delete process.env[name]
    expect(fleetConfig().state).toBe("not_installed")
    expect(fleetInstalled()).toBe(false)

    process.env.CLOUD_CORE_FLEET_URL = "https://mfm.example.test"
    expect(fleetConfig().state).toBe("misconfigured")
    expect(fleetInstalled()).toBe(true)

    process.env.CLOUD_CORE_FLEET_SECRET = SECRET
    expect(fleetConfig().state).toBe("ready")

    process.env.CLOUD_CORE_ENABLED_FEATURES = "call.unlimited"
    expect(fleetInstalled()).toBe(false)
    expect([...enabledFeatures()]).toEqual(["call.unlimited"])

    process.env.CLOUD_CORE_ENABLED_FEATURES = "fleet.managed"
    process.env.CLOUD_CORE_FLEET_URL = "http://mfm.internal"
    process.env.CLOUD_CORE_ENVIRONMENT = "prod"
    expect(fleetConfig().state).toBe("misconfigured")

    process.env.CLOUD_CORE_FLEET_TIMEOUT_MS = "1234"
    expect(fleetLimits().timeoutMs).toBe(1234)
  })
})
