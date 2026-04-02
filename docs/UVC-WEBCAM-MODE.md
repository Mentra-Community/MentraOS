# Mentra Live — UVC Webcam Mode

> **Goal:** Plug Mentra Live into a computer via USB and have it register as a standard webcam (UVC device), usable in Zoom, OBS, Google Meet, etc. — with zero driver installation. ADB remains functional.

---

## Hardware Facts (from ADB)

| Property | Value |
|---|---|
| Device | Mentra Live (`MentraLive`) |
| SoC | **MediaTek MT6761** (Helio A22) |
| Android | **11** (SDK 30) |
| Kernel | **4.19.127** (aarch64) |
| USB Controller | **musb-hdrc** (Mentor Graphics HS OTG) |
| USB Speed | **High-Speed** (480 Mbps) |
| USB Mode | **Gadget mode** (device side) |
| OTG Support | Yes (`is_otg = 1`) |
| ConfigFS | Mounted at `/config`, fully functional |
| SELinux | Permissive |
| RAM | ~2 GB |
| Camera | 1 rear camera, Camera HAL v3.6 |
| Hardware Endpoints | **16** (EP0–EP15) — currently using 3, need ~5 for UVC+ADB |

---

## Feasibility: Confirmed

**The kernel already has UVC gadget support built in.**

Tested live on device:

```
# as root
mkdir /config/usb_gadget/g1/functions/uvc.usb0
```

**Result: Success.** The full UVC configfs tree was created — `streaming/`, `control/`, `mjpeg/`, `uncompressed/`, headers, color matching — everything. `CONFIG_USB_F_UVC` is already compiled into the kernel.

**No kernel rebuild needed. No hardware modification needed.**

### Why this works

1. **UVC gadget driver is already in the kernel** — no firmware/kernel change needed for the driver
2. **ConfigFS is mounted and writable** (as root)
3. **USB controller (musb-hdrc) supports gadget mode** — same direction as ADB (device, not host)
4. **High-Speed USB** (480 Mbps) — plenty for 720p MJPEG @ 30fps
5. **SELinux is permissive** — no policy blocking
6. **Plenty of endpoints** — using ~5 of 16 available hardware endpoints

### Important clarification

This is **USB device/gadget mode** — the same USB direction the glasses already use for ADB. The computer is the host, the glasses are the device. This is NOT USB host mode (we are NOT plugging an external camera into the glasses). No external power supply from the glasses is needed. No USB switching detection is needed.

---

## USB Mode: Always `uvc,adb`

No mode switching. The default USB configuration becomes `uvc,adb` — the device **always** enumerates as a composite UVC webcam + ADB device.

| Function | Endpoints Used |
|---|---|
| EP0 (control) | 1 (always reserved) |
| ADB (`ffs.adb`) | 2 (1 bulk IN + 1 bulk OUT) |
| UVC (`uvc.usb0`) | ~2 (1 isoc/bulk IN for video + 1 interrupt IN for control) |
| **Total** | **~5 of 16** |

The camera does **not** run all the time — it only activates when a host application actually opens the webcam. The UVC descriptor is always present, but has zero power cost when idle.

---

## Architecture

```
Laptop (Zoom / OBS / Browser)
   ↓ USB (UVC standard protocol — no driver needed)
UVC gadget driver (kernel, already present)
   ↓ /dev/videoX (V4L2 OUTPUT)
asg_client UVC bridge service (writes frames)
   ↑
Camera2 API / Camera HAL
```

### Why UVC and not USB Accessory

| | UVC Gadget | USB Accessory |
|---|---|---|
| Host sees webcam | Yes — native, zero install | No |
| Works in Zoom/OBS/Meet | Yes — immediately | No — needs custom host app |
| Driver needed on host | No | Yes — custom software |
| Standard protocol | Yes (USB Video Class) | No (proprietary) |

UVC is the standard USB webcam protocol. Every OS (Windows, Mac, Linux) recognizes it natively. USB Accessory would require custom software on the computer, defeating the purpose.

### Camera lifecycle

| Event | Action |
|---|---|
| USB plugged in | Device enumerates as UVC + ADB. Camera stays **OFF**. |
| Host app opens webcam (STREAMON) | Camera turns **ON**, frames start flowing. |
| Host app closes webcam (STREAMOFF) | Camera turns **OFF**, pipeline tears down. |
| USB unplugged | Immediate teardown. |

---

## ODM Assignment

> **Subject: Change default USB mode to `uvc,adb` on Mentra Live**

### Background

The MT6761 kernel (4.19.127) already has `CONFIG_USB_F_UVC` enabled — the UVC gadget function can be created in configfs at runtime. We verified this on the device. No kernel rebuild or hardware modification is needed.

This uses USB **device/gadget mode** — the same direction as ADB. The glasses are the USB device, the computer is the USB host. No external power from the glasses, no USB switching detection.

### What we need

#### 1. Change default USB mode from `adb` to `uvc,adb`

Modify USB init scripts (`init.mt6761.usb.rc` / `init.usb.configfs.rc`) so the device **always** boots with both UVC and ADB active:

- Create UVC function at boot: `mkdir /config/usb_gadget/g1/functions/uvc.usb0`
- Configure UVC descriptors (uncompressed YUYV or MJPEG, 640x480 and 1280x720)
- Link both `ffs.adb` and `uvc.usb0` to `configs/b.1/`
- Set appropriate `idProduct` for the composite device
- Bind UDC

**ADB must remain functional.**

#### 2. Test acceptance criteria

- [ ] Device boots and enumerates as composite USB device (UVC + ADB)
- [ ] Host (Windows/Mac/Linux) sees a webcam device
- [ ] ADB works normally
- [ ] `/dev/videoX` is present for our app to write frames to

### What we handle (not ODM scope)

- Camera capture and frame encoding
- Writing frames to the UVC V4L2 device
- All userspace webcam logic

---

## asg_client Work

### UVC frame writer service

Native (C/C++ via JNI) background service that:
- Opens `/dev/videoX`
- Gets frames from Camera2 API
- Encodes to MJPEG or passes raw YUYV
- Writes to V4L2 OUTPUT device
- Handles STREAMON/STREAMOFF lifecycle (only runs camera when host is using webcam)

This is the only asg_client work required. No mode switching, no settings UI.

---

## Risk Assessment

| Risk | Level | Notes |
|---|---|---|
| Kernel UVC support | **None** | Already confirmed working on device |
| USB bandwidth | **Low** | 480 Mbps HS is plenty for 720p MJPEG |
| ADB coexistence | **Low** | Composite gadgets with ADB are standard on Android |
| Endpoint limits | **None** | Using ~5 of 16 hardware endpoints |
| ODM work | **Low** | Init script change only |
| Userspace bridge | **Medium** | Camera2 → V4L2 needs JNI/native code, but well-documented |

---

## Summary

- **Is it possible?** Yes, confirmed on current hardware.
- **Kernel rebuild needed?** No — UVC gadget driver already present.
- **Hardware modification needed?** No — same USB direction as ADB.
- **Second SKU needed?** No.
- **Mode switching needed?** No — always `uvc,adb`.
- **ADB lost?** No — composite gadget supports both.
- **Host driver needed?** No — UVC is a standard protocol, works natively on all OSes.
- **ODM work:** Change default USB mode in init scripts.
- **Our work:** UVC frame writer service in asg_client.
