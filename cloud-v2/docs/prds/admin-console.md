# Admin Console PRD

**Status:** Draft for UI/UX design.
**Surface:** `admin.mentraglass.com`, `admin.dev.mentraglass.com`, `admin.staging.mentraglass.com`

## Purpose

The Admin Console is an internal Mentra operations surface. It is not a
developer console and not an enterprise customer portal. It exists so Mentra
admins can triage incidents.

## Primary Users

- Mentra support or incident responder.
- Mentra internal admin owner.

## Product Principles

- Admin actions must be explicit and auditable.
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

### Incident System

Incident management replaces the old internal incident/review workflows over
time. It can be partially designed now even if implementation is phased.

## User Stories

### Admin Auth

- As a Mentra admin, I can sign in with an authorized admin account.
- As a non-admin user, I cannot access admin pages.
- As an admin, I can see my role/permission context.

### Incidents

- As an incident responder, I can see a list of incidents.
- As an incident responder, I can open an incident detail page.
- As an incident responder, I can see linked user/device/session/package context
  when available.
- As an incident responder, I can add timeline notes.
- As an incident responder, I can update incident status.
- As a support viewer, I can inspect incidents without changing them.

### Audit

- As an admin owner, I can see a log of admin mutations.
- As an admin owner, I can inspect reason text attached to sensitive actions.

## Required Pages

1. Sign in.
2. Incidents.
3. Incident detail.
4. Audit log.

## Page Notes

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

- How should dangerous admin actions be confirmed without slowing routine work?
- What is the right density for internal tables?
- How should read-only environment context be presented so admins do not
  accidentally mutate prod?
- How should audit history appear without overwhelming the primary workflow?
