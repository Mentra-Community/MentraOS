# Cloud-v2 logs in BetterStack

Cloud-v2 pods write pino JSON to stdout (`LOG_STDOUT_JSON=true` in deployed
envs). A Vector DaemonSet on the cluster tails container stdout, filters to
cloud-v2 app containers, flattens the pino fields, and ships to BetterStack.
The app never ships logs itself; an in-process HTTP log transport buffers in
a worker thread and grows heap without bound under load.

## Sources

| Env | Source | id | Table | Retention |
| --- | --- | --- | --- | --- |
| dev | MentraCloud V2 - Dev | 2616420 | `mentracloud_v2_dev` | 30 days |

Staging/prod sources get created when their envs join shipping (deliberate
edit to the Vector filter + a routed sink per env, never a wildcard).

Source tokens live in Doppler: `cloud-v2/<env>` `BETTERSTACK_SOURCE_TOKEN`.
API credentials for source management live in Doppler `mentra-sre/dev`.

## Install / upgrade

See the header of `cloud-v2/infra/betterstack-logs/values.yaml` for the
exact `porter helm --cluster 5692` command. Re-run with `upgrade` instead of
`install` after editing values.

## Cost guard

The Vector filter (`starts_with(container_name, "cloud-dev-")`) is the only
thing bounding ingest. Renaming a Porter app or adding a service changes
container names; check the filter whenever that happens. Keep retention at
30 days unless there is a reason. Watch the source's ingest volume for the
first week after any change.

## Querying

Hot storage (last ~30 min, sub-second):

```sql
SELECT dt, level, message, package, module
FROM remote(t2616420_mentracloud_v2_dev_logs)
WHERE level = 'error' AND dt > now() - INTERVAL 30 MINUTE
ORDER BY dt DESC LIMIT 100
```

S3 storage (30 days, 3-5s per query, `_row_type = 1` for log rows):

```sql
SELECT dt, JSONExtractString(raw, 'message') AS msg
FROM s3Cluster(primary, t2616420_mentracloud_v2_dev_s3)
WHERE _row_type = 1
  AND JSONExtractString(raw, 'level') = 'error'
  AND dt > now() - INTERVAL 7 DAY
ORDER BY dt DESC LIMIT 200
```

Useful fields (flattened from pino): `level`, `message`, `package`
(core/runtime), `module` (e.g. audio-worker, soniox), `service`, plus
whatever structured fields the call site attached. Vector metadata is under
`_meta` (`kubernetes_pod`, `kubernetes_container`).

Auth investigations: `session created`, `session revoked`, and refresh
rejections all log from `package=core, service=session.service`; correlate
with the mobile client's `MENTRA AUTH:` lines by timestamp and session id
suffix.

## Log hygiene rules

- Everything goes through `createLogger(pkg)` from `@mentra/cloud-shared`
  (pino). No `console.*` in server code: it bypasses LOG_LEVEL and ships
  unstructured.
- Per-message/per-chunk paths must be throttled or at debug. The audio
  worker's feed heartbeat (1 line per 128 chunks per user) is the ceiling
  for steady-state chatter.
- No per-request HTTP access logging. Log outcomes and errors, not traffic.
