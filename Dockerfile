FROM oven/bun:1-debian AS base

# Build argument for optional user-specified system packages
ARG EXTRA_APT_PACKAGES=""

# Install system utilities needed for git operations, runtime management, and coding tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    openssh-client \
    procps \
    python3 \
    python-is-python3 \
    ripgrep \
    tar \
    xz-utils \
    unzip \
    ${EXTRA_APT_PACKAGES} \
    && rm -rf /var/lib/apt/lists/*

# Install mise-en-place for dynamic polyglot runtime management (Go, Java, .NET, Rust, etc.)
ENV MISE_DATA_DIR=/root/.local/share/mise \
    MISE_CONFIG_DIR=/root/.config/mise \
    MISE_CACHE_DIR=/root/.cache/mise \
    PATH="/root/.local/share/mise/shims:/root/.local/bin:$PATH"

RUN curl -fsSL https://mise.jdx.dev/install.sh | sh
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

# Entrypoint script for running startup hooks (/docker-entrypoint-init.d)
RUN mkdir -p /docker-entrypoint-init.d
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]

# Start the Discord Bot Gateway
CMD ["bun", "run", "start"]
