FROM node:18.17.1

WORKDIR /app

# Install basic dependencies
RUN apt-get update && apt-get install -y git

# Create a user for running the build
RUN useradd -m builder

# Copy package files first to leverage Docker cache
COPY package.json package-lock.json ./

# Run as the builder user
USER builder

# Install dependencies
RUN npm ci

# Copy the rest of the files
# (In actual usage, you'll mount your code as a volume)
COPY . .

# Run the build
CMD ["npm", "run", "build"]