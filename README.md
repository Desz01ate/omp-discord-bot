# OMP Discord Bot

An interactive Discord Gateway for **Oh My Pi (`omp`)**, enabling complete session lifecycle management, live streaming, real-time command/skill execution, and interactive approvals directly inside Discord.

---

## Features

- **1:1 Thread $\leftrightarrow$ Session Mapping**: Launching `/omp-new` creates a dedicated Discord thread formatted as `<directory_name> ($session_id)`.
- **Live Output Streaming**: Throttled streaming engine that renders LLM reasoning, code deltas, and tool updates smoothly while respecting Discord rate limits.
- **Full Slash Command & Skill Bindings**:
  - `/skill <name> <prompt>` — Rich autocomplete for all OMX workflows (`$ralph`, `$plan`, `$deep-interview`, `$code-review`, `$tdd`, etc.).
  - `/cmd <command> [args]` — Rich autocomplete for all 102+ native OMP commands and subcommands (`/security`, `/advisor`, `/prewalk`, `/dump`, etc.).
  - `/model [selection]` — Real-time model switcher with context window indicators.
  - `/fast`, `/think`, `/compact`, `/abort`, `/status`, `/undo`, `/tree`, `/export`.
- **Interactive UI Approvals**: Confirmation requests (`extension_ui_request`) render as Discord **Action Buttons** (`Approve` / `Deny`) with timeout handling.
- **Systemd User Service**: One-command daemonization via `./scripts/init.sh` and `./scripts/deinit.sh`.

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
   cd ~/Projects/omp-discord-bot
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
   ```

3. **Install Dependencies**:
   ```bash
   bun install
   ```

---

## Running the Bot

### Option A: Foreground (Development / Testing)

```bash
bun run start
```

### Option B: Background Daemon (Systemd User Service)

Run without `sudo` under your user session:

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
| `/omp-new [directory]` | Spawns a new OMP session rooted in `directory` (default: cwd) and creates a dedicated Discord thread `🧵 <directory_name> ($session_id)`. |
| `/abort` | Interrupts and cancels the currently running model turn in the active thread. |
| `/status` | Displays an embed with active model, thinking level, fast mode state, token budget, and message count. |
| `/compact [instructions]` | Compacts conversation context with optional instructions. |
| `/undo` | Rolls back the previous turn. |
| `/tree` | Inspects the session branch tree. |
| `/export` | Exports the session transcript to an HTML file. |

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

---

## Project Structure

```text
omp-discord-bot/
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript compiler configuration
├── .env.example          # Environment variable template
├── README.md             # Documentation
├── scripts/
│   ├── init.sh           # Systemd user service installer and starter
│   └── deinit.sh         # Systemd user service stopper and remover
└── src/
    └── index.ts          # Bot gateway, RPC manager, Discord event loop
```
