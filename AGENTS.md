# AGENTS.md

## Project Overview

`omp-discord-bot` is a Discord Gateway and process supervisor for **Oh My Pi (`omp`)**. It maps Discord threads directly to long-lived `omp` subprocess instances running in RPC mode (`omp --mode rpc`). Through this bridge, users manage full agent session lifecycles, stream model reasoning and tool execution in real-time, execute skills and native commands via Discord slash commands, and respond to interactive approval requests with Discord UI buttons.

---

## Tech Stack & Runtime

- **Runtime**: [Bun](https://bun.sh) (`>= 1.0`)
- **Language**: TypeScript (ESNext target, module resolution bundler, strict mode)
- **Frameworks & SDKs**: `discord.js` (v14.18+), `dotenv` (v16.4+)
- **Integration Target**: Oh My Pi CLI (`omp`) running via standard I/O RPC protocol v2
- **Daemonization**: Systemd user service (`scripts/init.sh`, `scripts/deinit.sh`, `scripts/run.sh`)

---

## Repository Structure

```text
omp-discord-bot/
├── .env.example          # Template for DISCORD_TOKEN and DISCORD_CLIENT_ID
├── .gitignore            # Git exclusions (node_modules, .env, tsconfig.tsbuildinfo, logs)
├── AGENTS.md             # Repository guidance and developer contract for AI agents
├── package.json          # Project manifest, dependencies, and execution scripts
├── README.md             # User-facing documentation and feature reference
├── scripts/
│   ├── init.sh           # Installs, configures, and enables the systemd user service
│   ├── run.sh            # Service launcher ensuring shell environment and .env loading
│   └── deinit.sh         # Stops, disables, and removes the systemd user service
├── src/
│   └── index.ts          # Core gateway: Discord client, RPC subprocess manager, event loop
└── tsconfig.json         # TypeScript compiler configuration (Bun types, noEmit)
```

---

## Development & Operational Commands

### Typecheck & Verification
```bash
# Type check without emitting JavaScript
bun x tsc --noEmit
```

### Local Development
```bash
# Start bot in foreground
bun run start

# Start bot in watch mode (auto-reload on source change)
bun run dev
```

### Service Management (Systemd User Daemon)
```bash
# Install and start user daemon
./scripts/init.sh

# Follow live output logs
journalctl --user -u omp-discord-bot.service -f

# Stop and remove user daemon
./scripts/deinit.sh
```

---

## Core Architecture & Invariants

### 1. Thread $\leftrightarrow$ Session 1:1 Mapping
- Each active `omp` process is anchored to a specific Discord `ThreadChannel`.
- The global `sessions` `Map<string, SessionContext>` indexes sessions strictly by `thread.id`.
- Slash commands and chat messages outside an indexed thread channel must be rejected or redirected to create a session first (`/omp-new`).
- When an `omp` subprocess exits (`proc.exited`), the session entry is deleted from the map and a notification is sent to the thread.

### 2. OMP RPC Lifecycle & Protocol Negotiation
- Subprocesses are spawned as `spawn(["omp", "--mode", "rpc"], { cwd, stdin: "pipe", stdout: "pipe", stderr: "inherit" })`.
- On receiving the `ready` frame from OMP stdout, the bot immediately negotiates protocol:
  ```json
  { "id": "init", "type": "negotiate_protocol", "protocolVersion": 2 }
  ```
- All outgoing RPC commands use JSON-delimited single lines written to `stdin` followed by `flush()`.

### 3. Output Streaming & Discord Rate Limiting
- **Throttling**: Edits to the active streaming prompt message (`session.activePromptMsg`) are throttled to at most once every **1200ms** to avoid Discord API rate limiting (HTTP 429).
- **Chunking / Length Limits**: Discord limits standard message content to 2000 characters.
  - Streaming updates slice the tail (last ~1900 chars) for live preview.
  - Final responses (`agent_end`) or long command outputs (`command_output`) are chunked into separate 1900–1950 character messages.

### 4. Interactive UI Approvals
- Confirmation requests (`extension_ui_request` with `method === "confirm"`) dynamically construct Discord `ActionRowBuilder` with `ButtonBuilder` (`Approve` / `Deny`).
- Responses are collected via `msg.awaitMessageComponent` with a configurable timeout (default: 30s).
- Responses are sent back over RPC as `extension_ui_response` (`confirmed: true/false` or `timedOut: true, cancelled: true`).

### 5. Metadata Discovery & Autocomplete Caching
- On startup, `fetchOmpMetadata()` spawns an ephemeral OMP RPC instance to query `get_available_commands` and `get_available_models`.
- Discovered commands and models are cached globally for Discord slash command autocomplete (`/cmd`, `/model`, `/skill`).

---

## Guidelines for Modifying Code

1. **Maintain Type Safety**: Always run `bun x tsc --noEmit` after editing TypeScript code.
2. **Respect Discord Constraints**: Never bypass message chunking (2000 chars) or edit rate limits (1200ms throttle).
3. **Preserve RPC Protocol Handshakes**: Do not alter event schema parsing without validating against the OMP RPC protocol v2 frames (`agent_start`, `message_update`, `tool_execution_start`, `extension_ui_request`, `command_output`, `agent_end`, `prompt_result`).
4. **Environment Isolation**: Never hardcode tokens or sensitive client credentials; read strictly from `process.env`.
