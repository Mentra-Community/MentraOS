# 004 Mobile Client (runtime transport)

**Scope:** only the part of the mobile client we own, the **runtime transport**:
the client-side connector that speaks the v2 runtime protocol to Mentra Runtime
Services. The OEM Toolkit (OEM Integration Toolkit and OEM UI Toolkit), the app
UI, and the glasses clients are out of scope (owned by other teams).

We own both ends of this transport: the wire contract lives in
[`../002-cloud-runtime/protocol.md`](../002-cloud-runtime/protocol.md), and the
client connector that implements it lives here.

## Services (subfolders)

- [`runtime-transport/`](./runtime-transport/): the v2 client connector (WS
  handshake plus REST commands plus UDP audio) per the runtime protocol.

## Related

- [`../002-cloud-runtime/`](../002-cloud-runtime/): the cloud half of the transport.
- [`../../mentra-overhaul-plan.md`](../../mentra-overhaul-plan.md)
