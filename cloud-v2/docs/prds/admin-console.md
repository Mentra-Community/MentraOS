# Admin Console PRD

**Status:** Draft for UI/UX design.
**Surface:** `admin.mentraglass.com`, `admin.dev.mentraglass.com`, `admin.staging.mentraglass.com`

## Purpose

The Admin Console is an internal Mentra operations surface. It is not a
developer console and not an enterprise customer portal. It exists so Mentra
admins can review miniapp submissions and triage incidents.

Normal developers publish miniapps through the CLI and view status in the
Developer Console. Only Mentra admins can approve submissions or publish into
the public Store.

## Primary Users

- Mentra app reviewer.
- Mentra admin operator.
- Mentra support or incident responder.
- Mentra internal admin owner.

## Product Principles

- Admin actions must be explicit and auditable.
- Review and incident workflows should be hard to confuse.
- The interface should feel like an internal operations console: dense enough to
  move quickly, but not cluttered.
- Do not expose developer-facing or enterprise-facing terminology unless it helps
  an admin make a decision.

## Core Concepts

### Hostname-Bound Environment

The Admin Console environment is determined by the hostname. There is no
in-app environment switcher and no admin-controlled environment editing.

- `admin.dev.mentraglass.com` manages the dev environment.
- `admin.staging.mentraglass.com` manages the staging environment.
- `admin.mentraglass.com` manages production.

The UI may show the current environment as read-only context, especially for
dangerous actions, but changing environments means opening the corresponding
hostname.

### Review Queue

Developers submit release versions for review. An admin reviews a specific
release, not the entire miniapp identity.

### Public Store Review

The public store review flow determines whether a release can be accepted,
rejected, or published for normal discovery/install.

### Incident System

Incident management replaces the old internal incident/review workflows over
time. It can be partially designed now even if implementation is phased.

## User Stories

### Admin Auth

- As a Mentra admin, I can sign in with an authorized admin account.
- As a non-admin user, I cannot access admin pages.
- As an admin, I can see my role/permission context.

### Miniapp Review

- As an app reviewer, I can see pending release submissions.
- As an app reviewer, I can open a submitted release.
- As an app reviewer, I can inspect package name, developer org, version,
  manifest summary, bundle metadata, and submitted notes.
- As an app reviewer, I can approve a release.
- As an app reviewer, I can reject or request changes with feedback visible to
  the developer.
- As an app reviewer, I can publish an accepted release when appropriate.
- As an app reviewer, I can see prior decisions for the same miniapp.

### Incidents

- As an incident responder, I can see a list of incidents.
- As an incident responder, I can open an incident detail page.
- As an incident responder, I can see linked user/device/session/package context
  when available.
- As an incident responder, I can add timeline notes.
- As an incident responder, I can update incident status.
- As a support viewer, I can inspect incidents without mutating review state.

### Audit

- As an admin owner, I can see a log of admin mutations.
- As an admin owner, I can see who approved, rejected, published, or moderated
  something.
- As an admin owner, I can inspect reason text attached to sensitive actions.

## Required Pages

1. Sign in.
2. Admin home.
3. Miniapp review queue.
4. Submission/release detail.
5. Incidents.
6. Incident detail.
7. Audit log.

## Page Notes

### Admin Home

Home should summarize operational queues, not marketing metrics:

- Pending reviews.
- Open incidents.
- Recent admin actions.

### Review Queue

The queue should prioritize:

- Package name.
- Developer org.
- Version.
- Submission age.
- Status.
- Assigned reviewer, if any.

### Submission Detail

The detail page should make the decision easy:

- Submitted metadata.
- Manifest summary.
- Bundle metadata.
- Assets/screenshots if available.
- Prior release history.
- Approve/reject/request changes actions.

### Incidents

Incidents may be WIP in v1, but the IA should reserve space for:

- List.
- Severity/status.
- Linked context.
- Timeline.

## Out of Scope for v1

- Developer org self-service.
- Enterprise trusted issuer management.
- Billing.
- Public app store browsing.
- Full incident migration if implementation is not ready.

## Designer Questions

- How should dangerous admin actions be confirmed without slowing routine review?
- What is the right density for internal tables?
- How should read-only environment context be presented so admins do not
  accidentally mutate prod?
- How should audit history appear without overwhelming the primary workflow?
