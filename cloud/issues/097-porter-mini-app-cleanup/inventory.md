# 097 — Porter Mini App Cleanup

US Central is running **82 apps across 71 nodes**. Many may be stale. 8 pods are stuck Pending because they request 6GB RAM.

This doc inventories every app.
🟢 = keep,
🔴 = confirmed deprecated (from team doc or exact duplicate),
🟡 = needs team review.

---

## 🔴 Delete

These are confirmed deprecated per team doc, exact duplicates, or explicitly marked for removal.

🔴 **[cloud-livekit](https://dashboard.porter.run/apps/cloud-livekit?target=default&project=15081&cluster=4689)**
Created 2025-10-03
5 cores, 4 GB RAM
Running
[Mentra-Community/MentraOS](https://github.com/Mentra-Community/MentraOS)
LiveKit was removed from the codebase. Flagged in infra.md as legacy. Using 5 cores and 4 GB.

🔴 **[live-captions-global](https://dashboard.porter.run/apps/live-captions-global?target=default&project=15081&cluster=4689)** (US Central)
Created 2025-05-08
3 cores, 4 GB
Pending
[AugmentOS-Community/LiveCaptionsOnSmartGlasses](https://github.com/AugmentOS-Community/LiveCaptionsOnSmartGlasses)
Old AugmentOS repo. Pending — can't schedule. `captions` is the current prod app.

🔴 **[live-captions-prod](https://dashboard.porter.run/apps/live-captions-prod?target=default&project=15081&cluster=4689)**
Created 2025-04-01
1 core, 1 GB
Running
[AugmentOS-Community/Live-Captions](https://github.com/AugmentOS-Community/Live-Captions)
Old AugmentOS repo. `captions` is the replacement.

🔴 **[live-captions-dev](https://dashboard.porter.run/apps/live-captions-dev?target=default&project=15081&cluster=4689)**
Created 2025-04-01
1 core, 1 GB
Running
[AugmentOS-Community/Live-Captions](https://github.com/AugmentOS-Community/Live-Captions)
Same old AugmentOS repo as live-captions-prod.

🔴 **[mentra-stream-staging](https://dashboard.porter.run/apps/mentra-stream-staging?target=default&project=15081&cluster=4689)**
`com.mentra.streamer.beta`
Created 2026-01-07
1 core, 1 GB
Running
[Mentra-Community/MentraOS-LiveStreaming-App](https://github.com/Mentra-Community/MentraOS-LiveStreaming-App) `staging` branch
Same package name as mentra-stream-beta. Pure duplicate.

🔴 **[live-stream](https://dashboard.porter.run/apps/live-stream?target=default&project=15081&cluster=4689)**
`com.mentra.livestream`
Created 2025-08-05
1 core, 1 GB
Running
[Mentra-Community/RtmpStreamExampleBasic](https://github.com/Mentra-Community/RtmpStreamExampleBasic)
Deprecated per team doc.

🔴 **[streamer-app](https://dashboard.porter.run/apps/streamer-app?target=default&project=15081&cluster=4689)**
`com.mentra.streamer`
Created 2025-08-21
1 core, 1 GB
Running
[Mentra-Community/streamer](https://github.com/Mentra-Community/streamer)
Deprecated per team doc. Old repo, same package name as the current mentra-stream.

🔴 **[streamer-app-aryan](https://dashboard.porter.run/apps/streamer-app-aryan?target=default&project=15081&cluster=4689)**
`dev.streamer.aryan`
Created 2025-11-26
1 core, 1 GB
Running
[Mentra-Community/MentraOS-LiveStreaming-App](https://github.com/Mentra-Community/MentraOS-LiveStreaming-App) `live-stream-aryan` branch
Deprecated per team doc.

🔴 **[streamer-dev](https://dashboard.porter.run/apps/streamer-dev?target=default&project=15081&cluster=4689)**
`com.mentra.streamer.dev`
Created 2025-11-17
1 core, 1 GB
Running
[Mentra-Community/MentraOS-LiveStreaming-App](https://github.com/Mentra-Community/MentraOS-LiveStreaming-App) `dev` branch
Deprecated per team doc. Replaced by mentra-stream-dev.

🔴 **[streamer-staging](https://dashboard.porter.run/apps/streamer-staging?target=default&project=15081&cluster=4689)**
`com.mentra.streamer.beta`
Created 2025-12-30
1 core, 1 GB
Running
[Mentra-Community/MentraOS-LiveStreaming-App](https://github.com/Mentra-Community/MentraOS-LiveStreaming-App) `staging` branch
Deprecated per team doc. Replaced by mentra-stream-staging.

🔴 **[mentra-notes-dev](https://dashboard.porter.run/apps/mentra-notes-dev?target=default&project=15081&cluster=4689)**
`com.aryan.note`
Created 2026-02-09
1 core, 3 GB
Running
[Mentra-Community/Mentra-Note](https://github.com/Mentra-Community/Mentra-Note) `dev` branch
Deprecated per team doc. Wrong package name (`com.aryan.note`), not registered in the org.

🔴 **[notes-aryan](https://dashboard.porter.run/apps/notes-aryan?target=default&project=15081&cluster=4689)**
`com.aryan.note`
Created 2025-10-27
1 core, 1 GB
Running
[MentraLabs/Notes-App](https://github.com/MentraLabs/Notes-App)
Deprecated per team doc. Not in org, old repo.

🔴 **[live-translation](https://dashboard.porter.run/apps/live-translation?target=default&project=15081&cluster=4689)**
`dev.augmentos.livetranslation`
Created 2025-06-10
1 core, 1 GB
Running
[AugmentOS-Community/LiveTranslationOnSmartGlasses](https://github.com/AugmentOS-Community/LiveTranslationOnSmartGlasses)
Marked as "Probably?" in team doc. Old AugmentOS repo.

🔴 **[live-translation-prod](https://dashboard.porter.run/apps/live-translation-prod?target=default&project=15081&cluster=4689)**
Created 2025-05-20
1 core, 1 GB
Running
[AugmentOS-Community/LiveTranslationOnSmartGlasses](https://github.com/AugmentOS-Community/LiveTranslationOnSmartGlasses)
Deprecated per team doc. Env not even set on Porter.

🔴 **[live-translation-aryan](https://dashboard.porter.run/apps/live-translation-aryan?target=default&project=15081&cluster=4689)**
`com.aryan.translastion`
Created 2025-10-07
1 core, 1 GB
Running
[Mentra-Community/LiveTranslationOnSmartGlasses](https://github.com/Mentra-Community/LiveTranslationOnSmartGlasses) `live-translation-aryan` branch
Deprecated per team doc.

🔴 **[mira-aryan](https://dashboard.porter.run/apps/mira-aryan?target=default&project=15081&cluster=4689)**
Created 2025-10-08
1 core, 1 GB
Running
[Mentra-Community/Mira](https://github.com/Mentra-Community/Mira)
Deprecated per team doc.

🔴 **[recorder-livekit](https://dashboard.porter.run/apps/recorder-livekit?target=default&project=15081&cluster=4689)**
Created 2025-09-17
1 core, 1 GB
Running
[Mentra-Community/Recorder](https://github.com/Mentra-Community/Recorder)
LiveKit branch. LiveKit was removed from the codebase.

🔴 **[soga](https://dashboard.porter.run/apps/soga?target=default&project=15081&cluster=4689)**
Created 2026-01-15
1 core, 1 GB
Running
[Drakonheart/MongoDB-26Hk](https://github.com/Drakonheart/MongoDB-26Hk)
External contributor (Drakonheart).

🔴 **[soga-docker](https://dashboard.porter.run/apps/soga-docker?target=default&project=15081&cluster=4689)**
Created 2026-01-15
1 core, 1 GB
Running
[Drakonheart/MongoDB-26Hk](https://github.com/Drakonheart/MongoDB-26Hk)
Same repo as soga. External contributor (Drakonheart).

🔴 **[soga-dev](https://dashboard.porter.run/apps/soga-dev?target=default&project=15081&cluster=4689)**
Created 2026-01-15
1 core, 1 GB
Running
No git repo attached.
No git repo. External contributor (Drakonheart).

🔴 **[songs-dev](https://dashboard.porter.run/apps/songs-dev?target=default&project=15081&cluster=4689)**
Created 2025-08-04
1 core, 1 GB
Running
[isaiahb/songs](https://github.com/isaiahb/songs)
Personal repo.

🔴 **[sega](https://dashboard.porter.run/apps/sega?target=default&project=15081&cluster=4689)**
Created 2026-01-31
1 core, 1 GB
Running
[isaiahb/sega](https://github.com/isaiahb/sega)
Personal repo.

🔴 **[live-captions-global](https://dashboard.porter.run/apps/live-captions-global?target=default&project=15081&cluster=4754)** (East Asia)
Created 2025-05-08
[AugmentOS-Community/LiveCaptionsOnSmartGlasses](https://github.com/AugmentOS-Community/LiveCaptionsOnSmartGlasses)
Old repo. Might be replaced by `captions`.

🔴 **[live-captions-global-dev](https://dashboard.porter.run/apps/live-captions-global-dev?target=default&project=15081&cluster=4754)** (East Asia)
Created 2025-05-29
[AugmentOS-Community/LiveCaptionsOnSmartGlasses](https://github.com/AugmentOS-Community/LiveCaptionsOnSmartGlasses)
Dev build on a production region.

🔴 **[live-captions-global](https://dashboard.porter.run/apps/live-captions-global?target=default&project=15081&cluster=4977)** (US East)
Created 2025-07-09
[Mentra-Community/LiveCaptionsOnSmartGlasses](https://github.com/Mentra-Community/LiveCaptionsOnSmartGlasses)
Captions for US East users.

---

## 🟡 Needs Review

These need team input before any action.

🟡 **[mentra-dash](https://dashboard.porter.run/apps/mentra-dash?target=default&project=15081&cluster=4689)**
Created 2025-07-11
1 core, 1 GB
Running
[Mentra-Community/Dash](https://github.com/Mentra-Community/Dash)
Different repo from `dashboard`. Duplicate or replacement?

🟡 **[live-streaming-app](https://dashboard.porter.run/apps/live-streaming-app?target=default&project=15081&cluster=4689)**
`org.roger.test-rtmp-streamer-2`
Created 2025-06-08
1 core, 1 GB
Running
[AugmentOS-Community/TestLiveStreamingApp](https://github.com/AugmentOS-Community/TestLiveStreamingApp)
Marked as "?" in team doc. Not in org.

🟡 **[unmanaged-rtmp-stream](https://dashboard.porter.run/apps/unmanaged-rtmp-stream?target=default&project=15081&cluster=4689)**
`com.mentra.unmanagedrtmpstream`
Created 2025-07-28
1 core, 1 GB
Running
[Mentra-Community/UnmanagedRtmpStream](https://github.com/Mentra-Community/UnmanagedRtmpStream)
Marked as "?" in team doc.

🟡 **[notes-isaiah](https://dashboard.porter.run/apps/notes-isaiah?target=default&project=15081&cluster=4689)**
`com.mentra.notes.isaiah`
Created 2026-02-06
1 core, 1 GB
Running
[Mentra-Community/Mentra-Note](https://github.com/Mentra-Community/Mentra-Note) `isaiah` branch
Marked as "?" in team doc.

🟡 **[mentra-ai-prod](https://dashboard.porter.run/apps/mentra-ai-prod?target=default&project=15081&cluster=4689)**
Created 2026-01-30
1 core, 1 GB
Running
[Mentra-Community/Mentra-AI](https://github.com/Mentra-Community/Mentra-AI)
Is v1 replaced by mentra-ai-2?

🟡 **[mentra-ai-dev](https://dashboard.porter.run/apps/mentra-ai-dev?target=default&project=15081&cluster=4689)**
Created 2026-01-05
1 core, 1 GB
Running
[Mentra-Community/Mentra-AI](https://github.com/Mentra-Community/Mentra-AI)
Same question.

🟡 **[mira](https://dashboard.porter.run/apps/mira?target=default&project=15081&cluster=4689)**
Created 2025-04-06
1 core, 1 GB
Running
[AugmentOS-Community/Mira](https://github.com/AugmentOS-Community/Mira)
Old AugmentOS repo. Replaced by mentra-ai?

🟡 **[mira-dev](https://dashboard.porter.run/apps/mira-dev?target=default&project=15081&cluster=4689)**
Created 2025-12-31
1 core, 1 GB
Running
[Mentra-Community/Mira](https://github.com/Mentra-Community/Mira)
Is anyone using this?

🟡 **[mira-faster](https://dashboard.porter.run/apps/mira-faster?target=default&project=15081&cluster=4689)**
Created 2025-09-30
1 core, 1 GB
Running
[Mentra-Community/Mira](https://github.com/Mentra-Community/Mira)
Experimental branch.

🟡 **[camera-photo-staging](https://dashboard.porter.run/apps/camera-photo-staging?target=default&project=15081&cluster=4689)**
Created 2026-02-15
1 core, 1 GB
Running
[Mentra-Community/MentraOS-Camera-Example](https://github.com/Mentra-Community/MentraOS-Camera-Example)
Is staging needed separately?

🟡 **[camera-photo-example](https://dashboard.porter.run/apps/camera-photo-example?target=default&project=15081&cluster=4689)**
Created 2025-07-07
1 core, 1 GB
Running
[Mentra-Community/photo-taker](https://github.com/Mentra-Community/photo-taker)
Older example. camera-photo-prod may be the replacement.

🟡 **[mentra-live-template-app](https://dashboard.porter.run/apps/mentra-live-template-app?target=default&project=15081&cluster=4689)**
Created 2025-11-28
1 core, 1 GB
Running
[Mentra-Community/MentraOS-Camera-Example](https://github.com/Mentra-Community/MentraOS-Camera-Example)
Same repo as camera-photo but different name. Stale?

🟡 **[recorder-dev](https://dashboard.porter.run/apps/recorder-dev?target=default&project=15081&cluster=4689)**
Created 2025-12-31
1 core, 1 GB
Running
[Mentra-Community/Recorder](https://github.com/Mentra-Community/Recorder)
Keep if actively used.

🟡 **[docker](https://dashboard.porter.run/apps/docker?target=default&project=15081&cluster=4689)**
Created 2026-04-06
100m CPU, 400 MB
Running
[Mentra-Community/GoogleMeet](https://github.com/Mentra-Community/GoogleMeet)
Same repo as mentra-call-dev, earlier deployment. Stale?

🟡 **[docker-1](https://dashboard.porter.run/apps/docker-1?target=default&project=15081&cluster=4689)**
Created 2026-04-06
100m CPU, 400 MB
Running
[Mentra-Community/GoogleMeet](https://github.com/Mentra-Community/GoogleMeet)
Appears to be a duplicate of docker.

🟡 **[navigation](https://dashboard.porter.run/apps/navigation?target=default&project=15081&cluster=4689)**
Created 2025-06-25
1 core, 1 GB
Running
[Mentra-Community/Navigation](https://github.com/Mentra-Community/Navigation)
Is navigation a shipping product?

🟡 **[navigation-dev](https://dashboard.porter.run/apps/navigation-dev?target=default&project=15081&cluster=4689)**
Created 2025-06-25
1 core, 1 GB
Running
[Mentra-Community/Navigation](https://github.com/Mentra-Community/Navigation)
Delete if navigation isn't shipping.

🟡 **[teleprompter-dev](https://dashboard.porter.run/apps/teleprompter-dev?target=default&project=15081&cluster=4689)**
Created 2025-06-24
2 cores, 6 GB
Pending
[Mentra-Community/TeleprompterOnSmartGlasses](https://github.com/Mentra-Community/TeleprompterOnSmartGlasses)
Pending, can't schedule. Requesting 6 GB.

🟡 **[bmp-example](https://dashboard.porter.run/apps/bmp-example?target=default&project=15081&cluster=4689)**
Created 2025-07-17
1 core, 1 GB
Running
[Mentra-Community/BMP-Example](https://github.com/Mentra-Community/BMP-Example)
Same repo as bmp-test. One of these may be a duplicate.

🟡 **[bmp-test](https://dashboard.porter.run/apps/bmp-test?target=default&project=15081&cluster=4689)**
Created 2025-07-17
1 core, 1 GB
Running
[Mentra-Community/BMP-Example](https://github.com/Mentra-Community/BMP-Example)
Same repo as bmp-example. One of these may be a duplicate.

🟡 **[reminders-tpa](https://dashboard.porter.run/apps/reminders-tpa?target=default&project=15081&cluster=4689)**
Created 2025-04-21
1 core, 1 GB
Running
[AugmentOS-Community/AugmentOS-Reminders](https://github.com/AugmentOS-Community/AugmentOS-Reminders)
May be replaced by Mentra Notes.

🟡 **[calendar-reminder](https://dashboard.porter.run/apps/calendar-reminder?target=default&project=15081&cluster=4689)**
Created 2025-06-23
2 cores, 6 GB
Pending
[Mentra-Community/CalendarReminderOnSmartGlasses](https://github.com/Mentra-Community/CalendarReminderOnSmartGlasses)
Pending because it requests 6 GB. May be replaced by Mentra Notes.

🟡 **[cactusai](https://dashboard.porter.run/apps/cactusai?target=default&project=15081&cluster=4689)**
Created 2025-06-09
1 core, 1 GB
Running
[MentraLabs/CactusAI](https://github.com/MentraLabs/CactusAI)
Third-party app. Published?

🟡 **[captions-beta](https://dashboard.porter.run/apps/captions-beta?target=default&project=15081&cluster=4754)** (East Asia)
Created 2026-03-11
[Mentra-Community/LiveCaptionsOnSmartGlasses](https://github.com/Mentra-Community/LiveCaptionsOnSmartGlasses)
Is beta needed on a production region?

---

## 🟢 Keep

Production services, active apps, games, examples, and confirmed good.

### Cloud Services

🟢 **[cloud-prod](https://dashboard.porter.run/apps/cloud-prod?target=default&project=15081&cluster=4689)**
Created 2025-04-11
5 cores, 12.6 GB RAM
Running
[AugmentOS-Community/AugmentOS](https://github.com/AugmentOS-Community/AugmentOS)
Production cloud.

🟢 **[cloud-dev](https://dashboard.porter.run/apps/cloud-dev?target=default&project=15081&cluster=4689)**
Created 2025-04-10
5 cores, 4 GB RAM
Running
[AugmentOS-Community/AugmentOS](https://github.com/AugmentOS-Community/AugmentOS)

🟢 **[cloud-debug](https://dashboard.porter.run/apps/cloud-debug?target=default&project=15081&cluster=4689)**
Created 2025-04-01
5 cores, 4 GB RAM
Running
[AugmentOS-Community/AugmentOS](https://github.com/AugmentOS-Community/AugmentOS)

🟢 **[cloud-staging](https://dashboard.porter.run/apps/cloud-staging?target=default&project=15081&cluster=4689)**
Created 2025-10-01
5 cores, 4 GB RAM
Running
[Mentra-Community/MentraOS](https://github.com/Mentra-Community/MentraOS)

### Live Captions

🟢 **[captions](https://dashboard.porter.run/apps/captions?target=default&project=15081&cluster=4689)**
Created 2025-11-26
1 core, 1 GB
Running
[Mentra-Community/MentraOS](https://github.com/Mentra-Community/MentraOS) (monorepo)
Current production captions.

🟢 **[captions-beta](https://dashboard.porter.run/apps/captions-beta?target=default&project=15081&cluster=4689)**
Created 2025-12-08
1 core, 1 GB
Running
[Mentra-Community/LiveCaptionsOnSmartGlasses](https://github.com/Mentra-Community/LiveCaptionsOnSmartGlasses)
Keep if actively used.

🟢 **[captions-debug](https://dashboard.porter.run/apps/captions-debug?target=default&project=15081&cluster=4689)**
Created 2026-01-13
1 core, 1 GB
Running
[Mentra-Community/LiveCaptionsOnSmartGlasses](https://github.com/Mentra-Community/LiveCaptionsOnSmartGlasses)
Keep if actively used.

### Dashboard

🟢 **[dashboard](https://dashboard.porter.run/apps/dashboard?target=default&project=15081&cluster=4689)**
Created 2025-06-18
1 core, 1 GB
Running
[AugmentOS-Community/Dashboard](https://github.com/AugmentOS-Community/Dashboard)
System app.

### Livestreamer

🟢 **[mentra-stream](https://dashboard.porter.run/apps/mentra-stream?target=default&project=15081&cluster=4689)**
`com.mentra.streamer`
Created 2026-01-07
1 core, 1 GB
Running
[Mentra-Community/MentraOS-LiveStreaming-App](https://github.com/Mentra-Community/MentraOS-LiveStreaming-App) `main` branch
Current production streamer.

🟢 **[mentra-stream-beta](https://dashboard.porter.run/apps/mentra-stream-beta?target=default&project=15081&cluster=4689)**
`com.mentra.streamer.beta`
Created 2026-01-07
1 core, 1 GB
Running
[Mentra-Community/MentraOS-LiveStreaming-App](https://github.com/Mentra-Community/MentraOS-LiveStreaming-App) `staging` branch
Beta channel.

🟢 **[mentra-stream-dev](https://dashboard.porter.run/apps/mentra-stream-dev?target=default&project=15081&cluster=4689)**
`com.mentra.streamer.dev`
Created 2026-01-07
1 core, 1 GB
Running
[Mentra-Community/MentraOS-LiveStreaming-App](https://github.com/Mentra-Community/MentraOS-LiveStreaming-App) `dev` branch
Dev channel.

🟢 **[roger0-streamer-app](https://dashboard.porter.run/apps/roger0-streamer-app?target=default&project=15081&cluster=4689)**
`com.mentra.oldstreamer`
Created 2026-01-20
1 core, 1 GB
Running
[Mentra-Community/Mentra-Stream](https://github.com/Mentra-Community/Mentra-Stream) `revert-branch`
Respect for Roger.

### Mentra Notes

🟢 **[mentra-notes-prod](https://dashboard.porter.run/apps/mentra-notes-prod?target=default&project=15081&cluster=4689)**
`com.mentra.notes`
Created 2026-02-13
1 core, 3 GB
Running
[Mentra-Community/Mentra-Note](https://github.com/Mentra-Community/Mentra-Note) `main` branch
Current prod.

🟢 **[notes-tpa-prod](https://dashboard.porter.run/apps/notes-tpa-prod?target=default&project=15081&cluster=4689)**
`com.mentra.notes.old`
Created 2025-05-08
1 core, 1 GB
Running
[AugmentOS-Community/Conversations-and-Reminders-TPA](https://github.com/AugmentOS-Community/Conversations-and-Reminders-TPA)
Keep as backup.

🟢 **[notes-tpa-dev](https://dashboard.porter.run/apps/notes-tpa-dev?target=default&project=15081&cluster=4689)**
`com.mentra.notes.dev`
Created 2025-05-06
1 core, 1 GB
Running
[AugmentOS-Community/Conversations-and-Reminders-TPA](https://github.com/AugmentOS-Community/Conversations-and-Reminders-TPA) `dev` branch
Dev channel of old notes.

### Translation

🟢 **[translation](https://dashboard.porter.run/apps/translation?target=default&project=15081&cluster=4689)**
`com.mentra.translation`
Created 2025-07-30
1 core, 1 GB
Running
[Mentra-Community/LiveTranslationOnSmartGlasses](https://github.com/Mentra-Community/LiveTranslationOnSmartGlasses) `two-way-translation` branch
Current prod.

🟢 **[translation-beta](https://dashboard.porter.run/apps/translation-beta?target=default&project=15081&cluster=4689)**
Created 2025-12-15
1 core, 1 GB
Running
[Mentra-Community/LiveTranslationOnSmartGlasses](https://github.com/Mentra-Community/LiveTranslationOnSmartGlasses)
Keep if actively used.

### Mentra AI

🟢 **[mentra-ai-2-prod](https://dashboard.porter.run/apps/mentra-ai-2-prod?target=default&project=15081&cluster=4689)**
Created 2026-02-17
1.5 cores, 4 GB
Running
[Mentra-Community/Mentra-AI-2](https://github.com/Mentra-Community/Mentra-AI-2)
Current prod AI.

🟢 **[mentra-ai-2-dev](https://dashboard.porter.run/apps/mentra-ai-2-dev?target=default&project=15081&cluster=4689)**
Created 2026-02-17
1.5 cores, 4 GB
Running
[Mentra-Community/Mentra-AI-2](https://github.com/Mentra-Community/Mentra-AI-2)
Dev channel.

### Camera / Photo

🟢 **[camera-photo-prod](https://dashboard.porter.run/apps/camera-photo-prod?target=default&project=15081&cluster=4689)**
Created 2026-02-15
1 core, 1 GB
Running
[Mentra-Community/MentraOS-Camera-Example](https://github.com/Mentra-Community/MentraOS-Camera-Example)
Prod example app.

🟢 **[camera-photo-dev](https://dashboard.porter.run/apps/camera-photo-dev?target=default&project=15081&cluster=4689)**
Created 2026-02-15
1 core, 1 GB
Running
[Mentra-Community/MentraOS-Camera-Example](https://github.com/Mentra-Community/MentraOS-Camera-Example)
Dev channel.

### Recorder

🟢 **[recorder](https://dashboard.porter.run/apps/recorder?target=default&project=15081&cluster=4689)**
Created 2025-05-22
1 core, 1 GB
Running
[MentraLabs/Recorder](https://github.com/MentraLabs/Recorder)

### Merge

🟢 **[merge-2-prod](https://dashboard.porter.run/apps/merge-2-prod?target=default&project=15081&cluster=4689)**
Created 2026-03-07
100m CPU, 400 MB
Running
[Mentra-Community/Merge](https://github.com/Mentra-Community/Merge)
Current prod.

🟢 **[merge-2-dev](https://dashboard.porter.run/apps/merge-2-dev?target=default&project=15081&cluster=4689)**
Created 2026-03-07
100m CPU, 400 MB
Running
[Mentra-Community/Merge](https://github.com/Mentra-Community/Merge)
Dev channel.

### Mentra Call

🟢 **[mentra-call-dev](https://dashboard.porter.run/apps/mentra-call-dev?target=default&project=15081&cluster=4689)**
Created 2026-04-11
1 core, 1 GB
Running
[Mentra-Community/GoogleMeet](https://github.com/Mentra-Community/GoogleMeet)
Actively being developed.

### Notify

🟢 **[notify](https://dashboard.porter.run/apps/notify?target=default&project=15081&cluster=4689)**
Created 2025-04-06
1 core, 1 GB
Running
[AugmentOS-Community/Notify](https://github.com/AugmentOS-Community/Notify)
System notification app.

### Teleprompter

🟢 **[teleprompter](https://dashboard.porter.run/apps/teleprompter?target=default&project=15081&cluster=4689)**
Created 2025-04-03
2 cores, 6 GB
Pending
[AugmentOS-Community/TeleprompterOnSmartGlasses](https://github.com/AugmentOS-Community/TeleprompterOnSmartGlasses)
Pending, can't schedule. Requesting 6 GB — resource request needs fixing.

### Demo / Example / Game Apps

🟢 **[display-text-on-smart-glasses](https://dashboard.porter.run/apps/display-text-on-smart-glasses?target=default&project=15081&cluster=4689)**
Created 2025-04-20
1 core, 1 GB
Running
[AugmentOS-Community/DisplayTextOnSmartGlasses](https://github.com/AugmentOS-Community/DisplayTextOnSmartGlasses)
Example app.

🟢 **[example-play-audio](https://dashboard.porter.run/apps/example-play-audio?target=default&project=15081&cluster=4689)**
Created 2025-07-08
1 core, 1 GB
Running
[Mentra-Community/example-play-sound](https://github.com/Mentra-Community/example-play-sound)
Example app.

🟢 **[tic-tac-toe](https://dashboard.porter.run/apps/tic-tac-toe?target=default&project=15081&cluster=4689)**
Created 2025-04-20
2 cores, 6 GB
Pending
[AugmentOS-Community/TicTacToeOnSmartGlasses](https://github.com/AugmentOS-Community/TicTacToeOnSmartGlasses)
Game app. Note: Pending because it requests 6 GB — resource request needs fixing.

🟢 **[wordle](https://dashboard.porter.run/apps/wordle?target=default&project=15081&cluster=4689)**
Created 2025-07-28
1 core, 1 GB
Running
[Mentra-Community/wordle](https://github.com/Mentra-Community/wordle)
Game app.

🟢 **[hangman](https://dashboard.porter.run/apps/hangman?target=default&project=15081&cluster=4689)**
Created 2025-07-19
2 cores, 6 GB
Pending
[Mentra-Community/Hangman](https://github.com/Mentra-Community/Hangman)
Game app. Note: Pending because it requests 6 GB — resource request needs fixing.

🟢 **[timer](https://dashboard.porter.run/apps/timer?target=default&project=15081&cluster=4689)**
Created 2025-07-10
1 core, 1 GB
Running
[Mentra-Community/AdvancedTimerOnSmartGlasses](https://github.com/Mentra-Community/AdvancedTimerOnSmartGlasses)
Utility app.

🟢 **[x-stats](https://dashboard.porter.run/apps/x-stats?target=default&project=15081&cluster=4689)**
Created 2025-04-15
2 cores, 6 GB
Pending
[AugmentOS-Community/ShowXstatsOnSmartGlasses](https://github.com/AugmentOS-Community/ShowXstatsOnSmartGlasses)
Stats app. Note: Pending because it requests 6 GB — resource request needs fixing.

🟢 **[bsky-stats](https://dashboard.porter.run/apps/bsky-stats?target=default&project=15081&cluster=4689)**
Created 2025-07-08
2 cores, 6 GB
Pending
[Mentra-Community/ShowBskyStatsOnSmartGlasses](https://github.com/Mentra-Community/ShowBskyStatsOnSmartGlasses)
Stats app. Note: Pending because it requests 6 GB — resource request needs fixing.

### Third-Party / External

🟢 **[soundy](https://dashboard.porter.run/apps/soundy?target=default&project=15081&cluster=4689)**
Created 2025-07-13
2 cores, 5 GB
Running
[MentraLabs/Soundy_Deaf_Hard_of_Hearing](https://github.com/MentraLabs/Soundy_Deaf_Hard_of_Hearing)
Third-party accessibility app. 5 GB seems high.

🟢 **[aughog-prod](https://dashboard.porter.run/apps/aughog-prod?target=default&project=15081&cluster=4689)**
Created 2025-04-01
1 core, 1 GB
Running
[MentraLabs/AugHog](https://github.com/MentraLabs/AugHog)

🟢 **[slack](https://dashboard.porter.run/apps/slack?target=default&project=15081&cluster=4689)**
Created 2025-07-31
1 core, 1 GB
Running
[Drakonheart/Ms_test](https://github.com/Drakonheart/Ms_test)
External contributor (Drakonheart).

### Personal / Isaiah

🟢 **[songs](https://dashboard.porter.run/apps/songs?target=default&project=15081&cluster=4689)**
Created 2025-07-28
1 core, 1 GB
Running
[isaiahb/songs](https://github.com/isaiahb/songs)
Personal repo.

---

## Other Clusters

### France (Cluster 4696) — 2 apps

🟢 **[cloud-prod](https://dashboard.porter.run/apps/cloud-prod?target=default&project=15081&cluster=4696)**
Created 2025-04-24
[AugmentOS-Community/AugmentOS](https://github.com/AugmentOS-Community/AugmentOS)
Keep.

🟢 **[captions](https://dashboard.porter.run/apps/captions?target=default&project=15081&cluster=4696)**
Created 2025-12-09
[Mentra-Community/LiveCaptionsOnSmartGlasses](https://github.com/Mentra-Community/LiveCaptionsOnSmartGlasses)
Keep.

Clean — only production services.

### East Asia (Cluster 4754) — 5 apps

🟢 **[cloud-prod](https://dashboard.porter.run/apps/cloud-prod?target=default&project=15081&cluster=4754)**
Created 2025-04-23
[AugmentOS-Community/AugmentOS](https://github.com/AugmentOS-Community/AugmentOS)
Keep.

🟢 **[captions](https://dashboard.porter.run/apps/captions?target=default&project=15081&cluster=4754)**
Created 2025-12-09
[Mentra-Community/LiveCaptionsOnSmartGlasses](https://github.com/Mentra-Community/LiveCaptionsOnSmartGlasses)
Keep.

🟢 **[captions-beta](https://dashboard.porter.run/apps/captions-beta?target=default&project=15081&cluster=4754)**
Created 2026-03-11
[Mentra-Community/LiveCaptionsOnSmartGlasses](https://github.com/Mentra-Community/LiveCaptionsOnSmartGlasses)

### US West (Cluster 4965) — 4 apps

🟢 **[cloud-prod](https://dashboard.porter.run/apps/cloud-prod?target=default&project=15081&cluster=4965)**
Created 2025-07-10
[Mentra-Community/MentraOS](https://github.com/Mentra-Community/MentraOS)
Keep.

🟢 **[cloud-dev](https://dashboard.porter.run/apps/cloud-dev?target=default&project=15081&cluster=4965)**
Created 2025-07-04
[Mentra-Community/MentraOS](https://github.com/Mentra-Community/MentraOS)

🟢 **[cloud-isaiah](https://dashboard.porter.run/apps/cloud-isaiah?target=default&project=15081&cluster=4965)**
Created 2025-07-09
[Mentra-Community/MentraOS](https://github.com/Mentra-Community/MentraOS)

🟢 **[aryan-cloud](https://dashboard.porter.run/apps/aryan-cloud?target=default&project=15081&cluster=4965)**
Created 2026-04-06
[Mentra-Community/MentraOS](https://github.com/Mentra-Community/MentraOS)

### US East (Cluster 4977) — 2 apps

🟢 **[cloud-prod](https://dashboard.porter.run/apps/cloud-prod?target=default&project=15081&cluster=4977)**
Created 2025-07-10
[Mentra-Community/MentraOS](https://github.com/Mentra-Community/MentraOS)
Keep.

---

## Pending Pods

These 8 pods request more resources than available and can't schedule. The resource requests may need to be reduced:

**bsky-stats** — 2 cores, 6 GB. Bluesky stats demo.

**calendar-reminder** — 2 cores, 6 GB. May be replaced by notes.

**hangman** — 2 cores, 6 GB. Hangman game.

**live-captions-global** — 3 cores, 4 GB. Possibly replaced by `captions`.

**teleprompter** — 2 cores, 6 GB. AugmentOS era.

**teleprompter-dev** — 2 cores, 6 GB. Dev variant.

**tic-tac-toe** — 2 cores, 6 GB. Tic-tac-toe game.

**x-stats** — 2 cores, 6 GB. X/Twitter stats demo.

Total wasted requests: **17 cores, 46 GB RAM.**

---

## Summary

**~28 apps confirmed deprecated** per team doc, exact duplicates, or explicitly marked for removal.

**~15 apps need team review** before any action.

**~50 apps are confirmed good** — production services, active apps, games, examples.

**8 Pending pods** need their resource requests reduced.

---

## Action Items

- [ ] Review the 🟡 items with the team
- [ ] Delete the 🔴 items
- [ ] Update BetterStack uptime monitors if live-captions-global is deleted
- [ ] Fix resource requests on Pending pods (6 GB for games is wrong)
- [ ] Policy: default mini app resource request should be 0.5 cores / 512 MB
- [ ] Quarterly cleanup review going forward

## References

- [infra.md](../../.architecture/infra.md) — documents cloud-livekit as legacy, lists active Porter apps by log volume
- [081 — BetterStack Duplicate Collector](../081-betterstack-duplicate-collector/) — collector cleanup
- [032 — Cloud Scaling](../032-cloud-scaling/) — multi-region architecture
