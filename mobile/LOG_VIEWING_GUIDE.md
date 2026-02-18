# MentraOS Log Viewing Operations Manual

## Mission: Enhanced Battlefield Visibility for Development Logs

### Quick Deploy Commands

#### Standard Color-Coded Logs

```bash
bun run dev:logs
```

**Benefits:** Color-coded by subsystem (CORE, SOCKET, MAN, LIVE, MIC)

#### Filter Specific Subsystems

```bash
# Only show CORE logs
bun run start 2>&1 | ./scripts/log-viewer.sh | grep "CORE:"

# Only show MIC-related activity
bun run start 2>&1 | ./scripts/log-viewer.sh | grep "MIC:"

# Only show SOCKET communication
bun run start 2>&1 | ./scripts/log-filter.sh "SOCKET"

# Multiple subsystems
bun run start 2>&1 | ./scripts/log-filter.sh "CORE|SOCKET|LIVE"
```

### Color Legend

| Subsystem | Color   | Purpose                        |
| --------- | ------- | ------------------------------ |
| `CORE:`   | Cyan    | Core system operations         |
| `SOCKET:` | Yellow  | WebSocket communications       |
| `MAN:`    | Magenta | Manager layer operations       |
| `LIVE:`   | Green   | K900/Live streaming operations |
| `MIC:`    | Blue    | Microphone system              |
| `ERROR`   | Red     | Error messages                 |
| `WARN`    | Orange  | Warning messages               |

### Advanced Tactics

#### Save Logs to File While Viewing

```bash
bun run start 2>&1 | tee dev-session.log | ./scripts/log-viewer.sh
```

#### Live Search Within Logs

```bash
bun run dev:logs | less -R  # Use /pattern to search, 'n' for next match
```

#### Monitor Specific Patterns

```bash
# Watch for VAD events
bun run start 2>&1 | ./scripts/log-viewer.sh | grep -i "vad"

# Track BLE characteristic changes
bun run start 2>&1 | ./scripts/log-viewer.sh | grep -i "characteristic"

# Monitor view state changes
bun run start 2>&1 | ./scripts/log-viewer.sh | grep -i "view state"
```

#### Split View (Requires tmux)

```bash
# Terminal 1: Full logs
tmux new-session -s logs 'bun run dev:logs'

# Terminal 2: Only errors
tmux split-window -h 'bun run start 2>&1 | grep -i error'
```

### Pro Tips

1. **Reduce Noise:** Use `grep -v` to exclude patterns

   ```bash
   bun run dev:logs | grep -v "Updating view state"
   ```

2. **Focus on Errors:** Quick error detection

   ```bash
   bun run start 2>&1 | ./scripts/log-viewer.sh | grep -E "(ERROR|Error|error)"
   ```

3. **Timestamp Logging:** Add timestamps

   ```bash
   bun run start 2>&1 | while IFS= read -r line; do echo "$(date '+%H:%M:%S') $line"; done | ./scripts/log-viewer.sh
   ```

4. **Context Lines:** Show lines around matches
   ```bash
   bun run start 2>&1 | ./scripts/log-viewer.sh | grep -A 3 -B 3 "ERROR"
   ```

### Performance Notes

- The log viewer script processes logs in real-time with minimal overhead
- Piping through multiple filters may introduce slight latency
- For high-volume logging sessions, consider writing to file first then filtering

### Troubleshooting

**Script not found?**

```bash
chmod +x mobile/scripts/log-viewer.sh mobile/scripts/log-filter.sh
```

**Colors not showing?**
Ensure your terminal supports ANSI colors (most modern terminals do).

**Port conflicts?**
The dev scripts handle port selection automatically. If needed, kill existing processes:

```bash
lsof -ti:8081 | xargs kill -9
```

## Mission Success Criteria

✅ Subsystems clearly identified by color  
✅ Ability to filter specific operational areas  
✅ Quick error detection and investigation  
✅ Reduced cognitive load during development
