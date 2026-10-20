/**
 * @fileoverview The licensed features in a person's miniapp token.
 *
 * `featuresFor` answers, at mint time, which features a person holds for one miniapp package. A person
 * holds a feature through:
 *
 *  - a license of their own (`owner: {type: "person", mentraUserId}`);
 *  - a seat in a workspace's license (`license_seats`, one document per assigned seat; a seat is deleted
 *    when its membership ends, so every seat found belongs to a current member);
 *  - a `CLOUD_CORE_ENABLED_FEATURES` entry for the package, which grants its feature to everyone
 *    (`enabled-features.ts`).
 *
 * A license counts only while it is in its term at `now` (`validFrom <= now < paidThrough`) and has not
 * ended (`endedAt` null). A feature reaches the token only when the package is among that feature's
 * `packages`; a feature for no package reaches no token.
 *
 * The lookups use the collections' indexes: personal licenses by `{"owner.type", "owner.mentraUserId"}`,
 * seats by `{mentraUserId}` and seated licenses by `_id`. A person with no seat (nearly everyone) costs
 * two queries, run together.
 *
 * It rejects when a lookup fails; the caller answers 503 rather than mint a token that lacks features the
 * person paid for.
 */

import {LicenseSeatModel} from "../../models/license-seat.model"
import {LicenseModel} from "../../models/license.model"
import {parseEnabledFeatures} from "./enabled-features"

/** The licenses in their term at `now` and not ended. */
function inTerm(now: Date) {
  return {endedAt: null, validFrom: {$lte: now}, paidThrough: {$gt: now}}
}

/**
 * The feature keys `mentraUserId` holds for `packageName` at `now`, sorted and unique.
 *
 * @throws If a license or seat lookup fails.
 */
export async function featuresFor(args: {mentraUserId: string; packageName: string; now: Date}): Promise<string[]> {
  const {mentraUserId, packageName, now} = args
  const keys = new Set<string>()

  for (const [key, packages] of parseEnabledFeatures()) {
    if (packages.has(packageName)) keys.add(key)
  }

  const [personal, seats] = await Promise.all([
    LicenseModel.find(
      {"owner.type": "person", "owner.mentraUserId": mentraUserId, ...inTerm(now)},
      {features: 1},
    ).lean(),
    LicenseSeatModel.find({mentraUserId}, {licenseId: 1}).lean(),
  ])
  const seated = seats.length
    ? await LicenseModel.find({_id: {$in: seats.map((seat) => seat.licenseId)}, ...inTerm(now)}, {features: 1}).lean()
    : []

  for (const license of [...personal, ...seated]) {
    for (const feature of license.features ?? []) {
      if (feature.packages?.includes(packageName)) keys.add(feature.key)
    }
  }
  return [...keys].sort()
}
