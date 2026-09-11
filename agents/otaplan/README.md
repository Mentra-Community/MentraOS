# OTA Update System Overhaul

## Overview
Complete plan for fixing the unreliable OTA updater across 400 deployed Android Smart Glasses.

**IMPORTANT**: Recovery worker is now a dedicated sidecar package: `com.mentra.recovery`.

## Documentation Structure

### Core Plans
1. **[ota-updater-update-plan.md](ota-updater-update-plan.md)** - Main implementation plan
2. **[ota-updater-complete-flow.md](ota-updater-complete-flow.md)** - Complete system flow diagram
3. **[ota-updater-v2-improvements.md](ota-updater-v2-improvements.md)** - Key improvements for v2

### Implementation Details
4. **[ota-updater-manager-code.md](ota-updater-manager-code.md)** - OtaUpdaterManager implementation
5. **[backup-apk-strategy.md](backup-apk-strategy.md)** - Backup and recovery strategy
6. **[ota-updater-self-update-plan.md](ota-updater-self-update-plan.md)** - Self-update mechanism details

## Implementation Checklist

### ASG Client v6 Changes
- [ ] Create `OtaUpdaterManager.java` class
- [ ] Add OTA Updater v2 APK to assets folder
- [ ] Register PackageInstallReceiver for auto-launch
- [ ] Test deployment mechanism
- [ ] Test recovery scenarios

### OTA Updater v2 Changes (versionCode: 2)
- [ ] **Migrate to Foreground Service architecture**
- [ ] Modify `OtaHelper.java` for multi-app support
- [ ] Add sequential update logic (no concurrent downloads)
- [ ] Implement backup creation for all updates
- [ ] Add retry logic with exponential backoff
- [ ] Test self-update capability
- [ ] Support both legacy and new version.json formats

### Backend Changes
- [ ] Create new version.json format with apps array
- [ ] Maintain legacy format during transition
- [ ] Upload OTA Updater v2 APK
- [ ] Test gradual rollout strategy

### Testing Plan
1. Test on single development device
2. Deploy to 5-10 beta devices
3. Monitor success rates
4. Full rollout to 400 devices

## Key Design Decisions

1. **Bundle in Assets**: Guarantees deployment without network dependency
2. **Sequential Updates**: One download at a time for slow WiFi
3. **Unified Backup**: Both apps create backups before updates
4. **Package Monitoring**: Auto-launch after installation
5. **No Hash Verification**: Trust bundled assets

## Risk Mitigation

- **Fallback**: Old OTA updater continues working if v2 fails
- **Recovery**: ASG client can redeploy from assets
- **Backups**: Both apps maintain backup APKs
- **Gradual Rollout**: Test on subset before full deployment

## Future Improvements (beyond v2)

- Add progress notifications
- Implement download resume capability with DownloadManager
- Add update scheduling options
- Add detailed telemetry/analytics

## CRITICAL REMINDER

**These are consumer devices with non-technical users. There is NO recovery via ADB. Every change must be thoroughly tested. We cannot fuck up.**