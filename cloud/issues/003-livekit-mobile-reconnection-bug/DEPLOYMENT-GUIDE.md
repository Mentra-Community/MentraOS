# Deployment Guide: LiveKit Mobile Reconnection Bug Fix

**Issue**: [003-livekit-mobile-reconnection-bug](./README.md)  
**Status**: Ready for deployment  
**Last Updated**: November 24, 2024

## Quick Summary

✅ **Completed**:

- Proto files synchronized and regenerated
- Go bridge binary built with GetStatus RPC support
- Always-replace logic implemented in JoinRoom
- Documentation updated

🚀 **Ready for**: Staging deployment and testing

## Deployment Steps

### 1. Deploy to Staging

#### A. Deploy Bridge First (Backwards Compatible)

```bash
# SSH into staging server
ssh staging-server

# Navigate to bridge directory
cd /path/to/cloud-livekit-bridge

# Backup current binary
cp cloud-livekit-bridge cloud-livekit-bridge.backup

# Upload new binary (from local machine)
# scp cloud/packages/cloud-livekit-bridge/cloud-livekit-bridge staging-server:/path/to/cloud-livekit-bridge/

# Stop bridge process
pm2 stop cloud-livekit-bridge
# or
systemctl stop cloud-livekit-bridge

# Replace binary
chmod +x cloud-livekit-bridge

# Start bridge process
pm2 start cloud-livekit-bridge
# or
systemctl start cloud-livekit-bridge

# Verify bridge is running
pm2 logs cloud-livekit-bridge --lines 50
# or
journalctl -u cloud-livekit-bridge -n 50 -f
```

#### B. Deploy Cloud (After Bridge is Stable)

```bash
# SSH into staging server
ssh staging-server

# Navigate to cloud directory
cd /path/to/cloud

# Pull latest code (includes proto file changes)
git pull origin main

# Install dependencies (if needed)
npm install

# Restart cloud process
pm2 restart cloud
# or
systemctl restart cloud

# Verify cloud is running
pm2 logs cloud --lines 50
# or
journalctl -u cloud -n 50 -f
```

### 2. Monitor Better Stack

#### Logs to Watch For (Success Indicators)

```
# Should see these logs after deployment:

[Bridge] Replacing existing bridge session (user_id=X, reason=new_join_request)
[Cloud] Bridge status fetched: {connected: false, participant_id: "", ...}
[Cloud] Joined LiveKit room: room-staging-X
[Cloud] AudioManager received PCM chunk (size=640)
```

#### Logs That Should Disappear

```
# Should NOT see these anymore:

ERROR: this.client.getStatus is not a function ❌
ERROR: JoinRoom returned failure: session already exists for this user ❌
```

#### Better Stack Queries

```
# Check for "session exists" errors (should be zero)
message:"session already exists for this user" AND env:staging

# Check for successful session replacements (should see on reconnections)
message:"Replacing existing bridge session" AND env:staging

# Check for GetStatus errors (should be zero)
message:"getStatus is not a function" AND env:staging

# Check for successful JoinRoom calls
message:"Successfully joined room" AND env:staging
```

### 3. Test Reconnection Scenarios

#### Test 1: Force Quit + Reconnect (Zombie Session Cleanup)

