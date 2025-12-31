# LC3 Shared Library Build
# Compiles LC3 codec C sources into a shared library for Python ctypes

# Detect platform
UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
    # macOS
    LIB_EXT = dylib
    SHARED_FLAGS = -dynamiclib -install_name @rpath/liblc3.$(LIB_EXT)
else
    # Linux
    LIB_EXT = so
    SHARED_FLAGS = -shared
endif

# Compiler and flags
CC = gcc
CFLAGS = -Wall -O3 -fPIC -Isrc/include
LDFLAGS = $(SHARED_FLAGS)

# Output
LIB_NAME = liblc3
LIB_OUT = lib/$(LIB_NAME).$(LIB_EXT)

# Source files from liblc3 directory
SRC_DIR = src/liblc3
SRCS = $(SRC_DIR)/attdet.c \
       $(SRC_DIR)/bits.c \
       $(SRC_DIR)/bwdet.c \
       $(SRC_DIR)/energy.c \
       $(SRC_DIR)/lc3.c \
       $(SRC_DIR)/ltpf.c \
       $(SRC_DIR)/mdct.c \
       $(SRC_DIR)/plc.c \
       $(SRC_DIR)/sns.c \
       $(SRC_DIR)/spec.c \
       $(SRC_DIR)/tables.c \
       $(SRC_DIR)/tns.c

# Object files
OBJS = $(SRCS:.c=.o)

# Default target
all: $(LIB_OUT)

# Build shared library
$(LIB_OUT): $(OBJS)
	@mkdir -p lib
	$(CC) $(LDFLAGS) -o $@ $^
	@echo "✓ Built $(LIB_OUT)"

# Compile source files
%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

# Clean build artifacts
clean:
	rm -f $(OBJS) $(LIB_OUT)
	@echo "✓ Cleaned build artifacts"

# Verify library
test: $(LIB_OUT)
	@echo "Testing library..."
	@if [ -f $(LIB_OUT) ]; then \
		echo "✓ Library exists: $(LIB_OUT)"; \
		file $(LIB_OUT); \
	else \
		echo "✗ Library not found"; \
		exit 1; \
	fi

.PHONY: all clean test

