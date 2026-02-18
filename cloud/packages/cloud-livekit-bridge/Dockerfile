# Multi-stage build for LiveKit gRPC Bridge

FROM golang:1.24-bookworm AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    pkg-config \
    libopus-dev \
    libopusfile-dev \
    libsoxr-dev \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy go.mod and go.sum
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Generate proto code and install protoc plugins
RUN go install google.golang.org/protobuf/cmd/protoc-gen-go@latest && \
    go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest && \
    bash proto/generate.sh

# Build the gRPC service
RUN CGO_ENABLED=1 GOOS=linux go build -o livekit-bridge .

# Runtime stage
FROM debian:bookworm-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libopus0 \
    libopusfile0 \
    libsoxr0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/livekit-bridge .

# Expose gRPC port
EXPOSE 9090

# Set environment defaults
ENV PORT=9090
ENV LOG_LEVEL=info

# Health check using grpc_health_probe or simple process check
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD pgrep -x livekit-bridge || exit 1

CMD ["./livekit-bridge"]
