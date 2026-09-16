# App accessibility contract

The Mentra App owns the accessible interaction surface. The harness never substitutes coordinates, icon glyphs, OCR or global mouse/keyboard input for a missing control. Fix the source and install the rebuilt app when a required control cannot be identified or activated.

Labels are localized human language. `testID` values are stable, locale-independent identifiers on the actual native control. IDs alone are insufficient: after installing a new build, inspect the native tree, require an exposed action and verify that invoking it changes the expected product state. Gesture wrappers can expose an element without connecting accessibility activation to their touch handler.

| Control | Identifier | Action / expected result |
| --- | --- | --- |
| Shared chevron Back | `navigation.back` | Press invokes the screen's existing back handler. |
| Minimize miniapp | `miniapp.minimize` | Press invokes the same handler as the minus icon; return to home, keeping the miniapp running. |
| Close miniapp | `miniapp.close` | Press invokes the existing close handler. |
| Open all miniapps | `home.allApps.open` | Press opens the all-apps sheet. |
| Search miniapps | `home.allApps.search` | Editable value updates the actual search/filter state. |
| Clear search | `home.allApps.clearSearch` | Press clears the query; only present for a nonempty query. Explicit accessibility activation and touch share the same clear handler. |
| Dismiss all-apps sheet | `home.allApps.close` | Press invokes the same sheet close operation as the backdrop. |
| Home miniapp launcher | `home.miniapp.<packageName>` | Press uses normal compatibility checks and launch logic. |
| All-apps miniapp launcher | `allApps.miniapp.<packageName>` | Same launch behavior, distinguished from the home grid behind the sheet. |
| Open running miniapps | `home.runningApps.open` | Accessible activation uses the same spring/open state as the tray's tap gesture. Android's empty tray retains its existing explanatory alert. |
| Running-miniapps container | `home.runningApps` | Scope for assertions; hidden from accessibility when closed. |
| Dismiss running-miniapps list | `home.runningApps.close` | Press invokes normal list dismissal. |
| Running miniapp card | `runningApps.miniapp.<packageName>` | Activate selects it; its accessible dismiss action invokes the existing close handler. |

The built-in bottom-sheet backdrop does not forward arbitrary view props to its native view in the installed library version. Its close target is therefore a real native Pressable child, with the library providing only backdrop animation and visibility. Do not move the ID onto a wrapper that drops it.

## Verify on an installed build

1. Install the Mentra App containing these source changes, and record its version/build. Build `320000235` predates them.
2. Run `bun run tools/mentra-e2e/run.ts inspect` from the repository root on each relevant screen. It prints identifiers, labels, roles and exposed actions.
3. With a miniapp open, run `bun run tools/mentra-e2e/run.ts run --suite accessibility-preflight`. This read-only check records evidence of the capsule contract; it does not yet prove that activation navigates.
4. Check that each required ID identifies one enabled native element in its active surface. Inspect hidden/underlying surfaces if multiple matches occur; fix their accessibility exposure instead of selecting by index.
5. Invoke the normal accessible action, then assert the visible destination or state change. A successful native return code alone does not establish working navigation.
6. Repeat with another desktop app in front. The driver must not activate Mentra or move the user's pointer.
7. Record screenshots/video and preserve failures. Only move a step from proposed to verified after this native check; only call the full suite qualified after three complete deterministic runs.

The current test runner supports `AXPress`, editable `AXValue`, and exposed page/scroll-to-visible actions. A future custom-action adapter must still name and invoke a real exposed accessibility action. There is no private route or test-only control endpoint in the app.

## Current evidence

The standalone helper compiles with Swift 6. Native negative checks reject a focus command, keyboard injection, mouse fallback, coordinate selectors, anonymous controls and a window-raise action without acting on the app. Mobile component tests verify both empty and populated tray activation through accessibility reaches the existing open state.

The installed local Release build now exposes the required controls, and three consecutive complete 70-step replays passed. The all-apps BottomSheet must not group its children into one accessible slider. Its backdrop close target needs explicit accessibility activation. The switcher's absolute cards need a parent with a measured height; a zero-height parent caused visible cards to disappear from the native accessibility tree. See README for final revision qualification.
