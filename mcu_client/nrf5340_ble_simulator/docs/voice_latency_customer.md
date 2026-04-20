# Audio Latency Analysis and Quantification (Customer Version)

**Document Version:** v1.3
**Date:** 2026-04-07
**Applicable System:** nRF5340 + GX8002 (VAD) → I2S → MCU → LC3 → BLE → Mobile Playback

---

# 1. Executive Summary

Under the current system configuration:

* **End-to-end latency during continuous speech (steady state): approximately 78–175 ms**
* **End-to-end latency for initial speech (first trigger): approximately 172–257 ms**

The difference is caused by the additional VAD and I2S startup overhead during the initial speech event.

The device-side latency is as follows:

* **Initial trigger:** approximately 132 ms (measured)
* **Continuous speech:** approximately 50 ms (fixed structural latency)

---

# 2. Current Measured Results

## 2.1 Device-Side Key Parameters (Deterministic Values)

| Item                           |                 Value | Description                      |
| ------------------------------ | --------------------: | -------------------------------- |
| Audio frame duration           |                 10 ms | 160 samples @ 16 kHz             |
| Frames per packet              |                     5 | Current configuration            |
| Steady-state device latency    |             **50 ms** | 5 × 10 ms                        |
| Initial-trigger device latency | **132 ms (measured)** | Startup + first-packet buffering |

---

## 2.2 End-to-End Latency Distribution (Typical Range)

### Continuous Speech (Steady State)

| Component              | Latency       |
| ---------------------- | ------------- |
| Device side            | 50 ms         |
| BLE scheduling         | 10–45 ms      |
| Mobile playback buffer | 30–80 ms      |
| **Total**              | **78–175 ms** |

---

### Initial Speech (First Trigger)

| Component                       | Latency        |
| ------------------------------- | -------------- |
| Device side (including startup) | 132 ms         |
| BLE scheduling                  | 10–45 ms       |
| Mobile playback buffer          | 30–80 ms       |
| **Total**                       | **172–257 ms** |

---

# 3. Latency Breakdown

The end-to-end latency consists of three parts:

## 3.1 Device Side (MCU)

### Continuous Speech: approximately 50 ms (Fixed)

Reason:

* Audio is captured in 10 ms frames
* The current configuration combines **5 frames before transmission**
* Therefore:

Device-side latency = 5 × 10 ms = 50 ms

👉 Analogy: the system waits until a full batch is ready before sending

---

### Initial Trigger: approximately 132 ms (Measured)

Breakdown:

| Component                         | Latency     |
| --------------------------------- | ----------- |
| VAD + I2S startup                 | ~82 ms      |
| First-packet buffering (5 frames) | ~50 ms      |
| **Total**                         | **~132 ms** |

Notes:

* This delay occurs only when speech starts for the first time
* It belongs to the startup process and does not continue accumulating during ongoing speech

---

## 3.2 BLE Transmission (System-Dependent)

| Component                            | Range    |
| ------------------------------------ | -------- |
| Connection-interval scheduling delay | 10–45 ms |
| Over-the-air transmission time       | ~1 ms    |

Notes:

* The main BLE-related delay comes from connection-interval scheduling
* It depends on the negotiated parameters with the mobile device

---

## 3.3 Mobile Side (App / System)

| Component                     | Range    |
| ----------------------------- | -------- |
| Decoding + playback buffering | 30–80 ms |

Notes:

* This is determined by the operating system and audio framework
* The result varies significantly across different phones

---

# 4. Key Conclusion

In the current system:

👉 **Device-side latency is the controllable part (50 ms)**
👉 **BLE and mobile-side latency are external variables**

Therefore, optimization should primarily focus on the device-side strategy.

---

# 5. Optimization Options and Expected Benefits

## Option 1: Reduce Frames per Packet (5 → 1) [Recommended]

### Change

* Transmit once every 10 ms
* Remove the 5-frame aggregation

### Benefit

| Item                | Current |   Optimized |
| ------------------- | ------: | ----------: |
| Device-side latency |   50 ms |   **10 ms** |
| Latency reduction   |       — | **↓ 40 ms** |

---

### Impact and Considerations

* BLE notification frequency increases by approximately 5×
* Power consumption may increase
* Mobile-side throughput and stability need to be validated

---

## Option 2: Optimize BLE Connection Interval

### Change

* Request a shorter connection interval (for example, 7.5–10 ms)

### Benefit

* Can reduce latency by **approximately 10–30 ms**

### Considerations

* Some mobile devices may not accept very short connection intervals
* Behavior varies across devices and platforms

---

## Option 3: Reduce Mobile Playback Buffer

### Change

* Optimize the audio playback strategy in the mobile application

### Benefit

* Can reduce latency by **20–80 ms**

### Considerations

* May affect playback smoothness

---

# 6. Estimated Optimization Results

## 6.1 Continuous Speech (Steady State)

| Scenario               | Latency              |
| ---------------------- | -------------------- |
| Current                | **130 ms (typical)** |
| Reduced frames (5 → 1) | **~90 ms**           |
| Fully optimized        | **~50 ms**           |

---

## 6.2 Initial Trigger

| Scenario        | Latency              |
| --------------- | -------------------- |
| Current         | **212 ms (typical)** |
| Reduced frames  | **~162 ms**          |
| Fully optimized | **~122 ms**          |

---

## Important Note

If the following conditions are both met:

* The mobile device accepts a shorter BLE connection interval
* The playback buffer strategy is also optimized

👉 The steady-state end-to-end latency may be reduced to:

**approximately 30–80 ms**

Actual results will still depend on:

* Mobile device model
* Operating system
* App implementation strategy

---

# 7. Summary

| Metric            | Current | Optimized (Estimated) | Improvement |
| ----------------- | ------: | --------------------: | ----------: |
| Initial trigger   |  212 ms |                122 ms |       ↓ 42% |
| Continuous speech |  130 ms |                 50 ms |       ↓ 62% |

---

# 8. Final Conclusion

The primary source of latency in the current system is:

👉 **Device-side frame aggregation (50 ms)**

This part is:

* **Fully controllable**
* **Associated with clear optimization benefits (about 40 ms reduction)**

With additional BLE-side and mobile-side optimization:

👉 The overall user experience can be significantly improved toward a low-latency range.
