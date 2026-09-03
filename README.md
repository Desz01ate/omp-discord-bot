# OMP Discord Bridge

An interactive Discord Gateway for **Oh My Pi (`omp`)**, enabling complete session lifecycle management, live streaming, real-time command/skill execution, and interactive approvals directly inside Discord.

---

## Features

- **1:1 Thread $\leftrightarrow$ Session Mapping & Persistence**: Launching `/omp-new` creates a dedicated Discord thread with a generated `omp-session-*` name. The first prompt renames it to a status-prefixed topic (for example, `🟡 [ralph] Fix auth bug`) and later status transitions use `🟢` (idle), `🔴` (error), or `⏸️` (confirmation pending). Thread bindings survive bot restarts through a pluggable SQLite persistence layer (`SessionStore`).
- **Full Slash Command & Skill Bindings**:
  - `/skill <name> <prompt>` — Rich autocomplete for all OMX workflows (`$ralph`, `$plan`, `$deep-interview`, `$code-review`, `$tdd`, etc.).
  - `/cmd <command> [args]` — Rich autocomplete for all 102+ native OMP commands and subcommands (`/security`, `/advisor`, `/prewalk`, `/dump`, etc.).
  - `/model [selection]` — Real-time model switcher with context window indicators.
  - `/omp-new`, `/omp-terminate-all`, `/fast`, `/think`, `/compact`, `/abort`, `/status`, `/undo`, `/tree`, `/export`, `/download`, `/diff`, `/commit`.
- **Explicit Artifact Delivery (`upload_artifact`)**: Agents can upload generated files from the workspace directly to the active Discord thread via a native RPC host tool.
- **Interactive UI Approvals**: Confirmation requests (`extension_ui_request`) render as Discord **Action Buttons** (`Approve` / `Deny`) with timeout handling.
- **Systemd User Service & Docker**: One-command daemonization via `./scripts/init.sh` or isolated containerized deployment with `docker compose`.

---

## Prerequisites