1. Connect mobile app to staging
2. Verify transcription working (speak and see captions)
3. Force quit mobile app (swipe up, don't just minimize)
4. Wait 5 seconds
5. Reopen mobile app
6. **Expected**: Transcription resumes within 2-3 seconds
7. **Check logs**: Should see "Replacing existing bridge session"

#### Test 2: Cloud Restart (Simulates Crash)

1. Connect mobile app to staging
2. On server: `pm2 restart cloud` (don't restart bridge)
3. Wait for cloud to fully restart (5-10 seconds)
4. Mobile should auto-reconnect
5. **Expected**: Transcription resumes automatically
6. **Check logs**: Should see "Replacing existing bridge session"

#### Test 3: Network Blip (Real-World Scenario)

1. Connect mobile app to staging
2. Toggle airplane mode ON for 2 seconds
3. Toggle airplane mode OFF
4. **Expected**: Mobile reconnects, transcription resumes
5. **Check logs**: Should see reconnection flow

### 4. Validation Checklist

After deployment, verify:

#### Bridge

- [ ] Bridge process is running
- [ ] No startup errors in logs
- [ ] GetStatus RPC responds successfully
- [ ] Health check endpoint working

#### Cloud

- [ ] Cloud process is running
- [ ] gRPC client initialized successfully
- [ ] Can call GetStatus without "not a function" error
- [ ] WebSocket connections accepted

#### Reconnection Flow

- [ ] Mobile can reconnect after force quit
- [ ] No "session already exists" errors
- [ ] See "Replacing existing bridge session" in logs
- [ ] Transcription resumes within 2-3 seconds
- [ ] PCM chunks flowing after reconnection

#### Better Stack Metrics

- [ ] Zero "session exists" errors in last 24 hours
- [ ] Zero "getStatus is not a function" errors in last 24 hours
- [ ] Session replacement logs appearing on reconnections
- [ ] No increase in error rates overall

## Rollback Plan

If issues occur after deployment:

### Option 1: Rollback Cloud Only (Recommended First)

```bash
# SSH into staging server
ssh staging-server

# Rollback cloud to previous version
cd /path/to/cloud
git checkout <previous-commit-hash>
npm install
pm2 restart cloud

# Bridge changes are safe to keep (backwards compatible)
```

### Option 2: Rollback Both Cloud and Bridge

```bash
# Rollback cloud (see above)

# Rollback bridge
cd /path/to/cloud-livekit-bridge
pm2 stop cloud-livekit-bridge
cp cloud-livekit-bridge.backup cloud-livekit-bridge
pm2 start cloud-livekit-bridge
```

### Option 3: Emergency Rollback (Fastest)

```bash
# Use process manager or orchestrator to rollback to previous deployment
# For Kubernetes:
kubectl rollout undo deployment/cloud
kubectl rollout undo deployment/cloud-livekit-bridge

# For Docker Compose:
docker-compose down
docker-compose up -d --scale cloud=2 --scale bridge=1 <previous-image-tag>
```

## Production Deployment

**Only deploy to production after**:

- [ ] Staging has been stable for 24+ hours
- [ ] All test scenarios pass
- [ ] No new errors in Better Stack
- [ ] Reconnection metrics improved (< 2s latency)

Follow the same steps as staging deployment, but:

1. Schedule during low-traffic window
2. Deploy to one production instance first (canary)
3. Monitor for 1 hour before full rollout
4. Have rollback plan ready

## Monitoring

### Key Metrics to Track

| Metric                       | Before Fix        | Target After Fix |
| ---------------------------- | ----------------- | ---------------- |
| "session exists" errors      | 375 in 7 days     | 0                |
| GetStatus errors             | ~50/day           | 0                |
| Reconnection success rate    | ~80%              | >99%             |
| Transcription resume latency | Never (broken)    | <3 seconds       |
| Zombie session count         | Growing unbounded | Always 0         |

### Alerts to Set Up

```
# Alert if "session exists" errors reappear
message:"session already exists for this user" count > 5 in 1 hour

# Alert if GetStatus errors reappear
message:"getStatus is not a function" count > 5 in 1 hour

# Alert if reconnection failures spike
message:"JoinRoom returned failure" count > 10 in 1 hour

# Alert if zombie sessions detected (manual query)
# Check bridge session count via HealthCheck endpoint
bridge_active_sessions > expected_user_count * 1.5
```

## Troubleshooting

### "GetStatus is not a function" still occurring

1. Verify proto file deployed to cloud server
2. Restart cloud process (proto changes need restart)
3. Check gRPC client initialization logs
4. Verify bridge binary was updated

### "Session already exists" still occurring

1. Verify bridge binary was updated (check file timestamp)
2. Verify bridge process restarted with new binary
3. Check bridge logs for "Replacing existing bridge session"
4. If not seeing replacement logs, bridge wasn't updated

### Transcription not resuming after reconnection

1. Check if JoinRoom succeeded (should see "Successfully joined room")
2. Verify AudioManager receiving PCM chunks
3. Check Soniox transcription stream status
4. Look for errors in TranscriptionManager

### Bridge crashes or high CPU usage

1. Check for goroutine leaks (old sessions not cleaned up)
2. Monitor memory usage (session map growing)
3. Review recent changes to session lifecycle
4. Roll back if unstable

## Support

For issues or questions:

- Check [README.md](./README.md) for full context
- Review [IMPLEMENTATION.md](./IMPLEMENTATION.md) for technical details
- Check [PROTO-REGENERATION-COMPLETE.md](./PROTO-REGENERATION-COMPLETE.md) for proto changes
- Better Stack logs: Search by userId or error message
- Contact: Isaiah or system architect

---

**Remember**: Deploy bridge first, then cloud. Always monitor Better Stack during deployment!
