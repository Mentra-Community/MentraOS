# G2 native notifications

PR #3688 uses the existing notification policy rather than a second independent presentation listener. Notify is the presentation owner on Android and iOS. Native mode replaces the Mentra card; miniapp forwarding remains permission-gated and independent.

## Transport and proof boundary

Android uploads `android_notification` JSON through Even File Service: service `0xC4` commands, `0xC5` data, right-side file characteristic `00002760-08C2-11E1-9073-0E8AC72E7401`. START encodes file type, byte count, CRC32, and an 80-byte zero-padded filename. DATA opens then sends bytes, followed by RESULT_CHECK. Each phase expects a two-byte cid/status acknowledgement inside a CRC16-checked BLE frame. The notification file type is 1 and path is `user/notify_whitelist.json` (the firmware distinguishes content by file type).

`EvenFileService` isolates framing/ACK lifecycle from the driver, uses the shared BLE write executor, and accepts responses only from the current right GATT connection. An ambiguous timeout, cancellation, or write failure requires reconnect because ACKs carry no transaction id. A reconnect clears the old pending ACK. Notification IDs remain stable across updates for the driver lifetime, including reconnects; numeric phone IDs are mapped too. Because firmware card removal is not observable, IDs in the existing 2000–9999 range are never recycled. After 8,000 allocations (including anonymous notifications), new IDs fail with `notification_id_capacity_exhausted`; updates to known IDs still work. Recreating the driver or restarting the app does not guarantee reconciliation with retained firmware history. Disabled configurations still send the presentation-disable command but leave the firmware whitelist unchanged. Only enabled native presentation disables firmware filtering in favor of Android phone-side filtering. The pending queue is bounded to eight, with explicit dropped/cancelled outcomes.

The control protobuf carries enabled, automatic display, duration, and do-not-disturb settings. Android disables the firmware whitelist and applies the existing phone blocklist. iOS preserves the firmware filter. Controls are reported as submitted, not confirmed; correlated firmware refusals are observable.

The original PR introduced the reverse-engineered file schema. Local tests verify the implementation and failure boundaries; this rework has not yet been qualified on a physical G2. Neither a compile nor a mocked ACK proves current firmware behavior.

## iOS boundary

The iPhone provides ANCS to the glasses. G2 currently relays app identity to the Mentra App, without notification title/body. The public [Even SDK device APIs](https://hub.evenrealities.com/docs/build/device-apis) and published `@evenrealities/even_hub_sdk` 0.0.15 declarations expose no content relay. [ANCS](https://developer.apple.com/library/archive/documentation/CoreBluetooth/Reference/AppleNotificationCenterServiceSpecification/Specification/Specification.html) permits the accessory to request content; that does not establish a G2-to-phone relay command.

The SDK requests/reports accessory authorization and applies controls after connection and authorization changes. iOS uploads and nonempty phone-side app filters fail explicitly. No unverified notification-removal opcode is sent.

## Device qualification path

With a physical G2, repeat on Android and iPhone before merging this feature:

1. Pair, deny notification access/sharing, enable native mode in Notify settings, and verify useful permission guidance with no notification content exposed.
2. Grant access, start Notify, post a notification, and verify exactly one G2 popup and one history item while a foreground miniapp keeps running. Android: verify miniapp content forwarding independently. iOS: verify app identity is not presented as full content.
3. Turn popups off, then DND on/off and change duration. Confirm history and popup behavior on firmware; submission status alone is insufficient.
4. Android: block an app while messages are pending, burst more than eight messages, update the same id, and interrupt a transfer. Check cancellation/drop/failure events and reconnect recovery. Verify no old-connection ACK is accepted.
5. Stop Notify and disable native mode while work is pending. Verify no later popup, then reconnect and confirm the current disabled state is reapplied.
6. Revoke iPhone notification sharing and reconnect; confirm authorization status changes and no native presentation is enabled without authorization. Verify existing firmware app filtering stays intact.
7. Dismiss on the phone and confirm the UI's stated limitation: removal from G2 history is not yet supported. Do not treat an unchanged history item as successful synchronization.
