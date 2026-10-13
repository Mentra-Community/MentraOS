# Cloud V2 websites on Cloudflare Pages

MentraOS deploys two Cloud V2 browser surfaces:

| Surface | Local package | Pages project pattern | Hostname pattern |
| --- | --- | --- | --- |
| Admin console | `websites/admin` | `mentra-admin-<env>` | `admin.<env>.mentraglass.com` |
| Enterprise portal | `websites/portal` | `mentra-enterprise-portal-<env>` | `portal.<env>.mentraglass.com` |

Production hostnames omit the environment label:

| Surface | Production hostname |
| --- | --- |
| Admin console | `admin.mentraglass.com` |
| Enterprise portal | `portal.mentraglass.com` |

The Developer Console and the Store website are deployed by the Mentra Miniapp
Store service, not by MentraOS.

Use one Pages project per surface per environment. That keeps each website's
`CORE_URL` plain and prevents dev, staging, and production domains from
depending on branch-preview behavior.

## Branch to environment mapping

| Branch | Workflow target | Pages projects |
| --- | --- | --- |
| `dev` | dev | `mentra-admin-dev`, `mentra-enterprise-portal-dev` |
| `staging` | staging | `mentra-admin-staging`, `mentra-enterprise-portal-staging` |
| `main` | prod | `mentra-admin-prod`, `mentra-enterprise-portal-prod` |

The workflow can also be run manually from a PR branch with an explicit
environment and site selection. The environment comes from the website URL and
workflow target, not from UI controls inside the admin or portal.

Each website is a static React bundle plus a Pages Function at `/api/*`. The
function proxies API requests to `CORE_URL` so browser auth stays same-origin:

```text
browser -> https://admin.dev.mentraglass.com/api/... -> CORE_URL/api/...
```

Required Pages environment variable:

| Name | Example |
| --- | --- |
| `CORE_URL` | `https://core.dev.us-west-2.mentraglass.com` |

`bun run deploy:pages` refreshes `CORE_URL` for the selected Pages project
before uploading the static bundle.

The workspace portal's sidebar links to its environment's Developer Console.
`bun run deploy:pages` builds the portal with `DEVELOPER_CONSOLE_URL` from the
`developerConsoleUrls` map in `scripts/deploy-pages.ts`. Staging has no
Developer Console of its own yet and links to production's. A portal built
without `DEVELOPER_CONSOLE_URL`, such as a Private Cloud's, shows no link.

Deploy manually:

```bash
bun run deploy:pages dev
bun run deploy:pages staging admin
```

Attach custom domains through the Pages Domains API or Cloudflare dashboard.
Pages hostnames should be proxied HTTPS hostnames. UDP records are the only
Cloud V2 records that must be DNS-only.
