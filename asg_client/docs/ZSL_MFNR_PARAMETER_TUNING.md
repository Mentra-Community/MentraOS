# ZSL/MFNR Parameter Tuning Guide

## Mission Brief

This guide helps you identify when camera parameters need adjustment and what symptoms to monitor.

---

## 🔍 Key Parameters to Monitor

### 1. **AE_WAIT_NS (3 seconds)**

**What it controls:** Maximum time to wait for auto-exposure convergence before timeout.

**Current value:** `3_000_000_000L` (3 seconds)

**Adjust if you see:**

- ❌ **AE timeout errors** - `"AE convergence timeout after X seconds"`
- ❌ **Photos too dark in low light** - AE not converging fast enough
- ❌ **Photos too bright in bright light** - AE taking too long to stabilize
- ✅ **Good sign:** `"AE converged! Requesting AE lock"` appears within 1-2 seconds

**How to adjust:**

```java
// In CameraNeo.java line ~227
private static final long AE_WAIT_NS = 3_000_000_000L; // Increase for slower convergence
```

**Recommendations:**

- **Bright scenes:** 1-2 seconds is usually enough
- **Low light:** 3-5 seconds may be needed
- **Very dark scenes:** 5-10 seconds (but user experience suffers)

---

### 2. **ImageReader Buffer Size (12 images)**

**What it controls:** Number of frames cached in ZSL circular buffer for MFNR.

**Current value:** `12` images

**Adjust if you see:**

- ❌ **"ImageReader queue full" warnings** - Buffer too small for rapid capture
- ❌ **MFNR not working** - Not enough frames in buffer (MFNR needs 6+ frames)
- ❌ **Memory warnings** - Buffer too large for device
- ✅ **Good sign:** No buffer warnings, photos capture smoothly

**How to adjust:**

```java
// In CameraNeo.java line ~1263
imageReader = ImageReader.newInstance(
    jpegSize.getWidth(), jpegSize.getHeight(),
    ImageFormat.JPEG, 12); // Increase for more buffer, decrease for less memory
```

**Recommendations:**

- **Minimum for MFNR:** 6-8 images (MFNR needs 6 frames)
- **Recommended:** 12 images (current)
- **Rapid capture:** 15-20 images (if device memory allows)
- **Memory constrained:** 8-10 images

---

### 3. **FPS Range (5-30fps)**

**What it controls:** Exposure time limits - wider range allows longer exposures for higher ISO.

**Current value:** `[5, 30]` fps (selected automatically)

**Adjust if you see:**

- ❌ **ISO stuck below 800** - MFNR won't trigger (needs ISO>800)
- ❌ **Exposure time too short** - `"Exposure: 33.333ms"` (limited by 30fps max)
- ❌ **Overexposed photos** - Exposure time too long
- ✅ **Good sign:** `"ISO: 1464"` or `"ISO: 1857"` (above 800, MFNR active)

**How to adjust:**

```java
// In CameraNeo.java chooseOptimalFpsRange() method
// Currently prefers [5, 30] for longer exposures
// Change to [30, 30] for fixed 30fps (shorter exposures, lower ISO)
```

**Recommendations:**

- **Low light (MFNR needed):** `[5, 30]` or `[10, 30]` (allows 100ms+ exposures)
- **Bright scenes:** `[30, 30]` (faster, shorter exposures)
- **Balanced:** `[15, 30]` (compromise)

---

### 4. **MFNR Mode Value (255)**

**What it controls:** Intensity of multi-frame noise reduction.

**Current value:** `255` (full MFNR)

**Adjust if you see:**

- ❌ **Photos too soft/blurry** - MFNR too aggressive
- ❌ **Processing too slow** - MFNR taking too long
- ❌ **No noise reduction** - MFNR not working (check ISO>800)
- ✅ **Good sign:** `"MFNR/AIS mode set to ON (255)"` in logs

**How to adjust:**

```java
// In CameraSettings.java line ~188
int[] mfnrMode = new int[]{255}; // Try 128 for medium, 64 for light
```

**Recommendations:**

- **Full MFNR:** `255` (current, best noise reduction)
- **Medium:** `128` (faster, less aggressive)
- **Light:** `64` (fastest, minimal processing)
- **Note:** Only works when ISO > 800

---

### 5. **ZSL Mode Value (1)**

**What it controls:** Zero Shutter Lag buffer mode.

**Current value:** `1` (ON)

**Adjust if you see:**

- ❌ **"Capture failed during AE sequence"** - ZSL conflict (should be fixed now)
- ❌ **Slow capture** - ZSL not working
- ✅ **Good sign:** `"ZSL_MODE vendor key set to ON (1)"` in logs

**How to adjust:**

```java
// In CameraSettings.java line ~136-137
byte[] zslMode = new byte[]{1}; // 1 = ON, 0 = OFF
```

**Recommendations:**

- **Always use:** `1` (ON) - Required for MFNR buffer
- **Never use:** `0` (OFF) - Breaks MFNR

---

## 🚨 Critical Symptoms to Watch For

