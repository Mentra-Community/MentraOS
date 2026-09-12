---
status: completed
owner: mentra
---

# iOS SoftAP + ACS spike

**Verdict: FAIL for the V2 increment.** iOS stays on the existing ACS + Cloudflare WHEP path.
This is not a ship gate — the V2 SoftAP gate is Android only.

The failure is structural rather than a matter of remaining time, which is why the spike is being
closed rather than extended. Recording the reasoning so the next attempt starts from the actual
blocker instead of re-deriving it.

## What SoftAP needs from the platform

Two independent things, and they turn out to have very different answers on iOS:

1. **Network plane.** The phone must be *dual-homed*: joined to the glasses' internet-less hotspot
   for media, while its default route stays on cellular so ACS, Graph and the miniapp keep working.
   On Android this is one API — a `WifiNetworkSpecifier` request with `NET_CAPABILITY_INTERNET`
   removed. The join is scoped to our app; the system default never moves.
2. **Media plane.** We must own a `PeerConnection` that serves the local WHIP endpoint and hand its
   frames to ACS as a raw outgoing video stream.

## Media plane: portable

Not the blocker. The iOS module already links `WebRTC-SDK 137.7151.09` (the same pod the Mentra App
gets via LiveKit) and already owns an `RTCPeerConnection` in
[`WhepVideoSource.swift`](../../../mobile/modules/acs-meeting/ios/WhepVideoSource.swift), feeding
`AcsOutgoingVideo` exactly the way the Android ingest source does. Serving a local WHIP endpoint
instead of posting a WHEP offer is ordinary work on top of what is already there.

## Network plane: blocked

`NEHotspotConfigurationManager` is the only way an iOS app can join a Wi-Fi network, and it is
**device-wide** — the equivalent of the user tapping the network in Settings. There is no
app-scoped join, so there is no iOS analogue of the no-INTERNET `WifiNetworkSpecifier` request that
the Android path is built on. Per Apple's [TN3111](https://developer.apple.com/documentation/technotes/tn3111-ios-wifi-api-overview),
a temporary accessory network is `joinOnce = true`; both settings of that flag fail us:

| `joinOnce` | Behaviour on an internet-less AP | Why it fails a call |
|---|---|---|
| `true` | System removes the configuration when it cannot reach the internet; developers report disassociation within ~15 s | A call lasts minutes, not seconds |
| `false` | Association survives, but the device treats Wi-Fi as its network and local requests return `NSURLErrorNotConnectedToInternet` | Kills the ACS/Graph side of the call |

So iOS offers no supported way to hold an internet-less association while keeping cellular as the
default route. That alone ends the spike.

The libwebrtc side compounds it. The injected `ScopedNetworkChangeDetector` that made the Android
path work — telling libwebrtc about a network it would otherwise filter out for lacking
`NET_CAPABILITY_INTERNET` — has no iOS counterpart. iOS libwebrtc monitors the network through
`nw_path_monitor` (`RTCNetworkMonitor.mm`) and only learns interface *types* from the system path;
it cannot be handed a network the system is not already offering. libwebrtc's own
`NetworkBinderInterface` says as much, describing the bind hook as needed by "some operating
systems (like Android)".

`IP_BOUND_IF` does exist and iOS does support scoped routing, so pinning a socket to an interface is
possible in principle. It is not a way out here: Apple states there is no supported way to identify
which interface is the right one, and it would require reaching into socket creation inside the
WebRTC pod. Worth revisiting only if the network-plane blocker above is ever solved, since it is
useless on its own.

## What would change the verdict

- A Multipeer/`NWParameters.requiredInterface` peer-to-peer transport between glasses and phone,
  replacing the hotspot join entirely. This is the direction with an actual future on iOS, and it is
  a glasses-firmware conversation, not an app one.
- Glasses serving media over a path the phone can reach without joining their AP — the current
  Cloudflare WHEP path is exactly that, which is why it stays.

## Where this leaves iOS in V2

`joinScopedNetwork` and `videoSource.type == "softap"` keep throwing `NOT_IMPLEMENTED` in
[`AcsMeetingModule.swift`](../../../mobile/modules/acs-meeting/ios/AcsMeetingModule.swift), which is
deliberate: joining without a usable video source would connect a call and show the remote
participant a black tile with nothing in the logs to explain it.

Everything in V2 that is not SoftAP does ship on iOS. End-for-everyone is implemented natively
(`endForEveryone` on `AcsMeetingSession`, gated on the same `HANG_UP_FOR_EVERYONE` runtime
capability read through `CapabilitiesCallFeature`, subscribed so a mid-call promotion to presenter
is picked up), and `scopedNetworkInfo()` reports `available: false` so the host reads "this platform
has no scoped network" rather than "the prefix could not be described".
