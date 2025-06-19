# Stage 1: Build
FROM node:18-slim AS builder

# Install required tools
RUN apt-get update && apt-get install -y curl unzip git python3 make g++ tini && \
    curl -fsSL https://bun.sh/install | bash && \
    npm install -g typescript tsx ws

ENV PATH="/root/.bun/bin:${PATH}"
WORKDIR /app

# Copy your application code
COPY . .

# Install dependencies and build shared packages and services in the correct order
# Added proper error handling and explicit build steps
RUN echo "🚀 Starting build process..." && \
    bun install && \
    echo "📦 Dependencies installed successfully" && \
    echo "⚙️ Building packages/sdk..." && \
    cd ../sdk && bun run build && \
    echo "⚙️ Building packages/utils..." && \
    cd packages/utils && bun run build && \
    echo "✅ utils built successfully" && \
    echo "✅ sdk built successfully" && \
    echo "⚙️ Building packages/agents..." && \
    cd ../agents && bun run build && \
    echo "✅ agents built successfully" && \
    echo "⚙️ Building packages/cloud..." && \
    cd ../cloud && bun run build && \
    echo "✅ cloud built successfully" && \
    echo "⚙️ Building packages/apps/livecaptions..." && \
    cd ../apps/livecaptions && bun run build && \
    echo "✅ livecaptions built successfully" && \
    echo "⚙️ Building packages/apps/dashboard-manager..." && \
    cd ../dashboard-manager && bun run build && \
    echo "✅ dashboard-manager built successfully" && \
    echo "⚙️ Building packages/apps/notify..." && \
    cd ../notify && bun run build && \
    echo "✅ notify built successfully" && \
    echo "⚙️ Building packages/apps/miraai..." && \
    cd ../miraai && bun run build && \
    echo "✅ miraai built successfully" && \
    echo "⚙️ Building packages/apps/livetranslation..." && \
    cd ../livetranslation && bun run build && \
    echo "✅ livetranslation built successfully" && \
    echo "🎉 All packages built successfully!"

# Stage 2: Production Image
FROM node:18-slim
WORKDIR /app
COPY --from=builder /app /app
ENV NODE_ENV=production

# Install tini for proper process management
RUN apt-get update && apt-get install -y tini && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Use tini as the init process
ENTRYPOINT ["/usr/bin/tini", "--"]

# Default command (can be overridden by Porter)
CMD ["echo", "Ready to run services"]
