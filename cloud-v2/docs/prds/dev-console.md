# Developer Console PRD

**Status:** Draft for UI/UX design.
**Surface:** `console2.mentraglass.com`, `console2.dev.mentraglass.com`, `console2.staging.mentraglass.com`

## Purpose

The Developer Console is the web home for miniapp developers. It is where a
developer signs in, manages their developer organization, views miniapps and
release history, creates API keys, and understands review/publishing status.

Miniapp creation and release publishing are CLI-first. The console should not
feel like a browser-based app builder. It should feel like a clean operational
dashboard for package ownership, releases, review status, team access, and CLI
access.

## Primary Users

- Independent miniapp developer.
- Developer working inside a team/org.
- Developer org owner/admin.
- CI/CD maintainer who needs API keys.

## Product Principles

- The CLI creates and publishes; the console observes, manages, and explains.
- Package identity should be obvious and trustworthy.
- Developers should never feel confused about which org owns a miniapp.
- Release state belongs to a release version, not to the whole miniapp.
- Design should be calm, sparse, and professional. Avoid fake analytics,
  placeholder dashboards, or "todo list" badges in production UI.

## Core Concepts

### Developer Org

A developer org owns a unique package prefix, such as:

```txt
com.example
io.acme
```

Every miniapp package created by that org must live under that prefix:

```txt
com.example.weather
com.example.notes
```

The prefix is chosen during onboarding. After miniapps exist, the prefix is
locked unless it is rejected during review. Reserved prefixes like `com.mentra`
cannot be claimed by arbitrary developers.

### Miniapp

A miniapp is the stable package identity. It can have many releases.

### Release

A release is a specific version and bundle. Release statuses may include:

- Draft
- Uploaded
- In review
- Changes requested
- Accepted
- Published
- Rejected
- Suspended
- Rolled back

The previous published release may remain live while a newer release is in
review or rejected.

### Console Environment vs Miniapp Channels

The console hostname selects the MentraOS backend environment. There should not
be an in-app environment switcher for normal developer use:

- `console2.dev.mentraglass.com` uses the dev backend/data.
- `console2.staging.mentraglass.com` uses the staging backend/data.
- `console2.mentraglass.com` uses the production backend/data.

This is separate from a developer's own release workflow. A developer using the
production console may still publish a beta/tester channel for their miniapp,
share that release with selected users, and later promote it to the production
channel. That beta channel is app release state, not a MentraOS infrastructure
environment.

### CLI Relationship

The CLI is the primary way to:

- Log in locally.
- Initialize local projects.
- Register miniapps.
- Validate package names.
- Build release bundles.
- Publish/upload releases.
- Submit releases for review.

The console should show CLI commands and status, but not duplicate the full CLI
creation flow as web forms in v1.

## User Stories

### Account and Org

- As a developer, I can sign in so I can access my developer workspace.
- As a new developer, I must create or join a developer org before seeing the
  main console.
- As an org owner, I can choose a globally unique package prefix during
  onboarding.
- As a developer, I can see which org I am currently viewing.
- As a developer in multiple orgs, I can switch orgs.
- As an org owner/admin, I can invite teammates.
- As an org owner/admin, I can remove teammates or pending invites.
- As a developer, I can see my org package prefix and whether it is unverified,
  verified, or rejected.

### Miniapps

- As a developer, I can view all miniapps owned by my current org.
- As a developer, I can open a miniapp detail page.
- As a developer, I can see the miniapp display name, package name, latest
  release, published release, and review state.
- As a developer, I can understand that new miniapps are created with the CLI.
- As a developer, I can see clear empty states when no miniapps exist.

### Releases

- As a developer, I can see release history for a miniapp.
- As a developer, I can see the status of each release version.
- As a developer, I can see review feedback when a release is rejected or changes
  are requested.
- As a developer, I can see bundle metadata such as version, uploaded time,
  uploader, bundle size/hash, and manifest summary.
- As a developer, I can distinguish the currently published release from a newer
  release that is in review.
- As a developer, I can publish or share a release to a beta/tester channel
  without replacing the production channel.
- As a developer, I can promote a beta release to the production channel after
  validation.
- As a developer, I can tell the difference between MentraOS backend
  environments and my miniapp's release channels.

### CLI Access

- As a developer, I can see how to install and run the CLI.
- As a developer, I can run `mentra login` and authorize the CLI through the
  browser.
- As a developer, I can see which org the CLI will publish under.
- As a developer, I can copy relevant CLI commands without visual noise.
- As a developer, I can understand when CLI login is enough versus when an API key
  is needed.

### API Keys

- As an org admin, I can create org-scoped API keys for CI/CD.
- As an org admin, I can name an API key so teammates know what uses it.
- As an org admin, I can see created API keys, last-used time, and created-by
  metadata.
- As an org admin, I can revoke API keys.
- As a developer, I can copy the API key once immediately after creation.

## Required Screens

1. Sign in.
2. Org onboarding.
3. Home.
4. Miniapps list.
5. Miniapp detail.
6. Release detail/history.
7. CLI and API keys.
8. Organization settings.
9. Team access.

## Screen Notes

### Sign In

Use the Mentra visual identity. The page should feel polished and focused.
Avoid sending users through a visually redundant second login page when possible.

### Org Onboarding

The package prefix choice should be explained here, not repeatedly throughout
the app. Once the org is created, the normal org settings page can simply show
the locked prefix.

### Home

The home screen should not be a fake analytics dashboard. It should orient the
developer around the real next actions:

- Use the CLI.
- View miniapps.
- Manage API keys if CI/CD is needed.
- Complete org setup if required.

### Miniapps List

The list should be compact and scannable:

- Miniapp display name.
- Package name, with org prefix visually distinct from suffix.
- Latest release/version.
- Current status.

Empty state should point the developer to CLI creation.

### Miniapp Detail

The detail page should emphasize package identity and release state. Release
rows should be aligned and easy to compare.

Release rows should show channel separately from review status. For example, a
release may be accepted and live on a beta channel while another accepted release
is still the production channel.

### CLI and API Keys

This page should explain two access modes:

- Interactive CLI login for local development.
- API keys for CI/CD and automation.

API key creation belongs in the console.

## Out of Scope for v1

- Creating a miniapp from a web form.
- Uploading bundles from a web form.
- Editing bundle-owned manifest fields in the console.
- Fake usage analytics.
- Public store marketing pages.
- Enterprise/OEM issuer management.
- Internal review queue or preinstall registry controls.
- In-app switching between MentraOS infrastructure environments.

## Designer Questions

- What is the cleanest way to show package prefix versus miniapp suffix?
- Should release status use pills, icons, or both?
- How should the CLI-first workflow be explained without turning the UI into
  documentation?
- What is the ideal empty state for an org with no miniapps?
- How should multiple orgs be selected without making the sidebar feel crowded?
- How should beta/tester channels be shown without implying a MentraOS
  environment switcher?
