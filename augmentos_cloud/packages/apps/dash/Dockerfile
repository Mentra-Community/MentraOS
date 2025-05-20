FROM oven/bun:1.0.25-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN bun install

# Copy source code
COPY . .

# Default environment variables
ENV PORT=3100
ENV CLOUD_LOCAL_HOST_NAME=cloud

EXPOSE 3100

# Start the application
CMD ["bun", "start"]