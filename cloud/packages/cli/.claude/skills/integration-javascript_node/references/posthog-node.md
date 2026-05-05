# PostHog Node.js SDK

**SDK Version:** 5.28.11

PostHog Node.js SDK allows you to capture events and send them to PostHog from your Node.js applications.

## Categories

- Initialization
- Identification
- Capture
- Error tracking
- Privacy
- Feature flags
- Context

## PostHog

### Other methods

#### getLibraryId()

**Release Tag:** public

### Returns

- `string`

### Examples

```node
// Generated example for getLibraryId
posthog.getLibraryId();
```

---

#### enterContext()

**Release Tag:** public

Set context without a callback wrapper.
Uses `AsyncLocalStorage.enterWith()` to attach context to the current async execution context. The context lives until that async context ends.
Must be called in the same async scope that makes PostHog calls. Calling this outside a request-scoped async context will leak context across unrelated work. Prefer `withContext()` when you can wrap code in a callback — it creates an isolated scope that cleans up automatically.

### Parameters

- **`data`** (`Partial<ContextData>`) - Context data to apply (distinctId, sessionId, properties)
- **`options?`** (`ContextOptions`) - Context options (fresh: true to start with clean context instead of inheriting)

### Returns

- `void`

### Examples

```node
// Generated example for enterContext
posthog.enterContext();
```

---

#### flush()

**Release Tag:** public

### Returns

- `Promise<void>`

### Examples

```node
// Generated example for flush
posthog.flush();
```

---

#### prepareEventMessage()

**Release Tag:** public

### Parameters

- **`props`** (`EventMessage`)

### Returns

- `Promise<{
      distinctId: string;
      event: string;
      properties: PostHogEventProperties;
      options: PostHogCaptureOptions;
  }>`

### Examples

```node
// Generated example for prepareEventMessage
posthog.prepareEventMessage();
```

---

#### fetch()

**Release Tag:** public

### Parameters

- **`url`** (`string`)
- **`options`** (`PostHogFetchOptions`)

### Returns

- `Promise<PostHogFetchResponse>`

### Examples

```node
// Generated example for fetch
posthog.fetch();
```

---

#### getSurveysStateless()

**Release Tag:** public

- \*_ SURVEYS _

### Returns

- `Promise<SurveyResponse['surveys']>`

### Examples

```node
// Generated example for getSurveysStateless
posthog.getSurveysStateless();
```

---

#### on()

**Release Tag:** public

### Parameters

- **`event`** (`string`)
- **`cb`** (`(...args: any[]) => void`)

### Returns

- `() => void`

### Examples

```node
// Generated example for on
posthog.on();
```

---

#### optIn()

**Release Tag:** public

### Returns

- `Promise<void>`

### Examples

```node
// Generated example for optIn
posthog.optIn();
```

---

#### optOut()

**Release Tag:** public

### Returns

- `Promise<void>`

### Examples

```node
// Generated example for optOut
posthog.optOut();
```

---

#### register()

**Release Tag:** public

### Parameters

- **`properties`** (`PostHogEventProperties`)

### Returns

- `Promise<void>`

### Examples

```node
// Generated example for register
posthog.register();
```

---

#### unregister()

**Release Tag:** public

### Parameters

- **`property`** (`string`)

### Returns

- `Promise<void>`

### Examples

```node
// Generated example for unregister
posthog.unregister();
```

---

### Initialization methods

#### PostHog()

**Release Tag:** public

Initialize a new PostHog client instance.

### Parameters

- **`apiKey`** (`string`) - Your PostHog project API key
- **`options?`** (`PostHogOptions`) - Configuration options for the client

### Returns

- `any`

### Examples

#### Basic initialization

```node
// Basic initialization
const client = new PostHogBackendClient("your-api-key", { host: "https://app.posthog.com" });
```

#### With personal API key

```node
// With personal API key
const client = new PostHogBackendClient("your-api-key", {
  host: "https://app.posthog.com",
  personalApiKey: "your-personal-api-key",
});
```

