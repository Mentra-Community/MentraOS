# The miniapp registry

The registry is Core's index of every miniapp URL the Mentra App has installed.
Every Core has one. It fills itself: each install of a miniapp URL registers
it, and Core verifies the URL before the install goes ahead. It is an index,
not a gate: the phone checks the domain rule, the manifest and the download
itself.

The code is in `packages/core/src/services/registry/` (`registry.service.ts`,
and the fetcher in `miniapp-fetcher.ts`), the phone's routes in
`packages/core/src/api/client/registry.api.ts`, and the wire shapes in
`@mentra/cloud-protocol` (`miniapp-registry.ts`). The Cloud Client calls them
as `cloud.core.registry`.

## What Core keeps

`miniapp_registry_entries` holds one entry per normalized URL. One package name
can have several URLs on its domain. Each entry has:

- the package name, name, version, age rating and icon URL;
- `verification`: `verified` when Core read the URL's `miniapp.json` itself (it
  keeps that copy in `manifest`), or `phone_reported` when it couldn't;
- `private`: the URL's server asks for sign-in;
- `status`: `active` or `archived`;
- who first registered it and when, and when Core last read it.

`miniapp_registry_archive_rules` holds the archive rules. Both collections are
built empty at startup with their indexes.

## The phone's calls

Both need the phone's Core access token. A missing, invalid or deleted one is
`401`.

`POST /api/client/registry/register` with `{url, reported?}` is sent at each
install. `reported` is what the phone read: `{packageName, name, version,
ageRating?}`. An archived URL, or one that can't be a miniapp, is answered for
any signed-in phone without reading it. Reading the URL needs an account with a
verified email (`403 email_unverified`), and each account may register 120 URLs
an hour (`429 rate_limited`, with `Retry-After`). Core answers:

| Result | When |
| --- | --- |
| `accepted`, with `entry` and Core's `manifest` | Core read a valid `miniapp.json` whose package name passes the domain rule. |
| `accepted_unverified`, with `entry` | Core couldn't read the URL. The entry comes from `reported`, after the same domain-rule check. |
| `not_a_miniapp`, with `reason` | `invalid_manifest`, `domain_mismatch`, `not_https` or `local_network_url`. Also `invalid_manifest` when Core couldn't read the URL and the phone sent no report. |
| `archived` | An archive rule covers the URL. |

`POST /api/client/registry/status` with `{entries: [{url, version}]}` (at most
500) is the updater's batch. Core answers `active`, `archived` or `unknown` for
each URL, in order, and `validForSeconds`. Any signed-in phone gets an answer,
so archiving stops updates on every phone.

## How Core verifies a URL

Core reads `<url>/miniapp.json` only through its fetcher, which takes public
HTTPS on port 443, refuses private and internal addresses, follows at most 3
redirects and reads at most 64 KB in 5 seconds. Core's network policy also
denies it outbound traffic to private ranges.

- **Not a miniapp.** An invalid `miniapp.json`, a package name its domain
  doesn't own, or a `404` or `410`. Core records nothing for a new URL.
- **Unreachable.** A host that doesn't resolve or resolves to a private
  address, a timeout, a `5xx`, a `401` without the sign-in challenge, a `403`,
  or a redirect to another domain. Core keeps the phone's report, labeled as
  reported by a phone. Such entries are never shown publicly.
- **Private.** A `401` with `WWW-Authenticate: Bearer realm="mentra",
  package="<packageName>"`. Core checks the package against the URL's domain,
  mints that package's miniapp token for the person registering (the token
  names their workspace only if that workspace assigned the package through
  Fleet), and retries once with no redirects. If the server refuses the token,
  Core records the URL as private with only the challenge's package name. A
  private entry's details are returned only to someone its server admitted in
  that request. An accepted answer describes what that request read, never
  what another request stored meanwhile.

A verified entry keeps what Core read until Core reads the URL again. A failed
read, a phone's report or a refused token doesn't replace it.

## Keeping entries current

There is no crawler. A status call re-verifies a URL off the request path when
the phone reports a version newer than the one Core recorded, or when Core
hasn't verified the entry yet. This happens at most once an hour per URL across
every Core instance, and only for phones whose account has a verified email.
Core reads a private URL with the token of the person whose phone asked.

## Archiving

An entry is archived when its status is `archived`, or when a rule names its
URL, its package name, its registrable domain, or the account that first
registered it. A rule also refuses URLs registered after it: Core checks the
rules before it reads a URL, and again once it knows the package name, and
records no entry for a URL a rule covers. It checks once more after it writes,
so a rule made while Core was reading the URL still refuses that install.

Archiving refuses new installs and stops updates. Installed copies keep running.
Removing a rule restores the entries no other rule covers. Organization Admins
archive in the admin portal, and the directory archives through Core's signed
service API.

## The admin portal

The admin portal's **Miniapp registry** page is the full registry, for
Organization Admins only: it needs `organization.registry.administer`, which
no operator key can carry. Its routes are under `/api/admin/registry`
(`packages/core/src/api/admin/registry.api.ts`), with the types in
`@mentra/workspace-contract` (`registry-admin.ts`):

| Route | What it does |
| --- | --- |
| `GET /entries?q=&status=&verification=&cursor=` | Every entry, most recently registered first, 50 to a page, with nothing redacted. `q` matches the URL, package name, name or domain as plain text, or the account that registered it by its Mentra user ID. |
| `GET /export` | Every entry as CSV, for App Review: URL, package, name, version, age rating, verification, private, status and dates. It names no account. |
| `POST /register` with `{urls}` | Registers 1 to 50 URLs as the Organization Admin, exactly as a phone's registration: Core reads each one, and a sign-in challenge gets the admin's own miniapp token. A URL Core can't read records nothing. Seeds Mentra's own listings. |
| `GET /coverage?kind=&value=` | How many entries a rule covers, and whether it exists. The page asks before it archives. |
| `POST /archive` with `{rule: {kind, value}, reason?}` | Archives by `url`, `package`, `domain` (a registrable domain) or `account` (a Mentra user ID). |
| `POST /unarchive` with `{rule}` | Removes the rule. |
| `GET /rules?cursor=` | The archive rules, newest first. |

Archiving, unarchiving, each registered URL and each export are recorded in the
admin audit log with the Organization Admin's email.

## Configuration

- `CLOUD_CORE_REGISTRY_STATUS_TTL_SEC`: the status answer's `validForSeconds`,
  from 1 to 604800 (a week). Default `21600` (6 hours). Any other value logs a
  warning and uses the default.

## Known limits

- Reading a URL for a registration needs a verified email in Core's copy of
  the account directory's answer. A Core without an account directory
  (`SUPABASE_URL` unset) has none, so its phones get `403 email_unverified`
  for any URL that isn't archived. Archived answers and status calls still
  work there.
