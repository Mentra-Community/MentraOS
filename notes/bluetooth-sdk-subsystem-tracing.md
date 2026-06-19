# Bluetooth SDK Subsystem Tracing

This document maps the Bluetooth SDK command path and the stable trace logs that can be used to inspect subsystem inputs and outputs without hardcoding individual BLE command names in `logcat`.

## Logcat

Use the same tag on the phone and on Mentra Live:

```bash
# Optional but recommended before photo/video/streaming debugging. Camera paths
# can fill the default 256 KiB glasses log buffers quickly and make live logcat
# exit with "Unexpected EOF".
adb -s RFCX71TH0CR logcat -G 8M
adb -s 0123456789ABCDEF logcat -G 8M

# Live trace, no command-name grep needed.
adb -s RFCX71TH0CR logcat -v time -s MentraBleTrace:V
adb -s 0123456789ABCDEF logcat -v time -s MentraBleTrace:V

# Recent buffered trace without clearing logcat.
adb -s RFCX71TH0CR logcat -d -t 500 -v time -s MentraBleTrace:V
adb -s 0123456789ABCDEF logcat -d -t 500 -v time -s MentraBleTrace:V
```

For phone app logs, prefer a shell function over an alias so the phone serial is
used for both `pidof` and `logcat`:

```bash
PHONE=RFCX71TH0CR
PHONE_PKG=com.mentra.bluetoothsdk.example

logm() {
  local pid
  pid="$(adb -s "$PHONE" shell pidof -s "$PHONE_PKG" | tr -d '\r')"
  if [ -z "$pid" ]; then
    echo "No running process for $PHONE_PKG on $PHONE" >&2
    return 1
  fi
  adb -s "$PHONE" logcat --pid="$pid" -v time -s MentraBleTrace:V
}
```

For human-readable output, pipe the same trace into the formatter:

```bash
logm | ./scripts/ble-trace-pretty.mjs
logm | ./scripts/ble-trace-pretty.mjs --verbose
logm | ./scripts/ble-trace-pretty.mjs --pacific
logm | ./scripts/ble-trace-pretty.mjs --timezone America/Los_Angeles
```

Optional pretty helpers should pipe `logcat -v epoch` output into the formatter
so epoch timestamps can render in the system timezone. Use a `t` suffix for
explicit Pacific time:

```bash
logmp   # phone app, pretty, system timezone
logap   # glasses ASG client, pretty, system timezone
logmpt  # phone app, pretty, America/Los_Angeles
logapt  # glasses ASG client, pretty, America/Los_Angeles
```

Example pretty output:

```text
18:46:18.112  PHONE APP          app_lifecycle       module_create      event=module_create component=BluetoothSdkModule pid=21080 version=1.0+1 package=com.mentra.bluetoothsdk.example
18:46:19.403  GLASSES APP        app_lifecycle       service_create     event=service_create component=AsgClientService pid=3559 version=36.0+36 package=com.mentra.asg_client
18:46:21.683  SDK -> APP          sdk_event_dispatch   speaking_status     speaking=true
18:46:22.985  GLASSES -> PHONE    sdk_ble_event        k900:sr_vad         B.on=0
18:46:22.986  SDK -> APP          sdk_event_dispatch   speaking_status     speaking=false
```

Each trace line is structured:

```text
BLE_TRACE direction=<direction> layer=<boundary> source=<caller> type=<json type> bytes=<bytes> payload=<sanitized json>
```

Sensitive fields such as passwords, tokens, auth fields, secrets, and emails are redacted. The `type` field is extracted from JSON payloads automatically, including standard JSON messages wrapped inside the Mentra Live `C` envelope.

## Runtime Subsystems

```mermaid
flowchart TB
    subgraph Phone["Phone"]
        App["MentraOS / Partner app UI\nReact Native, Swift, or Kotlin"]
        AppState["App state and hooks\nsession, scan results, events"]
        CloudComms["MentraOS cloud comms\nWebSocket + REST"]
        SdkPublic["Bluetooth SDK public API\nscan, connect, requestPhoto, startStream"]
        SdkNative["Bluetooth SDK native runtime\nDeviceManager + SGC controller"]
        PhoneBle["Phone BLE transport\ncommand writer + event reader"]
    end

    subgraph Cloud["MentraOS Cloud"]
        CloudWs["Cloud WebSocket"]
        MiniApps["Mini apps / App SDK"]
        Storage["Cloud APIs and storage"]
    end

    subgraph Glasses["Mentra Live glasses"]
        AsgBle["ASG Bluetooth manager\nBLE input/output"]
        Router["ASG command router\nCommandProcessor"]
        Features["ASG feature services\ncamera, streaming, wifi, audio, LED"]
        Bes["BES / firmware side\ncamera/audio/control firmware"]
    end

    App --> AppState
    AppState --> SdkPublic
    SdkPublic --> SdkNative
    SdkNative --> PhoneBle
    AppState <--> CloudComms
    CloudComms <--> CloudWs
    CloudWs <--> MiniApps
    CloudWs <--> Storage
    PhoneBle <--> AsgBle
    AsgBle --> Router
    Router --> Features
    Features <--> Bes
    Features --> AsgBle
    AsgBle --> PhoneBle
    PhoneBle --> SdkNative
    SdkNative --> AppState
```

