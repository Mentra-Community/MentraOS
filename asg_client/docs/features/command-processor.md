# Command processor

How JSON commands from the phone (or from a debug intent) get routed to the right handler. This is the architecture under [ASG Client Command API](../ASG_CLIENT_API.md) — read that first if you just want the wire format.

Source: `app/src/main/java/com/mentra/asg_client/service/core/processors/`.

## Pipeline

```
BLE byte buffer ──┐
                  ▼
         CommandProtocolDetector  ─►  K900 protocol?  ─►  K900CommandHandler
                  │                                          (cs_pho, sr_tpevt, etc.)
                  ▼
              JSON parsed
                  ▼
            CommandParser
                  ▼
       CommandHandlerRegistry  ─►  ICommandHandler.handleCommand(type, data)
                  │
                  ▼
            ResponseSender  ─►  CommunicationManager.sendBluetoothResponse()
                                                  │
                                                  ├─►  K900BluetoothManager (BLE write)
                                                  └─►  IntentResponseBroadcaster (debug)
```

Components:

| Class                         | Responsibility                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `CommandProcessor`            | Orchestrator — single entry point; handles dedup and ACKs                                                   |
| `CommandProtocolDetector`     | Decides whether a payload is K900 wire format, JSON, or chunked, and unwraps as needed                      |
| `ChunkReassembler`            | Reassembles BLE-chunked messages                                                                            |
| `CommandParser`               | JSON → `JSONObject` with error handling                                                                     |
| `CommandHandlerRegistry`      | Map of `commandType` → `ICommandHandler`                                                                    |
| `ICommandHandler` (interface) | What every per-command handler implements                                                                   |
| `ResponseSender`              | Generic outbound wrapper                                                                                    |
| `K900CommandHandler`          | Handles inbound K900 protocol commands (`cs_pho`, `hs_ntfy`, etc.) — separate from the JSON command surface |

## Adding a new command

1. **Create the handler** under `service/core/handlers/` implementing `ICommandHandler`:

   ```java
   public class MyFooCommandHandler implements ICommandHandler {
       @Override public Set<String> getSupportedCommandTypes() {
           return Set.of("foo_do_thing");
       }
       @Override public boolean handleCommand(String type, JSONObject data) {
           // ...
           return true;
       }
   }
   ```

2. **Register it** in `CommandProcessor`'s constructor body alongside the other handlers (`commandHandlerRegistry.registerHandler(new MyFooCommandHandler(...))`).
3. **Document it** in [ASG_CLIENT_API.md](../ASG_CLIENT_API.md) — add a section with the request schema, response, and error cases.

That's the whole drill. The registry maps every string in `getSupportedCommandTypes()` to your handler, so a single handler can claim multiple command names.

## Two transports, one path

Both BLE-received and intent-received commands feed into `CommandProcessor.processJsonCommand(JSONObject)`. Behaviour is identical regardless of transport — useful for ADB testing without a phone.

- **BLE** — `K900BluetoothManager.onDataReceived` → `CommandProcessor.processCommand(byte[])`
- **Intent** — `IntentCommandReceiver.onReceive` → `CommandProcessor.processJsonCommand`

## ACK and dedup

If an inbound command includes an `mId` (long), `CommandProcessor` immediately echoes a `msg_ack` and stores the id in a 10-second window. Repeats within the window are ignored. This lets the phone safely retry without double-effects.

## K900 vs JSON

The phone speaks JSON to the glasses. The BES microcontroller speaks the K900 framed protocol — `{"C": "<cmd>", "B": {...}, "V": 1}` — over UART. Both flow through the same processor:

- JSON commands → `CommandHandlerRegistry` lookup by `type`
- K900 commands → `K900CommandHandler.processK900Command` switch by `C`

Some K900 commands trigger outbound JSON to the phone (e.g. `cs_pho` becomes a `button_press` event); see the [K900 passthrough table](../ASG_CLIENT_API.md#k900-protocol-passthroughs) for the full mapping.

## Logcat tags

| Tag                        | What                                           |
| -------------------------- | ---------------------------------------------- |
| `CommandProcessor`         | Top-level routing, ACK / dedup                 |
| `CommandHandlerRegistry`   | Handler registration, missing-handler warnings |
| `CommandProtocolDetector`  | Protocol detection decisions                   |
| `CommandParser`            | JSON parse errors                              |
| `K900CommandHandler`       | K900 dispatch                                  |
| `<Specific>CommandHandler` | The individual handler                         |
