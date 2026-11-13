# Cloud V2 websites on Cloudflare Pages

MentraOS deploys the admin console and the sign-in site:

| Surface | Local package | Pages project pattern | Hostname pattern |
| --- | --- | --- | --- |
| Admin console | `websites/admin` | `mentra-admin-<env>` | `admin.<env>.mentraglass.com` |

Production hostnames omit the environment label (`admin.mentraglass.com`).

The workspace portal (`portal.mentraglass.com`, the `mentra-enterprise-portal-<env>`
projects), the Developer Console and the Store website are separate, closed-source
sites, deployed outside MentraOS.

Use one Pages project per surface per environment. That keeps each website's
`CORE_URL` plain and prevents dev, staging, and production domains from
depending on branch-preview behavior.

## Branch to environment mapping

| Branch | Workflow target | Pages projects |
| --- | --- | --- |
| `dev` | dev | `mentra-admin-dev` |
| `staging` | staging | `mentra-admin-staging` |
| `main` | prod | `mentra-admin-prod` |

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

Deploy manually:

```bash
bun run deploy:pages dev
bun run deploy:pages staging admin
```

Attach custom domains through the Pages Domains API or Cloudflare dashboard.
Pages hostnames should be proxied HTTPS hostnames. UDP records are the only
Cloud V2 records that must be DNS-only.
