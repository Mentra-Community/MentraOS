"""Generates forget-ios-pairing.png for the /pairing/forget-ios-pairing screen (S8).

Source: assets/onboarding/os/thumbnails/btclassic.png (iPhone Bluetooth page).
Edit: "My Devices" lists "Apple Watch  Connected" and "Mentra Live  Not Connected",
the second row's (i) is circled in green, and the "Other Devices" section is removed.

Run from mobile/: python3 assets/onboarding/live/generate_forget_ios_pairing.py
"""

from PIL import Image, ImageDraw, ImageFont

SRC = "assets/onboarding/os/thumbnails/btclassic.png"
DST = "assets/onboarding/live/forget-ios-pairing.png"

SCREEN_BG = (241, 241, 246, 255)
CARD_BG = (255, 255, 255, 255)
GREEN = (52, 199, 89, 255)
TEXT = (0, 0, 0, 255)

im = Image.open(SRC).convert("RGBA")
d = ImageDraw.Draw(im)

# Row 2 label: AirPods Pro -> Mentra Live (keep "Not Connected" and the (i)).
d.rectangle([180, 816, 460, 886], fill=CARD_BG)
font = ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", 30, index=0)
d.text((184, 848), "Mentra Live", font=font, fill=TEXT, anchor="lm")

# Remove "Other Devices" and its row.
d.rectangle([125, 940, 862, 1125], fill=SCREEN_BG)

# Green circle around the second (i), drawn 4x for clean edges.
cx, cy, r, w, ss = 792, 850, 34, 6, 4
layer = Image.new("RGBA", (2 * (r + w) * ss, 2 * (r + w) * ss), (0, 0, 0, 0))
ld = ImageDraw.Draw(layer)
ld.ellipse([w * ss, w * ss, (2 * r + w) * ss, (2 * r + w) * ss], outline=GREEN, width=w * ss)
layer = layer.resize((2 * (r + w), 2 * (r + w)), Image.LANCZOS)
im.alpha_composite(layer, (cx - r - w, cy - r - w))

im.save(DST)
print("wrote", DST, im.size)
