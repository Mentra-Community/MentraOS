# Enterprise Portal PRD

**Status:** Draft for UI/UX design.
**Surface:** `portal.mentraglass.com`, `portal.dev.mentraglass.com`, `portal.staging.mentraglass.com`

## Purpose

The Enterprise Portal is for OEM and enterprise partners who need to manage the
trusted identity issuers Mentra accepts for their organization.

This is separate from the Developer Console and Admin Console. A human might
have access to multiple surfaces, but the product concepts are different.

## Primary Users

- Enterprise/OEM organization owner.
- Enterprise/OEM technical admin.
- Enterprise/OEM viewer/support user.
- Mentra admin reviewing or approving enterprise org access.

## Product Principles

- Enterprise users should manage trust configuration, not backend service
  internals.
- Approved enterprise orgs can manage their own trusted issuers.
- The portal should not require users to understand internal backend service
  names.
- Runtime hosting mode is not a primary portal concept for v1.
- Configuration should feel careful and auditable, but not blocked behind
  unnecessary approval after the org itself is approved.

## Core Concepts

### Enterprise Org

An enterprise org represents an OEM or enterprise customer. Enterprise orgs are
separate from developer orgs.

New enterprise orgs require Mentra approval before users can manage trusted
issuers.

### Trusted Issuer

A trusted issuer is an auth issuer the enterprise controls. The portal stores:

- Environment name, such as `production`, `sandbox`, or `qa`.
- Issuer URL.
- JWKS URL.
- Enabled/disabled state.
- Validation status.

After an enterprise org is approved, trusted issuer creation and updates should
be self-serve. We trust approved enterprise admins to manage their own issuer
configuration.

### JWKS

JWKS is the public key endpoint Mentra services use to verify tokens from that
issuer. Users do not need a cryptography lesson, but the UI should help them
understand whether the URL is reachable and valid.

## Onboarding States

1. Signed out.
2. Signed in, no enterprise org.
3. Request to join existing org.
4. Request to create new org.
5. Pending approval.
6. Approved and active.
7. Disabled/rejected.

Pending users should see a clear waiting state, not a mostly empty dashboard.

## User Stories

### Account and Org Access

- As an enterprise user, I can sign in.
- As a new enterprise user, I can request access to an existing enterprise org.
- As a new enterprise user, I can request to create a new enterprise org.
- As an invited enterprise user, I can accept an invite.
- As a pending enterprise user, I can see that access is awaiting approval.
- As an approved enterprise admin, I can view my org profile.

### Trusted Issuers

- As an approved enterprise admin, I can create a trusted issuer.
- As an approved enterprise admin, I can name an issuer environment, such as
  `production`, `sandbox`, or `qa`.
- As an approved enterprise admin, I can enter an issuer URL.
- As an approved enterprise admin, I can enter a JWKS URL.
- As an approved enterprise admin, I can test whether the JWKS URL is reachable
  and valid.
- As an approved enterprise admin, I can update a trusted issuer.
- As an approved enterprise admin, I can disable a trusted issuer.
- As an approved enterprise admin, I can see whether an issuer is active,
  disabled, invalid, or failing validation.
- As an approved enterprise admin, I can manage multiple sandbox/test issuer
  environments.

### Team Access

- As an enterprise owner/admin, I can invite teammates.
- As an enterprise owner/admin, I can assign roles such as owner, admin, or
  viewer.
- As an enterprise owner/admin, I can remove teammates or pending invites.
- As a viewer, I can inspect issuer configuration but cannot edit it.

### Audit and Safety

- As an enterprise admin, I can see recent issuer changes.
- As an enterprise admin, I can see who changed an issuer and when.
- As an enterprise admin, I can understand when a JWKS URL is failing validation.
- As an enterprise admin, I can contact Mentra/support if the org is pending,
  rejected, or disabled.

## Required Pages

1. Sign in.
2. Enterprise onboarding.
3. Pending approval.
4. Enterprise home.
5. Trusted issuers list.
6. Trusted issuer create/edit.
7. Team access.
8. Audit/history.

## Page Notes

### Sign In

Use the same design language as the Developer Console, but label the product as
Enterprise Portal. Avoid making this look like a developer tool.

### Onboarding

The onboarding flow should ask whether the user wants to:

- Join an existing enterprise org.
- Request a new enterprise org.

Creating a new enterprise org should not immediately unlock configuration.
Mentra approval is required first.

### Pending Approval

The pending state should be a complete page with clear next steps:

- Request submitted.
- What Mentra is reviewing.
- Who to contact if urgent.

### Trusted Issuers

Issuer cards/table rows should show:

- Environment name.
- Issuer URL.
- JWKS URL.
- Status.
- Last checked time.
- Last updated by.

### Create/Edit Issuer

The form should be simple:

- Environment name.
- Issuer URL.
- JWKS URL.
- Test/validate action.
- Save action.

Do not ask the enterprise user to configure internal runtime/auth service
settings in v1.

## Out of Scope for v1

- Developer miniapp management.
- Public store review.
- Preinstalled miniapp registry.
- Billing/contract management.
- Runtime hosting mode configuration.
- Approval of each trusted issuer after org approval.
- Internal admin review screens.

## Designer Questions

- How should pending approval feel reassuring without implying instant access?
- Should trusted issuers be shown as a table, cards, or a hybrid?
- How should JWKS validation errors be shown for a technical admin?
- How much audit history should be visible inline versus behind a detail page?
- How should this portal visually relate to, but remain distinct from, Developer
  Console?