- **[Bun](https://bun.sh)** (`>= 1.0`)
- **[Oh My Pi (`omp`)](https://github.com/)** installed and accessible in `PATH`
- **Discord Bot Token & Application Client ID**
  - Enable **Message Content Intent** under *Discord Developer Portal $\rightarrow$ Bot $\rightarrow$ Privileged Gateway Intents*.
  - Invite the bot to your server with permissions: `Send Messages`, `Create Public/Private Threads`, `Send Messages in Threads`, `Read Message History`.

---

## Setup & Configuration

1. **Clone / Navigate to Project Directory**:
   ```bash
   cd ~/Projects/omp-discord-bridge
   ```

2. **Configure Environment Variables**:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your Discord credentials:
   ```ini
   DISCORD_TOKEN=your_discord_bot_token_here
   DISCORD_CLIENT_ID=your_discord_application_client_id_here

   # (Optional) Restrict access to specific Discord user IDs (comma-separated)
   # ALLOWED_USERS=123456789012345678,987654321098765432
   ```

3. **Install Dependencies**:
   ```bash
   bun install
   ```

---

## Running the Bot

### Option A: Docker Compose (Recommended for Isolation & Portability)

Docker runs the bot and OMP in an isolated container with your code repositories bind-mounted from the host into `/workspace`.

1. In `.env`, specify the host repository directory and storage path to mount:
   ```ini
   HOST_WORKSPACE_PATH=/path/to/your/projects
   OMP_CONFIG_PATH=~/.omp
   HOST_DATA_PATH=./data
   ```
   Thread session bindings in SQLite are persistently stored on the host at `HOST_DATA_PATH` (defaults to `./data/sessions.sqlite`), surviving container rebuilds and `--force-recreate`.

2. Build and start with Docker Compose:
   ```bash
   # Build image and start in background
   docker compose up -d --build

   # View live logs
   docker compose logs -f

   # Stop the container
   docker compose down
   ```

When using `/omp-new`, relative directory paths (e.g. `/omp-new directory: my-repo`) resolve directly to subdirectories within `/workspace/my-repo`.

#### Adding Additional Runtimes (Go, Java, .NET, Rust, etc.)

You do not need to fork or edit the `Dockerfile` to add compilers and SDKs:

1. **Dynamic Per-Project Runtimes (`mise`)**:
   The container includes [`mise`](https://mise.jdx.dev/). If your project in `/workspace/my-repo` contains a `.mise.toml`, `mise` will automatically provide the configured SDKs:
   ```toml
   [tools]
   go = "1.23.0"
   java = "openjdk-21"
   dotnet = "8.0"
   rust = "latest"
   ```
   Toolchain binaries are persistently cached on the host at `HOST_MISE_DATA_PATH` (defaults to `~/.cache/omp-discord-bridge/mise`).

2. **System Packages via `.env`**:
   Specify extra Debian packages to bake in during `docker compose build`:
   ```ini
   EXTRA_APT_PACKAGES=golang-go default-jdk dotnet-sdk-8.0
   ```
   Then rebuild the container: `docker compose build`.


---

### Option B: Foreground (Development / Testing)

```bash
bun run start
```

---

### Option C: Background Daemon (Systemd User Service)

Run without `sudo` under your host user session:

```bash
# Enable and start systemd user service
./scripts/init.sh

# Follow live output logs
journalctl --user -u omp-discord-bot.service -f

# Stop and remove systemd service
./scripts/deinit.sh
```

---

## Discord Command Reference

### Session Management

| Command | Description |
|---|---|
| `/omp-new [directory]` | Spawns an OMP session rooted in `directory` (default: cwd) and creates a dedicated Discord thread with a generated `omp-session-*` name; the first prompt derives a bounded topic name. |
| `/omp-terminate-all` | Terminates all active on-server OMP sessions and deletes their associated Discord threads. |
| `/abort` | Interrupts and cancels the currently running model turn in the active thread. |
| `/status` | Displays an embed with active model, thinking level, fast mode state, token budget, and message count. |
| `/compact [instructions]` | Compacts conversation context with optional instructions. |
| `/undo` | Rolls back the previous turn. |
| `/tree` | Inspects the session branch tree. |
| `/export` | Exports the session transcript to an HTML file. |
| `/download [path]` | Downloads a file from the session workspace to the Discord thread (manual fallback for generated artifacts, subject to Discord's 25 MiB limit). |
| `/diff [staged] [path]` | Inspects git diffs in the session workspace. |
| `/commit [message]` | Commits staged or tracked changes in the session workspace. |

### Skills & Native Commands

| Command | Description |
|---|---|
| `/skill <name> <prompt>` | Runs any OMX skill workflow. Autocompletes all available skills (`ralph`, `autopilot`, `plan`, `deep-interview`, `code-review`, `tdd`, `ai-slop-cleaner`, etc.). |
| `/cmd <command> [args]` | Executes any native OMP slash command. Autocompletes across all 102+ native OMP commands and subcommands. |
| `/model [selection]` | Switches or views active LLM. Autocompletes available models (`openai/*`, `litellm/*`, `anthropic/*`). |
| `/fast [mode: on\|off\|status]` | Toggles provider fast mode. |
| `/think [level: off\|minimal\|low\|medium\|high\|xhigh\|max]` | Configures reasoning effort level. |

### In-Thread Chat

Inside any thread created by `/omp-new`:
- Plain text messages are dispatched directly to the agent as prompts.
- Inline syntax like `$ralph Fix test regressions` or `/model claude-sonnet-4-5` works seamlessly.

### Artifact Delivery (`upload_artifact`)

The bridge automatically registers the native OMP RPC host tool `upload_artifact` upon session initialization:
- **Explicit Invocations**: Agents invoke `upload_artifact(path="...", description="...")` when users request a generated file.
- **Security & Containment**: Paths are resolved relative to the session root (`session.cwd`). Traversals (`../`), absolute paths outside the workspace, and symlink escapes are strictly rejected.
- **Attachment Limits**: Enforces Discord's 25 MiB limit; files exceeding this limit return a structured error to the agent before upload.
- **Manual Fallback**: Users can manually retrieve any workspace file at any time with `/download <path>`.

---

## Project Structure

```text
omp-discord-bridge/
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript compiler configuration
├── Dockerfile            # Container image definition with Bun, OMP, and dev tools
├── docker-compose.yml    # Compose specification with host directory bind mount
├── .dockerignore         # Excluded files during Docker build
├── .env.example          # Environment variable template (Discord, LLMs, Docker paths)
├── README.md             # Documentation
├── scripts/
│   ├── init.sh           # Systemd user service installer and starter
│   ├── run.sh            # Service launcher script
│   └── deinit.sh         # Systemd user service stopper and remover
└── src/
    ├── index.ts          # Bot gateway, event loop, slash command registry
    ├── session-manager.ts # Composite session manager unifying hot processes and cold persistence
    └── storage/          # Pluggable persistence layer (SessionStore, SQLite, InMemory)
        ├── index.ts      # Storage factory and exports
        ├── types.ts      # SessionStore and SessionBinding contracts
        ├── sqlite.ts     # Bun SQLite implementation (WAL mode, upserts)
        └── memory.ts     # In-memory storage implementation
```
