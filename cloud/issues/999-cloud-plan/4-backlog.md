# Backlog

Items that aren't actively being worked on yet. Flat list, no fake prioritization. Big projects link to their own plan docs.

**Last updated:** April 2, 2026

---

[← Overview](./1-overview.md) | [Shipped](./2-shipped.md) | [Tickets](./3-tickets.md) | **Backlog**

---

- SDK CI/CD pipeline. Automated npm publishing via changesets. Detailed plan exists in `cloud/issues/048-sdk-v3/sdk-cicd-plan.md` (on the 048 branch).
- SDK v3 announcement. Coordinated with MentraOS 3.0 announcement.
- Readiness probe observability. We have no visibility into when K8s marks the pod not-ready (readiness probe failure on `/health`). A transient failure causes REST 503s while WebSockets stay connected, which could cascade into full disconnection if the client tries to reconnect. Need to log when `/health` exceeds the 5s probe timeout and track ready/not-ready transitions.
- Cloud scaling: [plans/cloud-scaling.md](./plans/cloud-scaling.md)
- E2E testing (MentraClient, test harness): [plans/cloud-testing.md](./plans/cloud-testing.md)

---

[← Tickets](./3-tickets.md)