---

#### debug()

**Release Tag:** public

Enable or disable debug logging.

### Parameters

- **`enabled?`** (`boolean`) - Whether to enable debug logging

### Returns

- `void`

### Examples

#### Enable debug logging

```node
// Enable debug logging
client.debug(true);
```

#### Disable debug logging

```node
// Disable debug logging
client.debug(false);
```

---

#### getLibraryVersion()

**Release Tag:** public

Get the library version from package.json.

### Returns

- `string`

### Examples

```node
// Get version
const version = client.getLibraryVersion();
console.log(`Using PostHog SDK version: ${version}`);
```

---

#### getPersistedProperty()

**Release Tag:** public

Get a persisted property value from memory storage.

### Parameters

- **`key`** (`PostHogPersistedProperty`) - The property key to retrieve

### Returns

**Union of:**

- `any`
- `undefined`

### Examples

#### Get user ID

```node
// Get user ID
const userId = client.getPersistedProperty("userId");
```

#### Get session ID

```node
// Get session ID
const sessionId = client.getPersistedProperty("sessionId");
```

---

#### setPersistedProperty()

**Release Tag:** public

Set a persisted property value in memory storage.

### Parameters

- **`key`** (`PostHogPersistedProperty`) - The property key to set
- **`value`** (`any | null`) - The value to store (null to remove)

### Returns

- `void`

### Examples

#### Set user ID

```node
// Set user ID
client.setPersistedProperty("userId", "user_123");
```

#### Set session ID

```node
// Set session ID
client.setPersistedProperty("sessionId", "session_456");
```

---

#### shutdown()

**Release Tag:** public

Shuts down the PostHog instance and ensures all events are sent.
Call shutdown() once before the process exits to ensure that all events have been sent and all promises have resolved. Do not use this function if you intend to keep using this PostHog instance after calling it. Use flush() for per-request cleanup instead.

### Parameters

- **`shutdownTimeoutMs?`** (`number`) - Maximum time to wait for shutdown in milliseconds

### Returns

- `Promise<void>`

### Examples

```node
// shutdown before process exit
process.on("SIGINT", async () => {
  await posthog.shutdown();
  process.exit(0);
});
```

---

### Identification methods

#### alias()

**Release Tag:** public

Create an alias to link two distinct IDs together.

### Parameters

- **`data`** (`{
      distinctId: string;
      alias: string;
      disableGeoip?: boolean;
  }`) - The alias data containing distinctId and alias

### Returns

- `void`

### Examples

```node
// Link an anonymous user to an identified user
client.alias({
  distinctId: "anonymous_123",
  alias: "user_456",
});
```

---

#### aliasImmediate()

**Release Tag:** public

Create an alias to link two distinct IDs together immediately (synchronously).

### Parameters

- **`data`** (`{
      distinctId: string;
      alias: string;
      disableGeoip?: boolean;
  }`) - The alias data containing distinctId and alias

### Returns

- `Promise<void>`

### Examples

```node
// Link an anonymous user to an identified user immediately
await client.aliasImmediate({
  distinctId: "anonymous_123",
  alias: "user_456",
});
```

---

#### getCustomUserAgent()

**Release Tag:** public

Get the custom user agent string for this client.

### Returns

- `string`

### Examples

```node
// Get user agent
const userAgent = client.getCustomUserAgent();
// Returns: "posthog-node/5.7.0"
```

---

#### groupIdentify()

**Release Tag:** public

Create or update a group and its properties.

### Parameters

- **`{ groupType, groupKey, properties, distinctId, disableGeoip }`** (`GroupIdentifyMessage`)

### Returns

- `void`

### Examples

#### Create a company group

```node
// Create a company group
client.groupIdentify({
  groupType: "company",
  groupKey: "acme-corp",
  properties: {
    name: "Acme Corporation",
    industry: "Technology",
    employee_count: 500,
  },
  distinctId: "user_123",
});
```

