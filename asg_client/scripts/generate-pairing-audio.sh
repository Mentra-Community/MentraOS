#!/usr/bin/env bash

set -euo pipefail

if [[ -z "${ELEVENLABS_API_KEY:-}" ]]; then
    echo "ELEVENLABS_API_KEY is required" >&2
    exit 1
fi

voice_id="${ELEVENLABS_VOICE_ID:-${ELEVENLABS_DEFAULT_VOICE_ID:-}}"
if [[ -z "$voice_id" ]]; then
    echo "ELEVENLABS_VOICE_ID or ELEVENLABS_DEFAULT_VOICE_ID is required" >&2
    exit 1
fi

for command_name in curl ffmpeg jq; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "$command_name is required" >&2
        exit 1
    fi
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output_dir="${PAIRING_AUDIO_OUTPUT_DIR:-$script_dir/../app/src/main/assets/pairing}"
model_id="${ELEVENLABS_MODEL_ID:-eleven_flash_v2_5}"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

mkdir -p "$output_dir"

# The spoken forms remove single-character pronunciation ambiguity while keeping each asset to
# one character name. PairingCodeSpeaker currently accepts hexadecimal codes, but the full
# alphabet stays voice-consistent for future code formats and other character-by-character audio.
clips=(
    "digit_0|zero"
    "digit_1|one"
    "digit_2|two"
    "digit_3|three"
    "digit_4|four"
    "digit_5|Five."
    "digit_6|six"
    "digit_7|seven"
    "digit_8|eight"
    "digit_9|nine"
    "letter_a|A."
    "letter_b|bee"
    "letter_c|see"
    "letter_d|dee"
    "letter_e|ee"
    "letter_f|eff"
    "letter_g|gee"
    "letter_h|H!"
    "letter_i|eye"
    "letter_j|jay"
    "letter_k|kay"
    "letter_l|el"
    "letter_m|em"
    "letter_n|en"
    "letter_o|oh"
    "letter_p|pee"
    "letter_q|cue"
    "letter_r|ar"
    "letter_s|ess"
    "letter_t|tee"
    "letter_u|you"
    "letter_v|vee"
    "letter_w|double you"
    "letter_x|ex"
    "letter_y|why"
    "letter_z|zee"
)

for clip in "${clips[@]}"; do
    basename="${clip%%|*}"
    spoken_text="${clip#*|}"
    mp3_path="$temporary_dir/$basename.mp3"
    wav_path="$output_dir/$basename.wav"
    request_body="$(
        jq -n \
            --arg text "$spoken_text" \
            --arg model_id "$model_id" \
            '{
                text: $text,
                model_id: $model_id,
                voice_settings: {
                    speed: 1.13,
                    stability: 0.68,
                    similarity_boost: 0.75,
                    style: 0.0
                }
            }'
    )"

    echo "Generating $basename.wav"
    curl \
        --fail-with-body \
        --silent \
        --show-error \
        --request POST \
        --url "https://api.elevenlabs.io/v1/text-to-speech/$voice_id?output_format=mp3_44100_128" \
        --header "Content-Type: application/json" \
        --header "xi-api-key: $ELEVENLABS_API_KEY" \
        --data "$request_body" \
        --output "$mp3_path"

    ffmpeg \
        -hide_banner \
        -loglevel error \
        -y \
        -i "$mp3_path" \
        -ac 1 \
        -ar 44100 \
        -c:a pcm_s16le \
        "$wav_path"
done

echo "Generated ${#clips[@]} Mentra Live pairing clips in $output_dir"
