import {expect, test} from "bun:test"
import {ReportSlackDeliveryService, type ReportSlackDelivery} from "./report-slack-delivery.service"
import type {ReportSlackNotification} from "./report-slack.service"
const notification: ReportSlackNotification = {
  reportId: "rep-one",
  mentraUserId: "automation:test-run",
  kind: "automatic",
}
function store() {
  let row: ReportSlackDelivery | undefined
  return {
    get row() {
      return row
    },
    async read() {
      return row
    },
    async claim(_id: string, previous: ReportSlackDelivery | undefined, value: ReportSlackDelivery) {
      if (JSON.stringify(row) !== JSON.stringify(previous)) return false
      row = value
      return true
    },
    async settle(_id: string, id: string, value: ReportSlackDelivery) {
      if (row?.attemptId !== id) return false
      row = value
      return true
    },
    async due() {
      return row?.nextAttemptAt ? [notification] : []
    },
  }
}
test("concurrent completion and timer send one message and persist receipt", async () => {
  const repository = store()
  let sends = 0,
    release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const svc = new ReportSlackDeliveryService(repository, async () => {
    sends++
    await held
    return {ok: true, receipt: {channel: "C1", ts: "1.2"}}
  })
  const first = svc.complete(notification)
  await Promise.resolve()
  await Promise.resolve()
  const other = await svc.complete(notification)
  expect(other.state).toBe("sending")
  release()
  expect((await first).state).toBe("sent")
  expect(await svc.complete(notification)).toMatchObject({state: "sent", channel: "C1", ts: "1.2"})
  expect(sends).toBe(1)
})
test("refusal survives process restart, retry uses same message id, and timeout reconciles without duplicate post", async () => {
  const repository = store(),
    ids: string[] = []
  let now = 0,
    sends = 0,
    reads = 0
  const send = async (_notification: ReportSlackNotification, delivery?: {clientMessageId: string}) => {
    ids.push(delivery!.clientMessageId)
    return ++sends === 1 ? {ok: false, retryable: true} : {ok: false}
  }
  const reconcile = async () => {
    reads++
    return {ok: true, receipt: {channel: "C1", ts: "1.2"}}
  }
  const make = () => new ReportSlackDeliveryService(repository, send, reconcile, () => now)
  expect((await make().complete(notification)).state).toBe("pending")
  now = 60_000
  await make().tick()
  expect(repository.row?.state).toBe("uncertain")
  now = 120_000
  await make().tick()
  expect(repository.row).toMatchObject({state: "sent", ts: "1.2"})
  expect(ids[0]).toBe(ids[1])
  expect(sends).toBe(2)
  expect(reads).toBe(1)
})
test("unavailable reconciliation remains visible and never authorizes another post", async () => {
  const repository = store()
  let sends = 0,
    now = 0
  const svc = new ReportSlackDeliveryService(
    repository,
    async () => {
      sends++
      throw Error("Network response lost")
    },
    async () => ({ok: false}),
    () => now,
  )
  expect((await svc.complete(notification)).state).toBe("uncertain")
  now = 60_000
  expect((await svc.complete(notification)).state).toBe("uncertain")
  expect(repository.row?.error).toContain("unconfirmed")
  expect(sends).toBe(1)
})

test("complete empty reconciliation recovers a crash before send without blind reposting", async () => {
  const repository = store()
  let now = 0,
    sends = 0
  await repository.claim("rep-one", undefined, {
    state: "sending",
    attemptId: "crashed",
    startedAt: new Date(0).toISOString(),
    leaseUntil: new Date(30_000).toISOString(),
    nextAttemptAt: new Date(30_000).toISOString(),
  })
  const svc = new ReportSlackDeliveryService(
    repository,
    async () => {
      sends++
      return {ok: true, receipt: {channel: "C1", ts: "1.2"}}
    },
    async () => ({ok: false, retryable: true}),
    () => now,
  )
  now = 60_000
  await svc.tick()
  expect(repository.row).toMatchObject({state: "sent", ts: "1.2"})
  expect(sends).toBe(1)
})

test("an uncertain post cannot be reconciled or reposted to a changed configured channel", async () => {
  const repository = store()
  let channel = "C-original",
    sends = 0,
    reads = 0,
    now = 0
  const svc = new ReportSlackDeliveryService(
    repository,
    async () => {
      sends++
      return {ok: false}
    },
    async () => {
      reads++
      return {ok: false, retryable: true}
    },
    () => now,
    () => channel,
  )
  expect((await svc.complete(notification)).destination).toBe("C-original")
  channel = "C-new"
  now = 60_000
  await svc.tick()
  expect(sends).toBe(1)
  expect(reads).toBe(0)
  expect(repository.row?.destination).toBe("C-original")
})

test("ten destination-blocked overdue intents defer durably so later pending reports progress", async () => {
  const rows = new Map<string, ReportSlackDelivery>()
  let now = 120_000,
    sends = 0,
    reads = 0
  for (let index = 0; index < 10; index++)
    rows.set(`old-${index}`, {
      state: "uncertain",
      destination: "C-old",
      startedAt: new Date(0).toISOString(),
      nextAttemptAt: new Date(0).toISOString(),
    })
  rows.set("later-report", {state: "pending", nextAttemptAt: new Date(1000).toISOString()})
  const repository = {
    async read(id: string) {
      return rows.get(id)
    },
    async claim(id: string, previous: ReportSlackDelivery | undefined, value: ReportSlackDelivery) {
      if (JSON.stringify(rows.get(id)) !== JSON.stringify(previous)) return false
      rows.set(id, value)
      return true
    },
    async settle(id: string, attempt: string, value: ReportSlackDelivery) {
      if (rows.get(id)?.attemptId !== attempt) return false
      rows.set(id, value)
      return true
    },
    async due() {
      return [...rows]
        .filter(([, row]) => Date.parse(row.nextAttemptAt ?? "") <= now)
        .sort((a, b) => a[1].nextAttemptAt!.localeCompare(b[1].nextAttemptAt!))
        .slice(0, 10)
        .map(([reportId]) => ({...notification, reportId}))
    },
  }
  const service = () =>
    new ReportSlackDeliveryService(
      repository,
      async () => {
        sends++
        return {ok: true, receipt: {channel: "C-new", ts: "1.2"}}
      },
      async () => {
        reads++
        return {ok: false}
      },
      () => now,
      () => "C-new",
    )
  await service().tick()
  expect(sends).toBe(0)
  expect(rows.get("old-0")).toMatchObject({
    state: "uncertain",
    destination: "C-old",
    nextAttemptAt: new Date(180_000).toISOString(),
  })
  now += 30_000
  await service().tick()
  expect(rows.get("later-report")?.state).toBe("sent")
  expect(sends).toBe(1)
  expect(reads).toBe(0)
})
