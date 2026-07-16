#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: textroi-benchmark.sh --input PATH [options]

Run the desktop text-ROI detector benchmark.

Required:
  --input PATH                   Input image or directory of images

Options:
  --output DIR                  Output directory
                                (default: <asg_client>/build/textroi-benchmark)
  --model-dir DIR               Directory containing optional ONNX models
  --detectors IDS               Comma-separated detector ids (default: classical)
  --ble-bytes-per-second RATE   BLE throughput used for transfer estimates
  -h, --help                    Show this help
EOF
}

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd -P)"

input_path=""
output_dir="${REPO_DIR}/build/textroi-benchmark"
model_dir=""
detectors="classical"
ble_bytes_per_second=""

while (($# > 0)); do
  case "$1" in
    --input|--output|--model-dir|--detectors|--ble-bytes-per-second)
      if (($# < 2)) || [[ -z "$2" ]]; then
        echo "Error: $1 requires a value." >&2
        usage >&2
        exit 2
      fi
      case "$1" in
        --input) input_path="$2" ;;
        --output) output_dir="$2" ;;
        --model-dir) model_dir="$2" ;;
        --detectors) detectors="$2" ;;
        --ble-bytes-per-second) ble_bytes_per_second="$2" ;;
      esac
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$input_path" ]]; then
  echo "Error: --input is required." >&2
  usage >&2
  exit 2
fi
if [[ ! -e "$input_path" ]]; then
  echo "Error: input does not exist: $input_path" >&2
  exit 2
fi
if [[ -n "$model_dir" && ! -d "$model_dir" ]]; then
  echo "Error: model directory does not exist: $model_dir" >&2
  exit 2
fi
if [[ -n "$ble_bytes_per_second" && ! "$ble_bytes_per_second" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: --ble-bytes-per-second must be a positive integer." >&2
  exit 2
fi

absolute_path() {
  local path="$1"
  local parent
  parent="$(CDPATH= cd -- "$(dirname -- "$path")" && pwd -P)"
  printf '%s/%s\n' "$parent" "$(basename -- "$path")"
}

input_path="$(absolute_path "$input_path")"
if [[ -n "$model_dir" ]]; then
  model_dir="$(CDPATH= cd -- "$model_dir" && pwd -P)"
fi
mkdir -p -- "$output_dir"
output_dir="$(CDPATH= cd -- "$output_dir" && pwd -P)"

gradle_properties=(
  "-Dtextroi.inputDir=${input_path}"
  "-Dtextroi.outputDir=${output_dir}"
  "-Dtextroi.detectors=${detectors}"
)
if [[ -n "$model_dir" ]]; then
  gradle_properties+=("-Dtextroi.modelDir=${model_dir}")
fi
if [[ -n "$ble_bytes_per_second" ]]; then
  gradle_properties+=("-Dtextroi.bleBytesPerSecond=${ble_bytes_per_second}")
fi

echo "Text ROI benchmark output: ${output_dir}"
(
  cd -- "$REPO_DIR"
  ./gradlew :app:testDebugUnitTest \
    --tests '*TextRoiBenchmarkHarnessTest' \
    "${gradle_properties[@]}"
)
echo "Text ROI benchmark output: ${output_dir}"
