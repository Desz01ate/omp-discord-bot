FROM oven/bun:1-debian AS base

# Install system utilities needed for git operations and coding tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    openssh-client \
    procps \
    python3 \
    python-is-python3 \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Link host user home to /root for hook path compatibility
RUN mkdir -p /home && ln -sf /root /home/deszolate

# Configure git safe directory for bind-mounted repositories
RUN git config --global --add safe.directory '*'

# Install Oh My Pi (omp) CLI globally
RUN bun install -g @oh-my-pi/pi-coding-agent
WORKDIR /app

# Install project dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Copy application source code and configuration
COPY tsconfig.json ./
COPY src/ ./src/

# Default workspace directory for bind-mounting host repositories
RUN mkdir -p /workspace

ENV WORKSPACE_ROOT=/workspace \
    NODE_ENV=production

# Start the Discord Bot Gateway
CMD ["bun", "run", "start"]
