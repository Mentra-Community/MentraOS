---
status: active
owner: aisraelov
---

# Alibaba Cloud China stack: what ran, and how it was shut down

The mainland-China deployment of MentraOS ran on Alibaba Cloud in
`cn-shenzhen` from April 2026. China was paused in July 2026, and the
compute side was torn down on 2026-10-01. It cost about $830/month while
idle. The ICP filing and the public `mentraglass.cn` site were kept, so the
stack can come back without redoing the regulatory work.

## Accounts

| Account | Holds | Cost after teardown |
| --- | --- | --- |
| Alibaba Cloud **International** | All compute, storage, Container Registry, the `mentraglass.cn` marketing site bucket | A few cents/month (one OSS bucket) |
| Aliyun **China** (domestic) | `mentraglass.cn` domain registration, Alibaba Cloud DNS for the zone, the ICP filing and public-security filing | ¥0 except the yearly domain renewal |

Terraform used both: the International account for resources and the
domestic account (provider alias `alicloud.domestic`) for DNS records.
Credentials for both live with the account owners, not in this repo.

## Source of truth for recreating it

All of it was Terraform in the private repo
[`Mentra-Community/Mentra-Infra`](https://github.com/Mentra-Community/Mentra-Infra),
under `regions/china/alibaba/`:

- `prod/`: the production stack below. Remote state is in OSS bucket
  `mentra-tfstate-china-prod` (`us-west-1`), key
  `china/alibaba/prod/terraform.tfstate`. The bucket was kept. Reuse this
  key: it still tracks the resources that survived the teardown (VPC,
  vswitches, security groups, DNS records in the domestic account,
  certificates). Run `terraform plan` first so the refresh drops the deleted
  resources, and reconcile any drift before `apply`. A fresh key would lose
  those bindings and try to create duplicates.
- `dev/`: the dev network and the **marketing site** that serves
  `mentraglass.cn`. Its state is not in the bucket above.
- `modules/`: `network`, `app` (ECI + Auto Scaling + ALB/NLB + optional
  MongoDB + logs), `acr`, `oss`, `oss-cname`, `static-website`, `ssl`
  (Let's Encrypt via ACME, uploaded to Alibaba Certificate Service), `naming`.

The pods ran Cloud V1 services, deployed by the since-removed
`china-deployment-prod.yml` and `china-deploy-static-websites-prod.yaml`
workflows. They pulled `prod/api`, `prod/caption` and
`prod/translation-api` images from the Container Registry over its VPC
endpoint. The registry is being released, and Cloud V1 is gone, so this
stack is a reference for the infrastructure shape, not something to
re-apply as-is. A future China deployment needs its own Cloud V2 regional
design; see
[the Cloud V2 workflow transition spec](../superpowers/specs/2026-08-28-cloud-workflow-transition.md).

## What the prod stack was

| Piece | Spec | Approx. $/month |
| --- | --- | --- |
| `api`, `caption`, `translation-api` | One ECI pod each (2 vCPU / 4 GiB), Auto Scaling group min=max=1 | 150 |
| `mentraos-prod-mongodb` | ApsaraDB for MongoDB 8.0 replica set, `mdb.shard.2x.xlarge.d`, 50 GB ESSD, pay-as-you-go | 457 |
| Container Registry | Enterprise Edition Basic, monthly subscription | 102 |
| Load balancers | 3 ALB (HTTP 80 / HTTPS 443, one per service) + 1 NLB (UDP 8000 for `udp-api`) | 52 |
| NAT gateways | Enhanced NAT for prod and dev private subnets, one EIP each | 42 |
| Public IPs | 2 EIPs per ALB, 2 for the NLB | 22 |
| Logs | SLS project `mentraos-prod-sls`, 30-day logstores per service | 4 |
| Static sites + assets | OSS buckets for `account`, `apps`, `console`, `translation`, `asset` with CNAMEs and certificates | 1 |

Network: VPC `10.20.0.0/16`, public subnets `10.20.0.0/24` and
`10.20.1.0/24`, private subnets `10.20.2.0/24` and `10.20.3.0/24`, across
zones `cn-shenzhen-d` and `cn-shenzhen-e`.

Hostnames (DNS in the domestic account): `api`, `udp-api`, `caption`,
`translation-api`, `account`, `apps`, `console`, `translation`, `asset`
under `mentraglass.cn`. The mobile app's `china` variant
(`EXPO_PUBLIC_DEPLOYMENT_REGION=china`, `com.mentra.mentra.cn`) points its
CDN at `asset.mentraglass.cn`.

Also in the account but unused by the stack: four ApsaraVideo Live test
domains (`streaming`, `streaming-arctc`, `testyash`, `testtwo`) and Model
Studio workspaces (no charges).

## What was kept, and why: ICP

The ICP filing (`ICP备2025487718号`) and the public-security filing belong
to the Shenzhen entity and the `mentraglass.cn` domain, not to any server.
Alibaba Cloud and MIIT do check that filed domains still serve a live site
from Alibaba Cloud mainland. A filing whose domain no longer resolves
there can be cancelled as an empty site, which means filing again from
scratch.

To prevent that, these stay up:

- OSS bucket `mentraos-dev-marketing-oss` (International account), serving
  `mentraglass.cn` and `www.mentraglass.cn` with the ICP and public-security
  numbers in the footer. Do not delete it, and do not `terraform destroy`
  the `dev/` root, which owns it.
- The `mentraglass.cn` domain and its DNS zone in the domestic account.
  Keep the domain renewed; if the domain lapses, the filing goes with it.

The original ICP service-code resources had already expired by June 2026:
the `mentra-ecs-icp-cnsz` ECS server (released 2026-04-27) and a Wanwang
virtual host (expired 2026-06-07). The filing stayed valid after both, so
ongoing compliance depends on the site, not on a server. If Alibaba sends
an ICP verification notice (备案核查) saying no eligible resource is
attached, the cheapest fix is a small mainland Simple Application Server
for about $5/month.

## Teardown (2026-10-01)

Done through the `aliyun` CLI against the International account. The
order matters:

1. Container Registry: auto-renew turned off. It expires on 2026-10-21 and
   is released afterwards.
2. Auto Scaling groups deleted with `ForceDelete`, which also removes their
   ECI pods. Deleting the pods first would make the groups start new ones.
3. MongoDB: release protection turned off, then the instance deleted. The
   instance was set to keep no backups after deletion, so nothing keeps
   billing. The data was confirmed not needed.
4. ALBs and the NLB deleted. Their auto-created EIPs went with them. Leftover
   server groups were deleted afterwards.
5. Prod and dev NAT gateways deleted, then their EIPs released.
6. SLS projects `mentraos-prod-sls` and `mentra-dev` deleted.
7. ApsaraVideo Live domains deleted.
8. Every OSS bucket except `mentraos-dev-marketing-oss` and
   `mentra-tfstate-china-prod` got an expire-everything-after-1-day
   lifecycle rule. Mainland buckets reject object listing on the public
   endpoint, so they can't be emptied from outside China directly.
9. The RAM AccessKey for `github-acr` (registry pushes from CI) was
   disabled. No workflow on `dev` uses it.

## Follow-ups

- [ ] After the lifecycle rules have run (allow 48h), delete the emptied
      buckets:
      `aliyun oss rm oss://<bucket> -b -f --region cn-shenzhen` for each of
      `cri-h675v46p9lj694l6-registry`, `mentra-dev-oss-backend-cnsz`,
      `mentraos-dev-account-oss`, `mentraos-dev-api-oss-public`,
      `mentraos-dev-console-oss`, `mentraos-dev-store-oss`,
      `mentraos-dev-translation-oss`, `mentraos-prod-account-oss`,
      `mentraos-prod-api-oss-public`, `mentraos-prod-apps-oss`,
      `mentraos-prod-console-oss` and `mentraos-prod-translation-oss`.
- [ ] After 2026-10-21, confirm the registry is released, then delete
      `cri-jqkk34lm32lg9ce7-registry` and the `cn-shenzhen.cr.aliyuncs.com`
      PrivateZone (still bound to the registry VPC; $0.45/month).
- [ ] Optional cleanup of free leftovers: VPCs, vswitches, security groups
      and IPv4 gateways for `mentraos-prod`, `mentraos-dev` and
      `mentra-dev-vpc-cnsh-a`.
- [ ] Remove the DNS records for the deleted services (`api`, `udp-api`,
      `caption`, `translation-api`) in the domestic account so they don't
      point at released load balancers.
- [ ] Remove the unused `ALIBABA_ACCESS_KEY_ID` / `_SECRET` / `_STS_ROLE_ARN`
      repository secrets.
- [ ] Check the 2026-10 bill. It should only cover the hours before
      teardown, about $30. From November, only the marketing bucket remains.
