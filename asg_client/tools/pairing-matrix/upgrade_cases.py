#!/usr/bin/env python3
"""Component-upgrade evidence for the pairing matrix (U3, U1).

These cases change BES only: published BES 26.10.11.0 to the PR BES, on the debug ASG
(needed for DebugBesOtaReceiver) and the latest MTK. They show that the PR BES migrates
an old-BES NV record. They are not the production upgrade. That sequence (ASG, then MTK,
then BES, release artifacts) is release-gate RG-UPG. R14 adoption on a real iPhone is
RG-UPG-iOS. U2 is not authored here.

A restored old BES is a valid baseline only when that old BES created the owner record:
unpair, confirm ownerless on the old BES (legacy advertisement, no MP marker), then pair.
A leftover PR-format NV record is not an old baseline.
"""

from __future__ import annotations

OLD_BES = "26.10.11.0"
COMPONENT_LABEL = (
    "component-upgrade evidence: BES only, debug ASG, latest MTK. "
    "Full production upgrade across ASG, MTK and BES is RG-UPG."
)


def legacy_advert(adv: dict | None) -> bool:
    """True for an advertisement with no MP / secure marker."""
    if not adv:
        return False
    mentra = adv.get("mentra") or {}
    return mentra.get("secure") is False and not adv.get("mp_marker")


def assess_u3(before: dict, after: dict) -> list:
    """Ownerless glasses stay ownerless across a BES-only upgrade. No pairing window.

    before/after keys: own (int), bes (str), adv (advert dict), window (bool, a pairing
    window was seen before MTK was ready).
    """
    checks = [
        ("label", True, COMPONENT_LABEL),
        ("old BES baseline", before.get("bes") == OLD_BES, str(before.get("bes"))),
        ("ownerless before the upgrade", before.get("own") == 0, str(before.get("own"))),
        ("legacy advertisement before the upgrade", legacy_advert(before.get("adv")), str(before.get("adv"))),
        ("still ownerless after the upgrade", after.get("own") == 0, str(after.get("own"))),
        ("BES version changed", bool(after.get("bes")) and after.get("bes") != before.get("bes"), str(after.get("bes"))),
        ("no pairing window before MTK ready", not after.get("window"), str(after.get("window"))),
        ("not advertising pairing after the upgrade", not (after.get("adv") or {}).get("mentra", {}).get("pairing"), ""),
    ]
    return checks


def assess_u1(before: dict, after: dict) -> list:
    """S22 owner under the old BES is kept across a BES-only upgrade.

    after keys also include: reconnect (bool), card (bool).
    """
    checks = [
        ("label", True, COMPONENT_LABEL),
        ("old BES baseline", before.get("bes") == OLD_BES, str(before.get("bes"))),
        ("S22 was owner before the upgrade", before.get("own") == 1 and before.get("s22_bond") is True, ""),
        ("owner record was created on the old BES", before.get("owner_created_on_old_bes") is True,
         "unpair, confirm ownerless on the old BES, then pair; a leftover PR NV record is not valid"),
        ("owner kept", after.get("own") == 1, str(after.get("own"))),
        ("S22 reconnects", after.get("reconnect") is True, ""),
        ("no owner-lost card", after.get("card") is not True, ""),
        ("no pairing window", not after.get("window"), ""),
        ("BES version changed", bool(after.get("bes")) and after.get("bes") != OLD_BES, str(after.get("bes"))),
    ]
    return checks


def verdict(checks: list) -> str:
    return "PASS" if all(ok for _, ok, _ in checks) else "FAIL"