### **Symptom 1: MFNR Not Triggering**

**Indicators:**

- ISO stays below 800: `"ISO: 400"` or `"ISO: 500"`
- No MFNR logs: Missing `"MFNR/AIS mode set to ON (255)"`
- Photos noisy in low light

**Fix:**

- Check FPS range allows long exposures (use `[5, 30]` not `[30, 30]`)
- Verify MFNR enabled in settings: `mAsgSettings.isMfnrEnabled()`
- Check vendor keys detected: `"Vendor feature support - ZSL: true, MFNR: true"`

---

### **Symptom 2: AE Timeout**

**Indicators:**

- `"AE convergence timeout after 3 seconds"`
- Photos captured but exposure wrong
- Long delay before capture

**Fix:**

- Increase `AE_WAIT_NS` to 5-10 seconds
- Check if scene is too dark (may need flash)
- Verify AE callback is being invoked (check log count)

---

### **Symptom 3: Buffer Overflow**

**Indicators:**

- `"ImageReader queue full"` warnings
- Photos missing or corrupted
- Memory warnings

**Fix:**

- Increase ImageReader buffer size (12 → 15-20)
- Process images faster (reduce processing time)
- Check if rapid capture is overwhelming buffer

---

### **Symptom 4: Capture Failures**

**Indicators:**

- `"Capture failed during AE sequence: 0"`
- `"onCaptureFailed"` callbacks
- No photo saved

**Fix:**

- Verify using `TEMPLATE_PREVIEW` for repeating request (not `TEMPLATE_STILL_CAPTURE`)
- Check ZSL is enabled in preview AND capture
- Verify AE lock flow is working (check logs for `"AE locked!"`)

---

### **Symptom 5: Slow Capture**

**Indicators:**

- Long delay between button press and photo save
- `"Waiting for AE convergence"` for >2 seconds
- User complaints about lag

**Fix:**

- Reduce `AE_WAIT_NS` if AE converges quickly
- Check if MFNR processing is slow (try lower MFNR value: 128 or 64)
- Verify ZSL is working (should be instant from buffer)

---

## 📊 Monitoring Checklist

### **After Each Capture, Check Logs For:**

1. **ZSL Status:**

   ```
   ✓ ZSL verified in preview request: CONTROL_ENABLE_ZSL = true
   ✓ ZSL verified in capture request: CONTROL_ENABLE_ZSL = true
   ```

2. **MFNR Status:**

   ```
   ISO: 1464  (or any value > 800)
   Capture: MFNR/AIS mode set to ON (255)
   ```

3. **AE Flow:**

   ```
   AE converged! Requesting AE lock, state: CONVERGED
   AE locked! State: LOCKED, capturing photo
   ```

4. **No Errors:**
   ```
   ❌ No "Capture failed" messages
   ❌ No "timeout" messages
   ❌ No "queue full" warnings
   ```

---

## 🎯 Quick Parameter Reference

| Parameter              | Current | Min     | Max    | When to Increase            | When to Decrease                 |
| ---------------------- | ------- | ------- | ------ | --------------------------- | -------------------------------- |
| **AE_WAIT_NS**         | 3s      | 1s      | 10s    | Low light, slow convergence | Bright scenes, fast convergence  |
| **ImageReader Buffer** | 12      | 6       | 20     | Rapid capture, MFNR needs   | Memory constrained               |
| **FPS Range**          | [5,30]  | [30,30] | [5,30] | Low light (longer exposure) | Bright scenes (shorter exposure) |
| **MFNR Mode**          | 255     | 64      | 255    | Maximum noise reduction     | Faster processing                |
| **ZSL Mode**           | 1       | 0       | 1      | Always ON (required)        | Never (breaks MFNR)              |

---

## 🔧 Testing Procedure

1. **Capture in bright light:**
   - Should see ISO < 800 (MFNR won't trigger, that's OK)
   - AE should converge in <1 second
   - Photo should save quickly

2. **Capture in low light:**
   - Should see ISO > 800 (MFNR should trigger)
   - Should see `"MFNR/AIS mode set to ON (255)"`
   - AE may take 2-3 seconds (normal)
   - Photo should have less noise than without MFNR

3. **Rapid capture (multiple photos quickly):**
   - No buffer warnings
   - All photos save successfully
   - No memory issues

4. **Check logs for:**
   - All green checkmarks (✓) present
   - No red X marks (❌)
   - ISO values appropriate for lighting
   - AE flow completes successfully

---

## 📝 Notes

- **ISO > 800 is required for MFNR** - This is automatic, not a parameter
- **ZSL must be ON** - Required for MFNR buffer, don't disable
- **TEMPLATE_PREVIEW for repeating request** - Critical for ZSL compatibility
- **AE lock via repeating request** - Not precapture trigger (XyCamera2 pattern)

---

## 🆘 When to Ask for Help

If you see:

- Consistent capture failures after trying all fixes
- Device-specific issues (works on one device, not another)
- Vendor key detection failures
- Memory crashes related to ImageReader

Then it's time to investigate deeper or contact the team!
