# MentraOS Maestro Tests

This directory contains Maestro E2E tests for the MentraOS mobile app.

## Prerequisites

1. Install Maestro:

```bash
curl -Ls "https://get.maestro.mobile.dev" | bash
```

2. Ensure you have a device/emulator running with the MentraOS app installed

## Running Tests

### Run all tests:

```bash
npm run test:maestro
```

### Run specific test:

```bash
maestro test .maestro/flows/01-auth-flow.yaml
```

### Run tests in CI mode:

```bash
npm run test:maestro:ci
```

## Test Structure

### Core UI Tests (No Hardware Required)

- `01-auth-flow.yaml` - Login/logout functionality
- `02-tab-navigation.yaml` - Bottom tab navigation
- `03-app-store.yaml` - Browse and install apps from store
- `05-no-internet-connection.yaml` - Offline error handling

### Simulated Hardware Tests

- `04b-mentra-live-adaptive-scan.yaml` - Direct Mentra Live scan, timeout help, and in-place retry
- `04-simulated-glasses-pairing.yaml` - Pairing flow with simulated glasses (built-in feature)
- `06-launch-app-simulated-glasses.yaml` - Launch Mira app on simulated glasses

### Helper Flows

- `helpers/login-helper.yaml` - Reusable login flow

## Environment Variables

- `MAESTRO_APP_ID` - App bundle ID (default: com.mentra.mentra)

## Writing New Tests

1. Create new `.yaml` file in `flows/` directory
2. Follow naming convention: `XX-test-name.yaml`
3. Add to `config.yaml` if needed
4. Use element IDs where possible for reliability
5. Use regex patterns for text that might vary

## Tips

- Use `takeScreenshot` to debug test failures
- Use `optional: true` for elements that might not always appear
- Use `runFlow` with `when` conditions for conditional logic
- Check `helpers/` for reusable flow components

## Troubleshooting

### Tests failing to find elements?

- Run with `maestro studio` for interactive debugging
- Check if element IDs are properly set in the app
- Verify text matches exactly (case-sensitive)

### Simulated features not working?

- Ensure simulated glasses option is available in the glasses pairing flow
- Check that the app can detect and connect to simulated devices

### Network tests failing?

- Some emulators don't properly support airplane mode toggle
- May need to manually test network scenarios
