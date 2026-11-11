import assert from "node:assert/strict"
import test from "node:test"

import {pinnedPrBuildNumber, readAndroidReservations} from "./prepare-pr-mobile.mjs"

const marker = (code, owner = `monorepo-release-${code}`) => ({
  name: `mentra-android-version-code-${code}-${owner}.json`,
})
const reservations = async () => [
  {code: 310000774, owner: "a"},
  {code: 310000776, owner: "b"},
]

test("the Mentra App's Android PR build sits one above the latest reserved code", async () => {
  // A 3.4 PR build (family number 304007989) over beta 310000776.
  assert.deepEqual(
    await pinnedPrBuildNumber({platform: "android", familyNumber: 304007989, readReservations: reservations}),
    {buildNumber: 310000777, androidReservedFloor: 310000776, source: "reserved-floor"},
  )
  // Once families pass the borrowed codes, the family number wins.
  assert.deepEqual(
    await pinnedPrBuildNumber({platform: "android", familyNumber: 311003500, readReservations: reservations}),
    {buildNumber: 311003500, androidReservedFloor: 310000776, source: "family"},
  )
})

test("iOS and the Bluetooth example keep the family number without reading the ledger", async () => {
  const unread = async () => assert.fail("read the ledger")
  for (const options of [{platform: "ios"}, {platform: "android", app: "example"}]) {
    assert.deepEqual(await pinnedPrBuildNumber({...options, familyNumber: 304007989, readReservations: unread}), {
      buildNumber: 304007989,
    })
  }
})

test("the reservations come from the ledger's public index, with retries, and an unreadable index fails", async () => {
  const waits = []
  let calls = 0
  const readIndex = async (repository, tag) => {
    assert.deepEqual([repository, tag], ["Mentra-Community/MentraOS", "mentra-coordinated-asg"])
    calls += 1
    if (calls === 1) throw new Error("HTTP 503")
    return {assets: [marker(310000775), {name: "mentra-live-asg-302010007-abc.apk"}, marker(310000776)]}
  }
  assert.deepEqual(await readAndroidReservations({readIndex, wait: async (ms) => waits.push(ms)}), [
    {code: 310000775, owner: "monorepo-release-310000775"},
    {code: 310000776, owner: "monorepo-release-310000776"},
  ])
  assert.deepEqual(waits, [5000])
  await assert.rejects(
    readAndroidReservations({
      readIndex: async () => {
        throw new Error("HTTP 503")
      },
      wait: async () => {},
    }),
    /Could not read the Android version code reservations: HTTP 503/,
  )
})
