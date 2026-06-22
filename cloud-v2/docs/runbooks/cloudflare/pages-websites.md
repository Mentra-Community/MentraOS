# Cloud V2 websites on Cloudflare Pages

Cloud V2 has three browser surfaces:

| Surface | Local package | Pages project pattern | Hostname pattern |
| --- | --- | --- | --- |
| Developer console | `websites/console` | `mentra-console2-<env>` | `console2.<env>.mentraglass.com` |
| Admin console | `websites/admin` | `mentra-admin-<env>` | `admin.<env>.mentraglass.com` |
| Enterprise portal | `websites/portal` | `mentra-enterprise-portal-<env>` | `portal.<env>.mentraglass.com` |

Production hostnames omit the environment label:

| Surface | Production hostname |
| --- | --- |
| Developer console | `console2.mentraglass.com` |
| Admin console | `admin.mentraglass.com` |
| Enterprise portal | `portal.mentraglass.com` |

Use one Pages project per surface per environment. That keeps each website's
`CORE_URL` plain and prevents dev, staging, and production domains from
depending on branch-preview behavior.

Each website is a static React bundle plus a Pages Function at `/api/*`. The
function proxies API requests to `CORE_URL` so browser auth stays same-origin:

```text
browser -> https://console2.dev.mentraglass.com/api/... -> CORE_URL/api/...
```

Required Pages environment variable:

| Name | Example |
| --- | --- |
| `CORE_URL` | `https://core.dev.us-west-2.mentraglass.com` |

Deploy manually:

```bash
bun run deploy:pages dev
bun run deploy:pages staging console
```

Attach custom domains through the Pages Domains API or Cloudflare dashboard.
Pages hostnames should be proxied HTTPS hostnames. UDP records are the only
Cloud V2 records that must be DNS-only.