#### Update organization properties

```node
// Update organization properties
client.groupIdentify({
  groupType: "organization",
  groupKey: "org-456",
  properties: {
    plan: "enterprise",
    region: "US-West",
  },
});
```

---

#### identify()

**Release Tag:** public

Identify a user and set their properties.

### Parameters

- **`{ distinctId, properties, disableGeoip }`** (`IdentifyMessage`)

### Returns

- `void`

### Examples

#### Basic identify with properties

```node
// Basic identify with properties
client.identify({
  distinctId: "user_123",
  properties: {
    name: "John Doe",
    email: "john@example.com",
    plan: "premium",
  },
});
```

#### Using $set and $set_once

```node
// Using $set and $set_once
client.identify({
  distinctId: 'user_123',
  properties: {
    $set: { name: 'John Doe', email: 'john@example.com' },
    $set_once: { first_login: new Date().toISOString() }
    $anon_distinct_id: 'anonymous_user_456'
  }
})
```

---

#### identifyImmediate()

**Release Tag:** public

Identify a user and set their properties immediately (synchronously).

### Parameters

- **`{ distinctId, properties, disableGeoip }`** (`IdentifyMessage`)

### Returns

- `Promise<void>`

### Examples

```node
// Basic immediate identify
await client.identifyImmediate({
  distinctId: "user_123",
  properties: {
    name: "John Doe",
    email: "john@example.com",
  },
});
```

---

### Capture methods

#### capture()

**Release Tag:** public

Capture an event manually.

### Parameters

- **`props`** (`EventMessage`) - The event properties

### Returns

- `void`

### Examples

```node
// Basic capture
client.capture({
  distinctId: "user_123",
  event: "button_clicked",
  properties: { button_color: "red" },
});
```

---

#### captureImmediate()

**Release Tag:** public

Capture an event immediately (synchronously).

### Parameters

- **`props`** (`EventMessage`) - The event properties

### Returns

- `Promise<void>`

### Examples

#### Basic immediate capture

```node
// Basic immediate capture
await client.captureImmediate({
  distinctId: "user_123",
  event: "button_clicked",
  properties: { button_color: "red" },
});
```

#### With feature flags

```node
// With feature flags
await client.captureImmediate({
  distinctId: "user_123",
  event: "user_action",
  sendFeatureFlags: true,
});
```

#### With custom feature flags options

```node
// With custom feature flags options
await client.captureImmediate({
  distinctId: 'user_123',
  event: 'user_action',
  sendFeatureFlags: {
    onlyEvaluateLocally: true,
    personProperties: { plan: 'premium' },
    groupProperties: { org: { tier: 'enterprise' } }
    flagKeys: ['flag1', 'flag2']
  }
})
```

---

### Error tracking methods

#### captureException()

**Release Tag:** public

Capture an error exception as an event.

### Parameters

- **`error`** (`unknown`) - The error to capture
- **`distinctId?`** (`string`) - Optional user distinct ID
- **`additionalProperties?`** (`Record<string | number, any>`) - Optional additional properties to include
- **`uuid?`** (`EventMessage['uuid']`)

### Returns

- `void`

### Examples

#### Capture an error with user ID

```node
// Capture an error with user ID
try {
  // Some risky operation
  riskyOperation();
} catch (error) {
  client.captureException(error, "user_123");
}
```

#### Capture with additional properties

```node
// Capture with additional properties
try {
  apiCall();
} catch (error) {
  client.captureException(error, "user_123", {
    endpoint: "/api/users",
    method: "POST",
    status_code: 500,
  });
}
```

---

#### captureExceptionImmediate()

**Release Tag:** public

Capture an error exception as an event immediately (synchronously).

### Parameters

- **`error`** (`unknown`) - The error to capture
- **`distinctId?`** (`string`) - Optional user distinct ID
- **`additionalProperties?`** (`Record<string | number, any>`) - Optional additional properties to include

### Returns

- `Promise<void>`

### Examples