## BLE Command Path

```mermaid
flowchart LR
    App["Partner / MentraOS app\nReact Native or native UI"]
    SdkApi["Bluetooth SDK public API\nrequestPhoto, startStream, setMicState"]
    PhoneSdk["Phone SDK native runtime\nDeviceManager + SGC"]
    PhoneBle["Phone BLE wire\nMentraLive.sendJson / processJsonMessage"]
    AsgBle["ASG BLE manager\nBaseBluetoothManager"]
    AsgRouter["ASG command router\nCommandProcessor + handlers"]
    AsgFeature["ASG feature subsystems\ncamera, streaming, wifi, audio"]
    AsgOut["ASG response/event output\nMediaManager / CommunicationManager"]

    App -->|"API call"| SdkApi
    SdkApi -->|"typed request object"| PhoneSdk
    PhoneSdk -->|"JSON command"| PhoneBle
    PhoneBle -->|"BLE packet"| AsgBle
    AsgBle -->|"decoded JSON"| AsgRouter
    AsgRouter -->|"handler call"| AsgFeature
    AsgFeature -->|"status/event JSON"| AsgOut
    AsgOut -->|"BLE packet"| PhoneBle
    PhoneBle -->|"typed SDK event"| PhoneSdk
    PhoneSdk -->|"listener / hook update"| App
```

Every command follows this path, including the camera capture/upload commands.
For example `stop_video_recording` carries an optional `webhookUrl` + `authToken`
(supplied at stop time so the token is fresh when the upload runs), and
`start_video_recording` carries an optional `maxRecordingTimeMinutes` — these are
threaded JS → SDK native → BLE JSON exactly like `requestPhoto`'s `webhookUrl` /
`authToken`. An empty/absent `webhookUrl` means "keep the video on device, no
upload". See `agents/asg-video-webhook-upload.md`.

## Trace Boundaries

```mermaid
sequenceDiagram
    participant App as App UI
    participant SDK as Phone Bluetooth SDK
    participant PhoneBLE as Phone BLE link
    participant ASGBLE as ASG BLE manager
    participant Router as ASG command router
    participant Feature as ASG feature subsystem

    App->>SDK: startStream({ video: { fps } })
    SDK->>PhoneBLE: JSON command
    Note over PhoneBLE: MentraBleTrace<br/>direction=phone_to_glasses<br/>layer=sdk_ble_command
    PhoneBLE->>ASGBLE: BLE bytes
    Note over ASGBLE: MentraBleTrace<br/>direction=phone_to_glasses<br/>layer=asg_ble_input
    ASGBLE->>Router: parsed command
    Note over Router: MentraBleTrace<br/>direction=phone_to_glasses<br/>layer=asg_command_router
    Router->>Feature: handle command
    Feature->>ASGBLE: status/event JSON
    Note over ASGBLE: MentraBleTrace<br/>direction=glasses_to_phone<br/>layer=asg_ble_output
    ASGBLE->>PhoneBLE: BLE bytes
    Note over PhoneBLE: MentraBleTrace<br/>direction=glasses_to_phone<br/>layer=sdk_ble_event
    PhoneBLE->>SDK: typed event dispatch
    Note over SDK: MentraBleTrace<br/>direction=phone_to_app<br/>layer=sdk_event_dispatch
    SDK->>App: listener/hook update
```

## Boundary Meanings

- `app_lifecycle`: phone app / SDK module / foreground-service and ASG service lifecycle events. These make app restarts visible in the same trace stream as BLE commands.
- `sdk_ble_command`: command JSON generated by the phone Bluetooth SDK before it is sent over BLE.
- `sdk_ble_event`: decoded event JSON received by the phone Bluetooth SDK from the glasses.
- `sdk_event_dispatch`: typed SDK event emitted to React Native/native app listeners.
- `asg_ble_input`: raw JSON-like BLE input received by ASG client from the phone.
- `asg_command_router`: parsed ASG command routed to a subsystem handler.
- `asg_ble_output`: JSON response/event emitted by ASG client back to the phone.
