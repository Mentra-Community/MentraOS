FROM oven/bun:1.1

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

# Build
RUN bun run build

# Run
CMD ["bun", "run", "start"]
