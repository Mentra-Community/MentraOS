# Node.js - Docs

If you're working with Node.js (versions 20+), the official `posthog-node` library is the simplest way to integrate your software with PostHog. This library uses an internal queue to make calls fast and non-blocking. It also batches requests and flushes asynchronously, making it perfect to use in any part of your web app or other server-side application that needs performance. And in addition to event capture, [feature flags](/docs/feature-flags.md) are supported as well.

## Installation

Run either `npm` or `yarn` in terminal to add it to your project:

PostHog AI

### npm

```bash
npm install posthog-node --save
```

### Yarn

```bash
yarn add posthog-node
```

### pnpm

```bash
pnpm add posthog-node
```

### Bun

```bash
bun add posthog-node
```

In your app, set your project token **before** making any calls.

Node.js

PostHog AI

```javascript
import { PostHog } from "posthog-node";
const client = new PostHog("<ph_project_token>", { host: "https://us.i.posthog.com" });
await client.shutdown();
```

You can find your project token and instance address in the [project settings](https://app.posthog.com/project/settings) page in PostHog.

> **Note:** As a rule of thumb, we do not recommend hardcoding API keys or tokens. Setting it as an environment variable is preferred.

## Identifying users

> **Identifying users is required.** Backend events need a `distinct_id` that matches the ID your frontend uses when calling `posthog.identify()`. Without this, backend events are orphaned — they can't be linked to frontend event captures, [session replays](/docs/session-replay.md), [LLM traces](/docs/ai-engineering.md), or [error tracking](/docs/error-tracking.md).
>
> See our guide on [identifying users](/docs/getting-started/identify-users.md) for how to set this up.

### Options

| Variable                    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Default value             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| host                        | Your PostHog host                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | https://us.i.posthog.com/ |
| flushAt                     | After how many capture calls we should flush the queue (in one batch)                                                                                                                                                                                                                                                                                                                                                                                                                                           | 20                        |
| flushInterval               | After how many ms we should flush the queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 10000                     |
| personalApiKey              | An optional [personal API key](/docs/api/overview.md#personal-api-keys-recommended) for evaluating feature flags locally. Note: Providing this will trigger periodic calls to the feature flags service, even if you're not using feature flags.                                                                                                                                                                                                                                                                | null                      |
| featureFlagsPollingInterval | Interval in milliseconds specifying how often feature flags should be fetched from the PostHog API                                                                                                                                                                                                                                                                                                                                                                                                              | 300000                    |
| requestTimeout              | Timeout in milliseconds for any calls                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 10000                     |
| maxCacheSize                | Maximum size of cache that deduplicates $feature_flag_called calls per user.                                                                                                                                                                                                                                                                                                                                                                                                                                    | 50000                     |
| disableGeoip                | When true, disables automatic GeoIP resolution for events and feature flags.                                                                                                                                                                                                                                                                                                                                                                                                                                    | true                      |
| evaluation_contexts         | Evaluation context tags that constrain which feature flags are evaluated. When set, only flags with matching evaluation context tags (or no evaluation context tags) will be returned. This helps reduce unnecessary flag evaluations and improves performance. See [evaluation contexts documentation](/docs/feature-flags/evaluation-contexts.md) for more details. Available in version 5.10.0+. The legacy parameter evaluation_environments (version 5.9.6+) is also supported for backward compatibility. | undefined                 |

> **Note:** When using PostHog in an AWS Lambda function or a similar serverless function environment, make sure you set `flushAt` to `1` and `flushInterval` to `0`. Also, remember to always call `await posthog.shutdown()` at the end to flush and send all pending events.

## Capturing events

You can send custom events using `capture`:

Node.js

PostHog AI

```javascript
client.capture({
  distinctId: "distinct_id_of_the_user",
  event: "user signed up",
});
```

> **Tip:** We recommend using a `[object] [verb]` format for your event names, where `[object]` is the entity that the behavior relates to, and `[verb]` is the behavior itself. For example, `project created`, `user signed up`, or `invite sent`.

### Setting event properties

Optionally, you can include additional information with the event by including a [properties](/docs/data/events.md#event-properties) object:

Node.js

PostHog AI

```javascript
client.capture({
  distinctId: "distinct_id_of_the_user",
  event: "user signed up",
  properties: {
    login_type: "email",
    is_free_trial: true,
  },
});
```

### Capturing pageviews

If you're aiming for a backend-only implementation of PostHog and won't be capturing events from your frontend, you can send `$pageview` events from your backend like so:

Node.js

PostHog AI

```javascript
client.capture({
  distinctId: "distinct_id_of_the_user",
  event: "$pageview",
  properties: {
    $current_url: "https://example.com",
  },
});
```

## Person profiles and properties

The Node SDK captures identified events by default. These create [person profiles](/docs/data/persons.md). To set [person properties](/docs/data/user-properties.md) in these profiles, include them when capturing an event using `$set` and `$set_once`:

Node.js

PostHog AI

```javascript
client.capture({
  distinctId: "distinct_id_of_the_user",
  event: "movie_played",
  properties: {
    $set: { name: "Max Hedgehog" },
    $set_once: { initial_url: "/blog" },
  },
});
```

For more details on the difference between `$set` and `$set_once`, see our [person properties docs](/docs/data/user-properties.md#what-is-the-difference-between-set-and-set_once).

To capture [anonymous events](/docs/data/anonymous-vs-identified-events.md) without person profiles, set the event's `$process_person_profile` property to `false`:

Node.js

PostHog AI

```javascript
client.capture({
  distinctId: "distinct_id_of_the_user",
  event: "movie_played",
  properties: {
    $process_person_profile: false,
  },
});
```

## Alias

Sometimes, you want to assign multiple distinct IDs to a single user. This is helpful when your primary distinct ID is inaccessible. For example, if a distinct ID used on the frontend is not available in your backend.

In this case, you can use `alias` to assign another distinct ID to the same user.

Node.js

PostHog AI

```javascript
client.alias({
  distinctId: "distinct_id",
  alias: "alias_id",
});
```

We strongly recommend reading our docs on [alias](/docs/data/identify.md#alias-assigning-multiple-distinct-ids-to-the-same-user) to best understand how to correctly use this method.

## Super properties

> Requires `posthog-node` version >= 5.25.0.

Super properties are properties that are automatically included with every event captured by the client. Use `register` to set them:

Node.js

PostHog AI

```javascript
client.register({
  app_version: "1.2.0",
  environment: "production",
});
// Both events include app_version and environment
client.capture({
  distinctId: "distinct_id",
  event: "page_viewed",
});
client.capture({
  distinctId: "distinct_id",
  event: "button_clicked",
});
```

If an event sets a property with the same key as a super property, the event's property takes precedence:

Node.js

PostHog AI

```javascript
client.register({ environment: "production" });
// This event is captured with environment='staging'
client.capture({
  distinctId: "distinct_id",
  event: "page_viewed",
  properties: { environment: "staging" },
});
```

To remove a super property, use `unregister`:

Node.js

PostHog AI

```javascript
client.unregister("environment");
```

Super properties are **global** — they apply to every event for the lifetime of the client instance. For properties that should only apply to a specific scope (e.g. a single request or transaction), use [contexts](#contexts) instead.

## Contexts

> Requires `posthog-node` version >= 5.17.0.

The Node SDK uses nested contexts for managing state that's shared across events. Contexts are useful for adding properties to multiple events (including exceptions) during a single user's interaction with your product.

You can enter a context using `withContext`:

Node.js

PostHog AI

```javascript
posthog.withContext(
  {
    distinctId: "user-123",
    properties: { transactionId: "abc123" },
  },
  () => {
    // This event is captured with the distinct ID and properties set above
    posthog.capture({ event: "order_processed" });
  },
);
```

Contexts are persisted across function calls. If you enter one and then call a function and capture an event in the called function, it uses the context properties set in the parent context:

Node.js

PostHog AI

```javascript
function someFunction() {
  // When called from `outerFunction`, this event is captured
  // with transactionId='abc123'
  posthog.capture({ event: "order_processed" });
}
function outerFunction() {
  posthog.withContext({ properties: { transactionId: "abc123" } }, () => {
    someFunction();
  });
}
```

By default, each context inherits from parent contexts. To disable nesting (where child contexts is fresh and has no properties), pass `{ fresh: true }`:

Node.js

PostHog AI

```javascript
posthog.withContext(
  {
    properties: {
      someKey: "value-1",
      someOtherKey: "another-value",
    },
  },
  () => {
    posthog.withContext({ properties: { someKey: "value-2" } }, () => {
      // Captured with someKey='value-2', someOtherKey='another-value'
      posthog.capture({ event: "order_processed" });
    });
    // Captured with someKey='value-1', someOtherKey='another-value'
    posthog.capture({ event: "order_completed" });
  },
);
```

> **Note:** Properties passed directly to `capture` calls override context state in the final event.

### Identification context

Contexts can be associated with a distinct ID:

Node.js

PostHog AI

```javascript
posthog.withContext({ distinctId: "user-123" }, () => {
  // Associated with "user-123"
  posthog.capture({ event: "order_processed" });
  // Overrides to "another-user"
  posthog.capture({
    distinctId: "another-user",
    event: "order_processed",
  });
});
```

### Session context

Node.js

PostHog AI

```javascript
posthog.withContext({ sessionId: "some-session" }, () => {
  // Associated with session "some-session"
  posthog.capture({ event: "image_uploaded" });
  // Overrides to "next-session"
  posthog.capture({
    event: "image_uploaded",
    properties: { $sessionId: "next-session" },
  });
});
```

### Custom context parameters

Node.js

PostHog AI

```javascript
posthog.withContext({ flightNumber: "TAC313" }, () => {
  // Associated with flightNumber TAC313
  posthog.capture({ event: "flight_cancelled" });
  // Overrides to PL7714
  posthog.capture({
    event: "flight_cancelled",
    properties: { flightNumber: "PL7714" },
  });
});
```

## Feature flags

PostHog's [feature flags](/docs/feature-flags.md) enable you to safely deploy and roll back new features as well as target specific users and groups with them.

There are 2 steps to implement feature flags in Node:

### Step 1: Evaluate the feature flag value

#### Boolean feature flags

Node.js

PostHog AI

```javascript
const isFeatureFlagEnabled = await client.isFeatureEnabled("flag-key", "distinct_id_of_your_user");
if (isFeatureFlagEnabled) {
  // Your code if the flag is enabled
  // Optional: fetch the payload
  const matchedFlagPayload = await client.getFeatureFlagPayload(
    "flag-key",
    "distinct_id_of_your_user",
    isFeatureFlagEnabled,
  );
}
```

#### Multivariate feature flags

Node.js

PostHog AI

```javascript
const enabledVariant = await client.getFeatureFlag("flag-key", "distinct_id_of_your_user");
if (enabledVariant === "variant-key") {
  // replace 'variant-key' with the key of your variant
  // Do something differently for this user
  // Optional: fetch the payload
  const matchedFlagPayload = await client.getFeatureFlagPayload("flag-key", "distinct_id_of_your_user", enabledVariant);
}
```

### Step 2: Include feature flag information when capturing events

If you want use your feature flag to breakdown or filter events in your [insights](/docs/product-analytics/insights.md), you'll need to include feature flag information in those events. This ensures that the feature flag value is attributed correctly to the event.

> **Note:** This step is only required for events captured using our server-side SDKs or [API](/docs/api.md).

There are two methods you can use to include feature flag information in your events:

#### Method 1: Include the `$feature/feature_flag_name` property

In the event properties, include `$feature/feature_flag_name: variant_key`:

Node.js

PostHog AI

```javascript
client.capture({
  distinctId: "distinct_id_of_your_user",
  event: "event_name",
  properties: {
    "$feature/feature-flag-key": "variant-key", // replace feature-flag-key with your flag key. Replace 'variant-key' with the key of your variant
  },
});
```

#### Method 2: Set `sendFeatureFlags` to `true`

The `capture()` method has an optional argument `sendFeatureFlags`, which is set to `false` by default. This parameter controls whether feature flag information is sent with the event.

#### Basic usage

Setting `sendFeatureFlags` to `true` will include feature flag information with the event:

Node.js

PostHog AI

```javascript
client.capture({
  distinctId: "distinct_id_of_your_user",
  event: "event_name",
  sendFeatureFlags: true,
});
```

#### Advanced usage (v5.5.0+)

As of version 5.5.0, `sendFeatureFlags` can also accept an options object for more granular control:

Node.js

PostHog AI

```javascript
client.capture({
  distinctId: "distinct_id_of_your_user",
  event: "event_name",
  sendFeatureFlags: {
    onlyEvaluateLocally: true,
    personProperties: { plan: "premium" },
    groupProperties: { org: { tier: "enterprise" } },
  },
});
```

#### Performance considerations

- **With local evaluation**: When [local evaluation](/docs/feature-flags/local-evaluation.md) is configured, setting `sendFeatureFlags: true` will **not** make additional server requests. Instead, it uses the locally cached feature flags, and it provides an interface for including person and/or group properties needed to evaluate the flags in the context of the event, if required.

- **Without local evaluation**: PostHog will make an additional request to fetch feature flag information before capturing the event, which adds delay.

#### Breaking change in v5.5.0

Prior to version 5.5.0, feature flags were automatically sent with events when using local evaluation, even when `sendFeatureFlags` was not explicitly set. This behavior has been **removed** in v5.5.0 to be more predictable and explicit.

If you were relying on this automatic behavior, you must now explicitly set `sendFeatureFlags: true` to continue sending feature flags with your events.

### Fetching all flags for a user

You can fetch all flag values for a single user by calling `getAllFlags()` or `getAllFlagsAndPayloads()`.

This is useful when you need to fetch multiple flag values and don't want to make multiple requests.

Node.js

PostHog AI

```javascript
await client.getAllFlags("distinct_id_of_your_user");
await client.getAllFlagsAndPayloads("distinct_id_of_your_user");
```

### Sending `$feature_flag_called` events

Capturing `$feature_flag_called` events enable PostHog to know when a flag was accessed by a user and thus provide [analytics and insights](/docs/product-analytics/insights.md) on the flag. By default, we send a these event when:

1.  You call `posthog.getFeatureFlag()` or `posthog.isFeatureEnabled()`, AND
2.  It's a new user, or the value of the flag has changed.

> _Note:_ Tracking whether it's a new user or if a flag value has changed happens in a local cache. This means that if you reinitialize the PostHog client, the cache resets as well – causing `$feature_flag_called` events to be sent again when calling `getFeatureFlag` or `isFeatureEnabled`. PostHog is built to handle this, and so duplicate `$feature_flag_called` events won't affect your analytics.

You can disable automatically capturing `$feature_flag_called` events. For example, when you don't need the analytics, or it's being called at such a high volume that sending events slows things down.

To disable it, set the `sendFeatureFlagEvents` argument in your function call, like so:

Node.js

PostHog AI

```javascript
const isFeatureFlagEnabled = await client.isFeatureEnabled("flag-key", "distinct_id_of_your_user", {
  sendFeatureFlagEvents: false,
});
```

### Advanced: Overriding server properties

Sometimes, you may want to evaluate feature flags using [person properties](/docs/product-analytics/person-properties.md), [groups](/docs/product-analytics/group-analytics.md), or group properties that haven't been ingested yet, or were set incorrectly earlier.

You can provide properties to evaluate the flag with by using the `person properties`, `groups`, and `group properties` arguments. PostHog will then use these values to evaluate the flag, instead of any properties currently stored on your PostHog server.

For example:

Node.js

PostHog AI

```javascript
await client.getFeatureFlag("flag-key", "distinct_id_of_the_user", {
  personProperties: {
    property_name: "value",
  },
  groups: {
    your_group_type: "your_group_id",
    another_group_type: "your_group_id",
  },
  groupProperties: {
    your_group_type: {
      group_property_name: "value",
    },
    another_group_type: {
      group_property_name: "value",
    },
  },
});
```

### Overriding GeoIP properties

By default, a user's GeoIP properties are set using the IP address they use to capture events on the frontend. You may want to override the these properties when evaluating feature flags. A common reason to do this is when you're not using PostHog on your frontend, so the user has no GeoIP properties.

You can override GeoIP properties by including them in the `person_properties` parameter when evaluating feature flags. This is useful when you're evaluating flags on your backend and want to use the client's location instead of your server's location.

The following GeoIP properties can be overridden:

- `$geoip_country_code`
- `$geoip_country_name`
- `$geoip_city_name`
- `$geoip_city_confidence`
- `$geoip_continent_code`
- `$geoip_continent_name`
- `$geoip_latitude`
- `$geoip_longitude`
- `$geoip_postal_code`
- `$geoip_subdivision_1_code`
- `$geoip_subdivision_1_name`
- `$geoip_subdivision_2_code`
- `$geoip_subdivision_2_name`
- `$geoip_subdivision_3_code`
- `$geoip_subdivision_3_name`
- `$geoip_time_zone`

Simply include any of these properties in the `person_properties` parameter alongside your other person properties when calling feature flags.

### Request timeout

You can configure the `feature_flag_request_timeout_ms` parameter when initializing your PostHog client to set a flag request timeout. This helps prevent your code from being blocked in the case when PostHog's servers are too slow to respond. By default, this is set at 3 seconds.

JavaScript

PostHog AI

```javascript
const client = new PostHog("<ph_project_token>", {
  api_host: "https://us.i.posthog.com",
  feature_flag_request_timeout_ms: 3000, // Time in milliseconds. Default is 3000 (3 seconds).
});
```

### Error handling

When using the PostHog SDK, it's important to handle potential errors that may occur during feature flag operations. Here's an example of how to wrap PostHog SDK methods in an error handler:

JavaScript

PostHog AI

```javascript
async function handleFeatureFlag(client, flagKey, distinctId) {
  try {
    const isEnabled = await client.isFeatureEnabled(flagKey, distinctId);
    console.log(`Feature flag '${flagKey}' for user '${distinctId}' is ${isEnabled ? "enabled" : "disabled"}`);
    return isEnabled;
  } catch (error) {
    console.error(`Error fetching feature flag '${flagKey}': ${error.message}`);
    // Optionally, you can return a default value or throw the error
    // return false; // Default to disabled
    throw error;
  }
}
// Usage example
try {
  const flagEnabled = await handleFeatureFlag(client, "new-feature", "user-123");
  if (flagEnabled) {
    // Implement new feature logic
  } else {
    // Implement old feature logic
  }
} catch (error) {
  // Handle the error at a higher level
  console.error("Feature flag check failed, using default behavior");
  // Implement fallback logic
}
```

> **Note:** For remote config flags, see the [remote config documentation](/docs/feature-flags/remote-config.md). Remote config requires the [Feature Flags secure API key](/docs/feature-flags/remote-config.md#step-1-find-your-feature-flags-secure-api-key) passed as the `personalApiKey` option.

### Local evaluation

Evaluating feature flags requires making a request to PostHog for each flag. However, you can improve performance by evaluating flags locally. Instead of making a request for each flag, PostHog will periodically request and store feature flag definitions locally, enabling you to evaluate flags without making additional requests.

It is best practice to use local evaluation flags when possible, since this enables you to resolve flags faster and with fewer API calls.

For details on how to implement local evaluation, see our [local evaluation guide](/docs/feature-flags/local-evaluation.md).

Node.js

PostHog AI

```javascript
const flagValue = await client.getFeatureFlag('flag-key', 'user distinct id', {groups:{'organization': 'google'}, groupProperties:{'organization': {'is_authorized': True}})
```

#### Reloading feature flags

When initializing PostHog, you can configure the interval at which feature flags are polled (fetched from the server). However, if you need to force a reload, you can use `reloadFeatureFlags`:

Node.js

PostHog AI

```javascript
await client.reloadFeatureFlags();
// Do something with feature flags here
```

#### Distributed environments

In multi-worker or edge environments, you can implement custom caching for flag definitions using Redis, Cloudflare KV, or other storage backends. This enables sharing definitions across workers and coordinating fetches. See our guide for [local evaluation in distributed environments](/docs/feature-flags/local-evaluation/distributed-environments?tab=Node.js.md) for details.

## Experiments (A/B tests)

Since [experiments](/docs/experiments/manual.md) use feature flags, the code for running an experiment is very similar to the feature flags code:

Node.js

PostHog AI

```javascript
const variant = await client.getFeatureFlag("experiment-feature-flag-key", "user_distinct_id");
if (variant === "variant-name") {
  // do something
}
```

It's also possible to [run experiments without using feature flags](/docs/experiments/running-experiments-without-feature-flags.md).

## Group analytics

Group analytics enable you to associate an event with a group (e.g. teams, organizations, etc.). Read the [group analytics guide](/docs/product-analytics/group-analytics.md) for more information.

To create a group or update its properties, use `groupIdentify`:

Node.js

PostHog AI

```javascript
client.groupIdentify({
  groupType: "company",
  groupKey: "company_id_in_your_db",
  properties: {
    name: "Awesome Inc",
    employees: 11,
  },
  // optional distinct ID to associate event with an existing person
  distinctId: "xyz",
});
```

`name` is a special property which is used in the PostHog UI for the name of the group. If you don't specify a `name` property, the group ID is used instead.

If the optional `distinctId` parameter is not provided in the group identify call, it defaults to `${groupType}_${groupKey}` (e.g., `$company_company_id_in_your_db` in the example above). This default behavior results in each group appearing as a separate person in PostHog. To avoid this, it's often more practical to use a consistent `distinctId`, such as `group_identifier`.

Once a group is created, you can use the `capture` method and pass in the `groups` parameter to capture an event with group analytics.

Node.js

PostHog AI

```javascript
client.capture({
  event: "some_event",
  distinctId: "user_distinct_id",
  groups: { company: "company_id_in_your_db" },
});
```

## GeoIP properties

Before `posthog-node` v3.0, we added GeoIP properties to all incoming events by default. We also used these properties for feature flag evaluation, based on the IP address of the request. This isn't ideal since they are created based on your server IP address, rather than the user's, leading to incorrect location resolution.

As of `posthog-node` v3.0, the default now is to disregard the server IP, not add the GeoIP properties, and not use the values for feature flag evaluations.

You can go back to previous behavior by setting `disableGeoip` to false in your initialization:

Node.js

PostHog AI

```javascript
const posthog = new PostHog("<ph_project_token>", {
  host: "https://us.i.posthog.com",
  disableGeoip: false,
});
```

The list of properties that this overrides:

1.  `$geoip_city_name`
2.  `$geoip_country_name`
3.  `$geoip_country_code`
4.  `$geoip_continent_name`
5.  `$geoip_continent_code`
6.  `$geoip_postal_code`
7.  `$geoip_time_zone`

You can also explicitly chose to enable or disable GeoIP for a single capture request like so:

Node.js

PostHog AI

```javascript
client.capture({
  distinctId: distinctId,
  event: "your_event",
  disableGeoip: `true`,
});
```

## Shutdown

You should call `shutdown` on your program's exit to exit cleanly:

Node.js

PostHog AI

```javascript
// Stop pending pollers and flush any remaining events
await client.shutdown();
```

## Debug mode

If you're not seeing the expected events being captured, the feature flags being evaluated, or the surveys being shown, you can enable debug mode to see what's happening.

You can enable debug mode by calling the `debug()` method in your code. This will enable verbose logs about the inner workings of the SDK.

Node.js

PostHog AI

```javascript
client.debug();
```

## Handling errors thrown by the SDK

If you are experiencing issues with the SDK it could be a number of things from an incorrectly configured API key, to some other network related issues.

The SDK does not throw errors for things happening in the background to ensure it doesn't affect your process. You can however hook into the errors to get more information:

Node.js

PostHog AI

```javascript
client.on("error", (err) => {
  // Whatever handling you want
  console.error("PostHog had an error!", err);
});
```

## Short-lived processes like serverless environments

The Node SDK is designed to queue and batch requests in the background to optimize API calls and network time. As serverless environments like AWS Lambda or [Vercel Functions](/docs/libraries/vercel.md) are short-lived, we provide a few options to ensure all events are captured.

First, we recommend using the `captureImmediate` method instead of `capture` to ensure the event is captured before the function shuts down. It guarantees the HTTP request finishes before your function continues (or shuts down).

Second, we recommend setting `flushAt` to `1` and `flushInterval` to `0` to ensure the events are sent immediately. These set the queue to flush immediately, both in terms of events and time.

Third, we provide a method `shutdown()` which can be awaited to ensure all queued events are sent to the API. For example:

Node.js

PostHog AI

```javascript
export const handler() {
  client.capture({
    distinctId: 'distinct_id_of_the_user',
    event: 'thing_happened'
  })
  client.capture({
    distinctId: 'distinct_id_of_the_user',
    event: 'other_thing_happened'
  })
  // So far 2 events are queued but not sent
  // Calling shutdown, flushed the queue but batched into 1 API call for maximum efficiency
  await client.shutdown()
}
```

This is also useful for shutting down a standard Node.js app.

## LLM analytics

You can capture LLM usage and performance data by combining the `posthog-node` and `@posthog/ai` libraries. These work with LLM providers like OpenAI and Vercel's AI SDKs. Learn more in our [LLM analytics docs](/docs/llm-analytics.md).

## Error tracking

You can capture errors using the `posthog-node` library. This enables you to see stack traces, source code, and watch associated session recordings to improve your application stability. Learn more in our [error tracking docs](/docs/error-tracking/installation/node.md).

## Upgrading from V1 to V2

V2.x.x of the Node.js library is completely rewritten in Typescript and is based on a new JS core shared with other JavaScript based libraries with the goal of ensuring new features and fixes reach the different libraries at the same pace.

With the release of V2, the API was kept mostly the same but with some small changes and deprecations:

1.  The minimum PostHog version requirement is 1.38
2.  The `callback` parameter passed as an optional last argument to most of the methods is no longer supported
3.  The method signature for `isFeatureEnabled` and `getFeatureFlag` is slightly modified. See the above documentation for each method for more details.
4.  For specific changes, [see the CHANGELOG](https://github.com/PostHog/posthog-js/blob/main/packages/node/CHANGELOG.md)

### Community questions

Ask a question

### Was this page useful?

HelpfulCould be better