#### Capture an error immediately with user ID

```node
// Capture an error immediately with user ID
try {
  // Some risky operation
  riskyOperation();
} catch (error) {
  await client.captureExceptionImmediate(error, "user_123");
}
```

#### Capture with additional properties

```node
// Capture with additional properties
try {
  apiCall();
} catch (error) {
  await client.captureExceptionImmediate(error, "user_123", {
    endpoint: "/api/users",
    method: "POST",
    status_code: 500,
  });
}
```

---

### Privacy methods

#### disable()

**Release Tag:** public

Disable the PostHog client (opt-out).

### Returns

- `Promise<void>`

### Examples

```node
// Disable client
await client.disable();
// Client is now disabled and will not capture events
```

---

#### enable()

**Release Tag:** public

Enable the PostHog client (opt-in).

### Returns

- `Promise<void>`

### Examples

```node
// Enable client
await client.enable();
// Client is now enabled and will capture events
```

---

### Feature flags methods

#### getAllFlags()

**Release Tag:** public

Get all feature flag values for a specific user.

### Parameters

- **`options?`** (`AllFlagsOptions`) - Optional configuration for flag evaluation

### Returns

- `Promise<Record<string, FeatureFlagValue>>`

### Examples

#### Get all flags for a user

```node
// Get all flags for a user
const allFlags = await client.getAllFlags("user_123");
console.log("User flags:", allFlags);
// Output: { 'flag-1': 'variant-a', 'flag-2': false, 'flag-3': 'variant-b' }
```

#### With specific flag keys

```node
// With specific flag keys
const specificFlags = await client.getAllFlags("user_123", {
  flagKeys: ["flag-1", "flag-2"],
});
```

#### With groups and properties

```node
// With groups and properties
const orgFlags = await client.getAllFlags("user_123", {
  groups: { organization: "acme-corp" },
  personProperties: { plan: "enterprise" },
});
```

---

#### getAllFlagsAndPayloads()

**Release Tag:** public

Get all feature flag values and payloads for a specific user.

### Parameters

- **`options?`** (`AllFlagsOptions`) - Optional configuration for flag evaluation

### Returns

- `Promise<PostHogFlagsAndPayloadsResponse>`

### Examples

#### Get all flags and payloads for a user

```node
// Get all flags and payloads for a user
const result = await client.getAllFlagsAndPayloads("user_123");
console.log("Flags:", result.featureFlags);
console.log("Payloads:", result.featureFlagPayloads);
```

#### With specific flag keys

```node
// With specific flag keys
const result = await client.getAllFlagsAndPayloads("user_123", {
  flagKeys: ["flag-1", "flag-2"],
});
```

#### Only evaluate locally

```node
// Only evaluate locally
const result = await client.getAllFlagsAndPayloads("user_123", {
  onlyEvaluateLocally: true,
});
```

---

#### getFeatureFlag()

**Release Tag:** public

Get the value of a feature flag for a specific user.

### Parameters

- **`key`** (`string`) - The feature flag key
- **`distinctId`** (`string`) - The user's distinct ID
- **`options?`** (`{
      groups?: Record<string, string>;
      personProperties?: Record<string, string>;
      groupProperties?: Record<string, Record<string, string>>;
      onlyEvaluateLocally?: boolean;
      sendFeatureFlagEvents?: boolean;
      disableGeoip?: boolean;
  }`) - Optional configuration for flag evaluation

### Returns

**Union of:**

- `Promise<FeatureFlagValue`
- `undefined>`

### Examples

#### Basic feature flag check

```node
// Basic feature flag check
const flagValue = await client.getFeatureFlag("new-feature", "user_123");
if (flagValue === "variant-a") {
  // Show variant A
} else if (flagValue === "variant-b") {
  // Show variant B
} else {
  // Flag is disabled or not found
}
```

#### With groups and properties

```node
// With groups and properties
const flagValue = await client.getFeatureFlag("org-feature", "user_123", {
  groups: { organization: "acme-corp" },
  personProperties: { plan: "enterprise" },
  groupProperties: { organization: { tier: "premium" } },
});
```

