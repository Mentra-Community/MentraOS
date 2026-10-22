# MentraOS Miniapp SDK

Terms for the miniapp SDK's phone-side audio output API.

## Speaker audio

**Speaker playback state**:
Whether a miniapp currently has speaker output active. An open live PCM stream
counts as playing until it ends or is stopped.

**Live speaker stream**:
A continuous PCM audio output session that receives audio in chunks.
