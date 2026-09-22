# Automated device testing moved

The harness, English routines, Mac/iPhone/Android drivers, recordings, firmware
setup/recovery and evidence uploader now live in the private
[Mentra-Automated-Testing repository](https://github.com/Mentra-Community/Mentra-Automated-Testing).
The initial migration is tracked in
[private PR #1](https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/1).

MentraOS retains the app builds and installer, CI request/dispatch integration,
Core result/claim APIs and admin results viewer. See the
[public integration guide](../../.github/DEVICE-ROUTINES.md).

Run records and firmware are not stored in either repository. Existing local
attempts and recovery keep their original frozen checkouts, claims and evidence;
removing the public source does not migrate or release that ownership.