#### Only evaluate locally

```node
// Only evaluate locally
const flagValue = await client.getFeatureFlag("local-flag", "user_123", {
  onlyEvaluateLocally: true,
});
```

---

#### getFeatureFlagPayload()

**Release Tag:** public

Get the payload for a feature flag.

### Parameters

- **`key`** (`string`) - The feature flag key
- **`distinctId`** (`string`) - The user's distinct ID
- **`matchValue?`** (`FeatureFlagValue`) - Optional match value to get payload for
- **`options?`** (`{
      groups?: Record<string, string>;
      personProperties?: Record<string, string>;
      groupProperties?: Record<string, Record<string, string>>;
      onlyEvaluateLocally?: boolean;
      sendFeatureFlagEvents?: boolean;
      disableGeoip?: boolean;
  }`) - Optional configuration for flag evaluation

### Returns

**Union of:**

- `Promise<JsonType`
- `undefined>`

### Examples

#### Get payload for a feature flag

```node
// Get payload for a feature flag
const payload = await client.getFeatureFlagPayload("flag-key", "user_123");
if (payload) {
  console.log("Flag payload:", payload);
}
```

#### Get payload with specific match value

```node
// Get payload with specific match value
const payload = await client.getFeatureFlagPayload("flag-key", "user_123", "variant-a");
```

#### With groups and properties

```node
// With groups and properties
const payload = await client.getFeatureFlagPayload("org-flag", "user_123", undefined, {
  groups: { organization: "acme-corp" },
  personProperties: { plan: "enterprise" },
});
```

---

#### getFeatureFlagResult()

**Release Tag:** public

Get the result of evaluating a feature flag, including its value and payload. This is more efficient than calling getFeatureFlag and getFeatureFlagPayload separately when you need both.

### Parameters

- **`key`** (`string`) - The feature flag key
- **`options?`** (`FlagEvaluationOptions`) - Optional configuration for flag evaluation

### Returns

**Union of:**

- `Promise<FeatureFlagResult`
- `undefined>`

### Examples

#### Get flag result

```node
// Get flag result
const result = await client.getFeatureFlagResult("my-flag", "user_123");
if (result) {
  console.log("Flag enabled:", result.enabled);
  console.log("Variant:", result.variant);
  console.log("Payload:", result.payload);
}
```

#### With groups and properties

```node
// With groups and properties
const result = await client.getFeatureFlagResult("org-feature", "user_123", {
  groups: { organization: "acme-corp" },
  personProperties: { plan: "enterprise" },
});
```

---

#### getRemoteConfigPayload()

**Release Tag:** public

Get the remote config payload for a feature flag.

### Parameters

- **`flagKey`** (`string`) - The feature flag key

### Returns

**Union of:**

- `Promise<JsonType`
- `undefined>`

### Examples

```node
// Get remote config payload
const payload = await client.getRemoteConfigPayload("flag-key");
if (payload) {
  console.log("Remote config payload:", payload);
}
```

---

#### isFeatureEnabled()

**Release Tag:** public

Check if a feature flag is enabled for a specific user.

### Parameters

- **`key`** (`string`) - The feature flag key
- **`distinctId`** (`string`) - The user's distinct ID
- **`options?`** (`{
      groups?: Record<string, string>;
      personProperties?: Record<string, string>;
      groupProperties?: Record<string, Record<string, string>>;
      onlyEvaluateLocally?: boolean;
      sendFeatureFlagEvents?: boolean;
      disableGeoip?: boolean;
  }`) - Optional configuration for flag evaluation

### Returns

**Union of:**

- `Promise<boolean`
- `undefined>`

### Examples

#### Basic feature flag check

```node
// Basic feature flag check
const isEnabled = await client.isFeatureEnabled("new-feature", "user_123");
if (isEnabled) {
  // Feature is enabled
  console.log("New feature is active");
} else {
  // Feature is disabled
  console.log("New feature is not active");
}
```

