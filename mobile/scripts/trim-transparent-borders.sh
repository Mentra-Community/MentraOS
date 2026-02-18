#!/bin/bash

# Trim transparent borders from PNG images
# Uses ImageMagick to remove extra transparent space around images

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if ImageMagick is installed
if ! command -v convert &> /dev/null; then
    echo -e "${YELLOW}ImageMagick is not installed.${NC}"
    echo "Install it with:"
    echo "  macOS: brew install imagemagick"
    echo "  Ubuntu/Debian: sudo apt-get install imagemagick"
    exit 1
fi

# Directory containing the images
GLASSES_DIR="../assets/glasses"

# Check if directory exists
if [ ! -d "$GLASSES_DIR" ]; then
    echo -e "${YELLOW}Directory not found: $GLASSES_DIR${NC}"
    exit 1
fi

echo -e "${BLUE}Trimming transparent borders from PNG images in $GLASSES_DIR${NC}"
echo ""

# Count total files
total_files=$(find "$GLASSES_DIR" -type f -name "*.png" | wc -l | tr -d ' ')
echo -e "Found ${GREEN}$total_files${NC} PNG files"
echo ""

# Counter for processed files
count=0

# Process each PNG file
find "$GLASSES_DIR" -type f -name "*.png" | while read -r file; do
    count=$((count + 1))
    filename=$(basename "$file")

    echo -e "[${count}/${total_files}] Processing: ${GREEN}$filename${NC}"

    # Trim transparent borders and reset page geometry
    # -trim removes transparent borders
    # +repage resets the virtual canvas to the trimmed size
    convert "$file" -trim +repage "$file"

done

echo ""
echo -e "${GREEN}✓ Done! All images have been trimmed.${NC}"