#### With groups and properties

```node
// With groups and properties
const isEnabled = await client.isFeatureEnabled("org-feature", "user_123", {
  groups: { organization: "acme-corp" },
  personProperties: { plan: "enterprise" },
});
```

---

#### isLocalEvaluationReady()

**Release Tag:** public

Check if local evaluation of feature flags is ready.

### Returns

- `boolean`

### Examples

```node
// Check if ready
if (client.isLocalEvaluationReady()) {
  // Local evaluation is ready, can evaluate flags locally
  const flag = await client.getFeatureFlag("flag-key", "user_123");
} else {
  // Local evaluation not ready, will use remote evaluation
  const flag = await client.getFeatureFlag("flag-key", "user_123");
}
```

---

#### overrideFeatureFlags()

**Release Tag:** public

Override feature flags locally. Useful for testing and local development. Overridden flags take precedence over both local evaluation and remote evaluation.

### Parameters

- **`overrides`** (`OverrideFeatureFlagsOptions`) - Flag overrides configuration

### Returns

- `void`

### Examples

```node
// Clear all overrides
client.overrideFeatureFlags(false);

// Enable a list of flags (sets them to true)
client.overrideFeatureFlags(["flag-a", "flag-b"]);

// Set specific flag values/variants
client.overrideFeatureFlags({ "my-flag": "variant-a", "other-flag": true });

// Set both flags and payloads
client.overrideFeatureFlags({
  flags: { "my-flag": "variant-a" },
  payloads: { "my-flag": { discount: 20 } },
});
```

---

#### reloadFeatureFlags()

**Release Tag:** public

Reload feature flag definitions from the server for local evaluation.

### Returns

- `Promise<void>`

### Examples

#### Force reload of feature flags

```node
// Force reload of feature flags
await client.reloadFeatureFlags();
console.log("Feature flags reloaded");
```

#### Reload before checking a specific flag

```node
// Reload before checking a specific flag
await client.reloadFeatureFlags();
const flag = await client.getFeatureFlag("flag-key", "user_123");
```

---

#### waitForLocalEvaluationReady()

**Release Tag:** public

Wait for local evaluation of feature flags to be ready.

### Parameters

- **`timeoutMs?`** (`number`) - Timeout in milliseconds (default: 30000)

### Returns

- `Promise<boolean>`

### Examples

#### Wait for local evaluation

```node
// Wait for local evaluation
const isReady = await client.waitForLocalEvaluationReady();
if (isReady) {
  console.log("Local evaluation is ready");
} else {
  console.log("Local evaluation timed out");
}
```

#### Wait with custom timeout

```node
// Wait with custom timeout
const isReady = await client.waitForLocalEvaluationReady(10000); // 10 seconds
```

---

### Context methods

#### getContext()

**Release Tag:** public

Get the current context data.

### Returns

**Union of:**

- `ContextData`
- `undefined`

### Examples

```node
// Get current context within a withContext block
posthog.withContext({ distinctId: "user_123" }, () => {
  const context = posthog.getContext();
  console.log(context?.distinctId); // 'user_123'
});
```

---

#### withContext()

**Release Tag:** public

Run a function with specific context that will be applied to all events captured within that context. It propagates the context to all subsequent calls down the call stack. Context properties like tags and sessionId will be automatically attached to all events. By default, nested contexts inherit from parent contexts. Use `{ fresh: true }` to start with a clean context.

### Parameters

- **`data`** (`Partial<ContextData>`) - Context data to apply (sessionId, distinctId, properties, enableExceptionAutocapture)
- **`fn`** (`() => T`) - Function to run with the context
- **`options?`** (`ContextOptions`) - Context options (fresh: true to start with clean context instead of inheriting)

### Returns

- `T`

### Examples

```node
posthog.withContext({ distinctId: "user_123" }, () => {
  posthog.capture({ event: "button clicked" });
});
```

---
