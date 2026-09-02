import {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ThreadChannel,
  Message,
  TextChannel,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  Events,
  type AutocompleteInteraction,
} from "discord.js";
import { spawn, type Subprocess } from "bun";
import { createInterface } from "readline";
import { Readable } from "stream";
import type { ReadableStream as WebReadableStream } from "stream/web";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error("Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment.");
  process.exit(1);
}
const ALLOWED_USERS_RAW = process.env.ALLOWED_USERS || process.env.WHITELISTED_USERS || "";
const allowedUserIds = new Set(
  ALLOWED_USERS_RAW.split(/[\s,]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
);

function isUserAllowed(userId: string): boolean {
  if (allowedUserIds.size === 0) return false;
  return allowedUserIds.has(userId);
}

type OmpProcess = Subprocess<"pipe", "pipe", "inherit">;

interface SessionContext {
  process: OmpProcess;
  threadId: string;
  cwd: string;
  activePromptMsg?: Message;
  currentStreamBuffer: string;
  lastEditTimestamp: number;
  activeToolStatus?: string;
  editTimer?: Timer;
  typingTimer?: Timer;
  initialStatePromise?: Promise<Record<string, unknown>>;
  resolveInitialState?: (state: Record<string, unknown>) => void;
}

interface OmpCommandMeta {
  name: string;
  description?: string;
  input?: { hint?: string };
  subcommands?: Array<{ name: string; description?: string }>;
  source?: string;
}

interface OmpModelMeta {
  id: string;
  name?: string;
  provider?: string;
  contextWindow?: number;
}

// Global cached metadata from OMP
let cachedCommands: OmpCommandMeta[] = [];
let cachedModels: OmpModelMeta[] = [];

const sessions = new Map<string, SessionContext>();

// Helper: send RPC command
function sendRpc(session: SessionContext, command: Record<string, unknown>): void {
  const line = JSON.stringify(command) + "\n";
  session.process.stdin.write(line);
  session.process.stdin.flush();
}

/**
 * Detect git branch or short commit hash for a directory if it is a git repo.
 */
async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const branchProc = spawn(["git", "-c", "safe.directory=*", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stderr: "ignore",
    });
    const branch = (await new Response(branchProc.stdout).text()).trim();
    if (branch && branch !== "HEAD") return branch;

    const commitProc = spawn(["git", "-c", "safe.directory=*", "rev-parse", "--short", "HEAD"], {
      cwd,
      stderr: "ignore",
    });
    const commit = (await new Response(commitProc.stdout).text()).trim();
    return commit ? `detached@${commit}` : null;
  } catch {
    return null;
  }
}

/**
 * Retrieve OMP advisor configuration (enabled status and assigned model role).
 */
async function getAdvisorConfig(cwd?: string): Promise<{ enabled: boolean; model: string | null }> {
  try {
    const [enabledProc, rolesProc] = [
      spawn(["omp", "config", "get", "advisor.enabled"], cwd ? { cwd, stderr: "ignore" } : { stderr: "ignore" }),
      spawn(["omp", "config", "get", "modelRoles"], cwd ? { cwd, stderr: "ignore" } : { stderr: "ignore" }),
    ];

    const [enabledOut, rolesOut] = await Promise.all([
      new Response(enabledProc.stdout).text(),
      new Response(rolesProc.stdout).text(),
    ]);

    const enabled = enabledOut.trim() === "true";
    let model: string | null = null;
    try {
      const roles = JSON.parse(rolesOut.trim());
      if (roles && typeof roles === "object" && roles.advisor) {
        model = String(roles.advisor);
      }
    } catch {}

    return { enabled, model };
  } catch {
    return { enabled: false, model: null };
  }
}

// Fetch available commands and models on startup
async function fetchOmpMetadata(): Promise<{ commands: OmpCommandMeta[]; models: OmpModelMeta[] }> {
  console.log("Discovering native OMP commands & models...");
  const proc = spawn(["omp", "--mode", "rpc"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  const nodeStdout = Readable.fromWeb(proc.stdout as unknown as WebReadableStream);
  const readline = createInterface({ input: nodeStdout, terminal: false });

  let fetchedCommands: OmpCommandMeta[] = [];
  let fetchedModels: OmpModelMeta[] = [];

  const donePromise = new Promise<void>((resolve) => {
    let gotCommands = false;
    let gotModels = false;

    readline.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const frame: unknown = JSON.parse(line);
        if (!frame || typeof frame !== "object") return;
        const obj = frame as Record<string, unknown>;

        if (obj.type === "ready") {
          proc.stdin.write(JSON.stringify({ id: "cmd_req", type: "get_available_commands" }) + "\n");
          proc.stdin.write(JSON.stringify({ id: "model_req", type: "get_available_models" }) + "\n");
          proc.stdin.flush();
        } else if (obj.type === "response" && obj.command === "get_available_commands") {
          const data = obj.data as { commands?: OmpCommandMeta[] } | undefined;
          fetchedCommands = data?.commands || [];
          gotCommands = true;
        } else if (obj.type === "response" && obj.command === "get_available_models") {
          const data = obj.data as { models?: OmpModelMeta[] } | undefined;
          fetchedModels = data?.models || [];
          gotModels = true;
        }

        if (gotCommands && gotModels) {
          resolve();
        }
      } catch {}
    });

    setTimeout(resolve, 3000);
  });

  await donePromise;
  proc.kill();

  console.log(`Discovered ${fetchedCommands.length} native OMP commands and ${fetchedModels.length} models.`);
  return { commands: fetchedCommands, models: fetchedModels };
}

// List of standard OMX skills for autocomplete
const OMX_SKILLS = [
  { name: "ralph", description: "Self-referential loop until task completion with architect verification" },
  { name: "autopilot", description: "Autonomous pipeline: $ralplan -> $ralph -> $code-review" },
  { name: "plan", description: "Strategic planning with optional interview workflow" },
  { name: "ralplan", description: "Consensus planning with RALPLAN-DR structured deliberation" },
  { name: "deep-interview", description: "Socratic deep interview with ambiguity gating" },
  { name: "code-review", description: "Run comprehensive code review" },
  { name: "security-review", description: "Run security audit across workspace" },
  { name: "tdd", description: "Test-driven development workflow" },
  { name: "ai-slop-cleaner", description: "Anti-slop cleanup, refactor, and deslop workflow" },
  { name: "ultrawork", description: "Parallel execution engine for high-throughput task completion" },
  { name: "ultraqa", description: "QA cycling workflow: test, verify, fix, repeat" },
  { name: "team", description: "Coordinated agents on shared task list using tmux-based orchestration" },
  { name: "ecomode", description: "Enable token-efficient mode" },
];

// Build Discord Slash Commands
function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName("omp-new")
      .setDescription("Start a new OMP session in a dedicated thread")
      .addStringOption((opt) =>
        opt
          .setName("directory")
          .setDescription("Working directory path (default: WORKSPACE_ROOT or current directory)")
          .setAutocomplete(true)
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName("model")
          .setDescription("Initial model to use for the session")
          .setAutocomplete(true)
          .setRequired(false),
      ),

    // 2. Skill runner with rich autocomplete
    new SlashCommandBuilder()
      .setName("skill")
      .setDescription("Run an OMP skill workflow ($skill)")
      .addStringOption((opt) =>
        opt
          .setName("name")
          .setDescription("Skill name (e.g. ralph, plan, deep-interview, code-review)")
          .setAutocomplete(true)
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("prompt")
          .setDescription("Task instructions or prompt for the skill")
          .setRequired(true),
      ),

    // 3. Native command runner with rich autocomplete for all 100+ OMP commands
    new SlashCommandBuilder()
      .setName("cmd")
      .setDescription("Execute any native OMP slash command (/command)")
      .addStringOption((opt) =>
        opt
          .setName("command")
          .setDescription("OMP native command name")
          .setAutocomplete(true)
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("args")
          .setDescription("Arguments for the command")
          .setRequired(false),
      ),

    // 4. Model selector with dynamic autocomplete
    new SlashCommandBuilder()
      .setName("model")
      .setDescription("Switch or inspect the active LLM model")
      .addStringOption((opt) =>
        opt
          .setName("selection")
          .setDescription("Target model")
          .setAutocomplete(true)
          .setRequired(false),
      ),

    // 5. Fast mode toggle
    new SlashCommandBuilder()
      .setName("fast")
      .setDescription("Toggle fast mode")
      .addStringOption((opt) =>
        opt
          .setName("mode")
          .setDescription("Turn fast mode on or off")
          .setRequired(false)
          .addChoices(
            { name: "on", value: "on" },
            { name: "off", value: "off" },
            { name: "status", value: "status" },
          ),
      ),

    // 6. Thinking level
    new SlashCommandBuilder()
      .setName("think")
      .setDescription("Set reasoning thinking level")
      .addStringOption((opt) =>
        opt
          .setName("level")
          .setDescription("Thinking level")
          .setRequired(true)
          .addChoices(
            { name: "off", value: "off" },
            { name: "minimal", value: "minimal" },
            { name: "low", value: "low" },
            { name: "medium", value: "medium" },
            { name: "high", value: "high" },
            { name: "xhigh", value: "xhigh" },
            { name: "max", value: "max" },
          ),
      ),

    // 7. Core control commands
    new SlashCommandBuilder().setName("abort").setDescription("Abort the current running turn"),
    new SlashCommandBuilder().setName("status").setDescription("View token usage, model, and session state"),
    new SlashCommandBuilder().setName("compact").setDescription("Trigger context compaction")
      .addStringOption((opt) =>
        opt.setName("instructions").setDescription("Custom compaction instructions").setRequired(false),
      ),
    new SlashCommandBuilder().setName("undo").setDescription("Undo previous turn"),
    new SlashCommandBuilder().setName("tree").setDescription("Show session branch tree"),
    new SlashCommandBuilder().setName("export").setDescription("Export session to HTML"),
  ].map((c) => c.toJSON());
}

// Fetch metadata and register commands on Discord
const metadata = await fetchOmpMetadata();
cachedCommands = metadata.commands;
cachedModels = metadata.models;

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
console.log("Registering Discord Slash Commands...");
await rest.put(Routes.applicationCommands(CLIENT_ID), { body: buildSlashCommands() });
console.log("All Discord Slash Commands registered successfully.");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// Spawn OMP RPC instance for a thread
function createOmpSession(thread: ThreadChannel, cwd: string, initialModel?: string): SessionContext {
  let resolveInitialState: ((state: Record<string, unknown>) => void) | undefined;
  const initialStatePromise = new Promise<Record<string, unknown>>((resolve) => {
    resolveInitialState = resolve;
    setTimeout(() => resolve({}), 3000);
  });

  const args = ["omp", "--mode", "rpc"];
  if (initialModel) {
    args.push(`--model=${initialModel}`);
  }

  const proc = spawn(args, {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  const session: SessionContext = {
    process: proc,
    threadId: thread.id,
    cwd,
    currentStreamBuffer: "",
    lastEditTimestamp: 0,
    initialStatePromise,
    resolveInitialState,
  };

  const nodeStdout = Readable.fromWeb(proc.stdout as unknown as WebReadableStream);
  const readline = createInterface({
    input: nodeStdout,
    terminal: false,
  });

  readline.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const event: unknown = JSON.parse(line);
      if (event && typeof event === "object") {
        void handleRpcEvent(session, thread, event as Record<string, unknown>);
      }
    } catch (err) {
      console.error("RPC parse error:", err);
    }
  });

  proc.exited.then((code) => {
    stopTyping(session);
    if (session.editTimer) {
      clearTimeout(session.editTimer);
      session.editTimer = undefined;
    }
    void thread.send(`⚠️ OMP process exited (code ${code}).`).catch(() => {});
    sessions.delete(thread.id);
  });

  return session;
}

/**
 * Format tool execution details into a concise, user-friendly status line.
 */
function formatToolStatus(toolName: string, rawArgs?: unknown, rawIntent?: unknown): string {
  const intent = typeof rawIntent === "string" ? rawIntent.trim() : "";
  if (intent) {
    return `⚡ *${intent}* (\`${toolName}\`)`;
  }

  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;

  if (toolName === "bash" && typeof args.command === "string") {
    const cmd = args.command.trim();
    const shortCmd = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    return `🔧 \`bash\`: \`${shortCmd}\``;
  }

  if ((toolName === "read" || toolName === "write" || toolName === "edit") && typeof args.path === "string") {
    return `📄 \`${toolName}\`: \`${args.path}\``;
  }

  if (toolName === "grep") {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    return `🔍 \`grep\`: \`${pattern}\``;
  }

  if (toolName === "glob") {
    const pattern = typeof args.path === "string" ? args.path : "";
    return `📂 \`glob\`: \`${pattern}\``;
  }

  if (toolName === "eval" && typeof args.title === "string") {
    return `⚙️ \`eval\`: *${args.title}*`;
  }

  if (toolName === "lsp" && typeof args.action === "string") {
    return `🧠 \`lsp\`: *${args.action}*`;
  }

  return `🔧 *Running \`${toolName}\`...*`;
}

/**
 * Markdown-aware message splitter that splits cleanly on line boundaries and preserves code fences.
 */
function splitDiscordMessage(text: string, maxLength = 1950): string[] {
  if (!text || text.length <= maxLength) {
    return [text || ""];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = -1;
    const window = remaining.slice(0, maxLength);

    // 1. Prefer paragraph breaks
    const lastParagraph = window.lastIndexOf("\n\n");
    if (lastParagraph > maxLength * 0.4) {
      splitIndex = lastParagraph + 2;
    } else {
      // 2. Line breaks
      const lastLine = window.lastIndexOf("\n");
      if (lastLine > maxLength * 0.4) {
        splitIndex = lastLine + 1;
      } else {
        // 3. Word spaces
        const lastSpace = window.lastIndexOf(" ");
        if (lastSpace > maxLength * 0.4) {
          splitIndex = lastSpace + 1;
        } else {
          splitIndex = maxLength;
        }
      }
    }

    let chunk = remaining.slice(0, splitIndex);
    remaining = remaining.slice(splitIndex);

    // Track open/closed markdown code fences across chunks
    const lines = chunk.split("\n");
    let currentFence: string | null = null;

    for (const line of lines) {
      const match = line.match(/^(\s*)(```+|~~~+)(.*)$/);
      if (match) {
        const marker = match[2];
        const info = match[3].trim();
        if (currentFence === null) {
          currentFence = marker + (info ? info : "");
        } else {
          const fenceType = currentFence.startsWith("~") ? "~" : "`";
          if (marker.startsWith(fenceType)) {
            currentFence = null;
          }
        }
      }
    }

    if (currentFence !== null) {
      const fenceType = currentFence.startsWith("~") ? "~~~" : "```";
      chunk += `\n${fenceType}`;
      remaining = `${currentFence}\n` + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Flush the active live preview to Discord.
 */
async function flushActivePromptMessage(session: SessionContext): Promise<void> {
  if (session.editTimer) {
    clearTimeout(session.editTimer);
    session.editTimer = undefined;
  }
  if (!session.activePromptMsg) return;

  const now = Date.now();
  session.lastEditTimestamp = now;

  let displayContent = "";
  if (session.currentStreamBuffer) {
    const textTail = session.currentStreamBuffer.slice(-1800);
    if (session.activeToolStatus) {
      displayContent = `${textTail}\n\n${session.activeToolStatus}`;
    } else {
      displayContent = textTail;
    }
  } else {
    displayContent = session.activeToolStatus || "🤔 *Thinking...*";
  }

  if (displayContent.length > 1950) {
    displayContent = displayContent.slice(-1950);
  }

  await session.activePromptMsg.edit(displayContent).catch(() => {});
}
/**
 * Start or refresh typing indicator in Discord thread.
 */
function startTyping(session: SessionContext, thread: ThreadChannel): void {
  if (session.typingTimer) {
    clearInterval(session.typingTimer);
    session.typingTimer = undefined;
  }
  void thread.sendTyping().catch(() => {});
  session.typingTimer = setInterval(() => {
    void thread.sendTyping().catch(() => {});
  }, 8000);
}

/**
 * Stop typing indicator in Discord thread.
 */
function stopTyping(session: SessionContext): void {
  if (session.typingTimer) {
    clearInterval(session.typingTimer);
    session.typingTimer = undefined;
  }
}


/**
 * Schedule throttled live update for Discord (~1 edit every 1.2s).
 */
function scheduleActivePromptUpdate(session: SessionContext): void {
  if (!session.activePromptMsg) return;
  const now = Date.now();
  const elapsed = now - session.lastEditTimestamp;
  const THROTTLE_MS = 1200;

  if (elapsed >= THROTTLE_MS) {
    void flushActivePromptMessage(session);
  } else if (!session.editTimer) {
    session.editTimer = setTimeout(() => {
      session.editTimer = undefined;
      void flushActivePromptMessage(session);
    }, THROTTLE_MS - elapsed);
  }
}

// Handle RPC Frames & Events
async function handleRpcEvent(
  session: SessionContext,
  thread: ThreadChannel,
  event: Record<string, unknown>,
): Promise<void> {
  const type = typeof event.type === "string" ? event.type : "";

  // 1. Ready & Protocol Negotiation
  if (type === "ready") {
    sendRpc(session, {
      id: "init",
      type: "negotiate_protocol",
      protocolVersion: 2,
    });
    sendRpc(session, {
      id: "init_state",
      type: "get_state",
    });
    return;
  }

  // 2. Turn Start
  if (type === "agent_start") {
    if (session.editTimer) {
      clearTimeout(session.editTimer);
      session.editTimer = undefined;
    }
    session.currentStreamBuffer = "";
    session.activeToolStatus = undefined;
    session.activePromptMsg = await thread.send("🤔 *Thinking...*");
    session.lastEditTimestamp = Date.now();
    startTyping(session, thread);
    return;
  }

  // 3. Streaming Text Updates
  if (type === "message_update") {
    const assistantMessageEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
    const ameType = typeof assistantMessageEvent?.type === "string" ? assistantMessageEvent.type : "";

    // Only stream real assistant text_delta (avoid toolcall JSON and internal thinking leaking into stream)
    if (ameType === "text_delta") {
      const delta = typeof assistantMessageEvent?.delta === "string" ? assistantMessageEvent.delta : undefined;
      if (delta) {
        session.currentStreamBuffer += delta;
        scheduleActivePromptUpdate(session);
      }
    } else if (ameType === "thinking_start" || ameType === "thinking_delta") {
      if (!session.currentStreamBuffer && !session.activeToolStatus) {
        scheduleActivePromptUpdate(session);
      }
    }
    return;
  }

  // 4. Tool Execution Events
  if (type === "tool_execution_start") {
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    const args = (event.args || event.input || {}) as Record<string, unknown>;
    const intent = typeof event.intent === "string" ? event.intent : undefined;

    session.activeToolStatus = formatToolStatus(toolName, args, intent);
    scheduleActivePromptUpdate(session);
    return;
  }

  if (type === "tool_execution_end") {
    session.activeToolStatus = undefined;
    scheduleActivePromptUpdate(session);
    return;
  }

  if (type === "turn_start" || type === "turn_end") {
    session.activeToolStatus = undefined;
    return;
  }

  // 5. Interactive UI / Approval Request (Buttons in Discord)
  if (type === "extension_ui_request") {
    const method = typeof event.method === "string" ? event.method : "";
    const id = typeof event.id === "string" ? event.id : "";
    const messageText = typeof event.message === "string" ? event.message : "Confirmation needed";

    if (method === "confirm" && id) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve_${id}`)
          .setLabel("Approve")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`reject_${id}`)
          .setLabel("Deny")
          .setStyle(ButtonStyle.Danger),
      );

      const msg = await thread.send({
        content: `⚠️ **Action Required**: ${messageText}`,
        components: [row],
      });

      const timeoutSeconds = typeof event.timeout === "number" ? event.timeout : 30;
      const confirmation = await msg
        .awaitMessageComponent({
          componentType: ComponentType.Button,
          filter: async (btnInteraction) => {
            if (!isUserAllowed(btnInteraction.user.id)) {
              await btnInteraction.reply({
                content: "⛔ You are not authorized to respond to this approval request.",
                flags: MessageFlags.Ephemeral,
              });
              return false;
            }
            return true;
          },
          time: timeoutSeconds * 1000,
        })
        .catch(() => null);

      if (!confirmation) {
        sendRpc(session, {
          type: "extension_ui_response",
          id,
          cancelled: true,
          timedOut: true,
        });
        await msg.edit({ content: `⏳ *Approval timed out*`, components: [] }).catch(() => {});
      } else {
        const approved = confirmation.customId.startsWith("approve");
        sendRpc(session, {
          type: "extension_ui_response",
          id,
          confirmed: approved,
        });
        await confirmation
          .update({
            content: approved
              ? `✅ Approved by <@${confirmation.user.id}>`
              : `❌ Denied by <@${confirmation.user.id}>`,
            components: [],
          })
          .catch(() => {});
      }
    }
    return;
  }

  // 6. Built-in / Local Slash Command Outputs
  if (type === "command_output") {
    const rawOutput =
      typeof event.output === "string"
        ? event.output
        : typeof event.text === "string"
          ? event.text
          : typeof event.content === "string"
            ? event.content
            : JSON.stringify(event);

    const trimmed = rawOutput.trim();
    if (trimmed) {
      const formatted = trimmed.startsWith("```") ? trimmed : `\`\`\`\n${trimmed}\n\`\`\``;
      const chunks = splitDiscordMessage(formatted, 1900);
      for (const chunk of chunks) {
        await thread.send(chunk).catch(() => {});
      }
    }
    return;
  }

  // 7. Response frames (e.g. state / custom query results)
  if (type === "response" && event.command === "get_state" && event.data && typeof event.data === "object") {
    const data = event.data as Record<string, unknown>;
    if (session.resolveInitialState) {
      session.resolveInitialState(data);
      session.resolveInitialState = undefined;
    }

    if (event.id === "status_req") {
      const model = data.model as { provider?: string; id?: string; name?: string } | undefined;
      const modelStr = model ? `${model.provider ? `${model.provider}/` : ""}${model.id}${model.name ? ` (${model.name})` : ""}` : "unknown";
      const tokens = (data.contextUsage as { tokens?: number; contextWindow?: number; percent?: number }) || {};

      const [advisorConfig, branch] = await Promise.all([
        getAdvisorConfig(session.cwd),
        getGitBranch(session.cwd),
      ]);

      const advisorText = advisorConfig.enabled
        ? `🟢 On${advisorConfig.model ? ` (\`${advisorConfig.model}\`)` : ""}`
        : "🔴 Off";
      const branchText = branch ? `\`${branch}\`` : "*None*";

      const embed = new EmbedBuilder()
        .setTitle("📊 OMP Session Status")
        .setColor(0x5865f2)
        .addFields(
          { name: "🤖 Model", value: `\`${modelStr}\``, inline: true },
          { name: "🧠 Thinking Level", value: `\`${String(data.thinkingLevel || "normal")}\``, inline: true },
          { name: "⚡ Fast Mode", value: data.fastModeActive ? "⚡ Active" : "Off", inline: true },
          { name: "🛡️ Advisor", value: advisorText, inline: true },
          { name: "🌿 Git Branch", value: branchText, inline: true },
          {
            name: "Context Usage",
            value: tokens.tokens != null ? `${tokens.tokens.toLocaleString()} / ${tokens.contextWindow?.toLocaleString()} (${Math.round((tokens.percent || 0) * 100)}%)` : "N/A",
            inline: true,
          },
          { name: "📁 Directory", value: `\`${session.cwd}\``, inline: false },
          { name: "💬 Messages", value: `${data.messageCount ?? 0} in session`, inline: true },
        );

      await thread.send({ embeds: [embed] }).catch(() => {});
    }
    return;
  }

  // 8. Turn Finish
  if (type === "agent_end") {
    stopTyping(session);
    if (session.editTimer) {
      clearTimeout(session.editTimer);
      session.editTimer = undefined;
    }

    if (session.activePromptMsg) {
      const full = session.currentStreamBuffer.trim();
      if (full) {
        const chunks = splitDiscordMessage(full, 1950);
        await session.activePromptMsg.edit(chunks[0]).catch(() => {});
        for (let i = 1; i < chunks.length; i++) {
          await thread.send(chunks[i]).catch(() => {});
        }
      } else {
        await session.activePromptMsg.edit("✅ *Completed.*").catch(() => {});
      }
    }

    session.activePromptMsg = undefined;
    session.currentStreamBuffer = "";
    session.activeToolStatus = undefined;
    return;
  }

  // 9. Prompt Result without agent turn (Local command completion)
  if (type === "prompt_result" && event.agentInvoked === false) {
    stopTyping(session);
    if (session.editTimer) {
      clearTimeout(session.editTimer);
      session.editTimer = undefined;
    }
    if (session.activePromptMsg) {
      await session.activePromptMsg.delete().catch(() => {});
      session.activePromptMsg = undefined;
    }
    session.currentStreamBuffer = "";
    session.activeToolStatus = undefined;
  }
}

function getModelSuggestions(queryRaw: string): Array<{ name: string; value: string }> {
  const query = queryRaw.toLowerCase();
  return cachedModels
    .filter((m) => m.id.toLowerCase().includes(query) || (m.name && m.name.toLowerCase().includes(query)))
    .slice(0, 25)
    .map((m) => ({
      name: `${m.name || m.id} [${m.provider || "omp"}] (${Math.round((m.contextWindow || 0) / 1000)}k ctx)`.slice(0, 100),
      value: m.id,
    }));
}

function getDirectorySuggestions(input: string): Array<{ name: string; value: string }> {
  const rootDir = process.env.WORKSPACE_ROOT || process.env.DEFAULT_WORKSPACE_DIR || process.cwd();
  const suggestions: Array<{ name: string; value: string }> = [];

  try {
    const rawInput = input.trim();
    const expanded = rawInput.startsWith("~")
      ? rawInput.replace(/^~(?=$|\/|\\)/, process.env.HOME || "")
      : rawInput;

    if (!rawInput) {
      suggestions.push({
        name: `📁 . (Root: ${basename(rootDir) || rootDir})`,
        value: ".",
      });
      if (existsSync(rootDir)) {
        const entries = readdirSync(rootDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
            suggestions.push({
              name: `📁 ${entry.name}/`,
              value: entry.name,
            });
          }
        }
      }
      return suggestions.slice(0, 25);
    }

    const isAbs = isAbsolute(expanded) || rawInput.startsWith("~");
    const targetPath = isAbs ? resolve(expanded) : resolve(rootDir, expanded);

    let searchDir = targetPath;
    let filePrefix = "";

    const endsWithSlash = rawInput.endsWith("/") || rawInput.endsWith("\\");
    if (!endsWithSlash && existsSync(targetPath) && statSync(targetPath).isDirectory()) {
      searchDir = targetPath;
      filePrefix = "";
    } else if (!endsWithSlash) {
      searchDir = dirname(targetPath);
      filePrefix = basename(targetPath).toLowerCase();
    }

    if (existsSync(searchDir) && statSync(searchDir).isDirectory()) {
      if (searchDir === targetPath && existsSync(targetPath)) {
        suggestions.push({
          name: `📁 ${rawInput} (current)`,
          value: rawInput,
        });
      }

      const entries = readdirSync(searchDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if ((entry.name.startsWith(".") || entry.name === "node_modules") && !filePrefix.startsWith(".") && filePrefix !== "node_modules") continue;
        if (filePrefix && !entry.name.toLowerCase().startsWith(filePrefix)) continue;

        let val: string;
        if (isAbs) {
          val = join(searchDir, entry.name);
        } else {
          const relToRoot = relative(rootDir, join(searchDir, entry.name));
          val = relToRoot.startsWith(".") ? relToRoot : `./${relToRoot}`;
        }
        suggestions.push({
          name: `📁 ${entry.name}/ (${val})`.slice(0, 100),
          value: val.slice(0, 100),
        });
      }
    }
  } catch {
    // Return collected suggestions safely on filesystem or permission error
  }

  return suggestions.slice(0, 25);
}

// Handle Autocomplete Interactions
async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);

  // New session autocomplete (directory & model)
  if (interaction.commandName === "omp-new") {
    if (focused.name === "directory") {
      const suggestions = getDirectorySuggestions(focused.value);
      await interaction.respond(suggestions);
      return;
    }
    if (focused.name === "model" || focused.name === "selection") {
      const filtered = getModelSuggestions(focused.value);
      await interaction.respond(filtered);
      return;
    }
  }

  // Skill autocomplete
  if (interaction.commandName === "skill" && focused.name === "name") {
    const query = focused.value.toLowerCase();
    const filtered = OMX_SKILLS
      .filter((s) => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query))
      .slice(0, 25)
      .map((s) => ({
        name: `$${s.name} — ${s.description.slice(0, 80)}`,
        value: s.name,
      }));
    await interaction.respond(filtered);
    return;
  }

  // Native OMP Command autocomplete
  if (interaction.commandName === "cmd" && focused.name === "command") {
    const query = focused.value.toLowerCase();
    const filtered = cachedCommands
      .filter((c) => c.name.toLowerCase().includes(query) || (c.description && c.description.toLowerCase().includes(query)))
      .slice(0, 25)
      .map((c) => ({
        name: `/${c.name} ${c.input?.hint || ""} ${c.description ? `(${c.description.slice(0, 60)})` : ""}`.trim().slice(0, 100),
        value: c.name,
      }));
    await interaction.respond(filtered);
    return;
  }

  // Model autocomplete
  if (interaction.commandName === "model" && focused.name === "selection") {
    const filtered = getModelSuggestions(focused.value);
    await interaction.respond(filtered);
    return;
  }
}


// Handle Slash Command Executions
client.on("interactionCreate", async (interaction) => {
  if (!isUserAllowed(interaction.user.id)) {
    if (interaction.isAutocomplete()) {
      await interaction.respond([]);
      return;
    }
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: "⛔ You are not authorized to use this bot.",
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // New Session
  if (interaction.commandName === "omp-new") {
    const channel = interaction.channel;
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      await interaction.reply({
        content: "Please run this command in a standard guild text channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const textChannel = channel as TextChannel;
    const rootDir = process.env.WORKSPACE_ROOT || process.env.DEFAULT_WORKSPACE_DIR || process.cwd();
    const inputDir = interaction.options.getString("directory");
    const inputModel = interaction.options.getString("model");
    const rawCwd = inputDir || rootDir;
    const expandedRawCwd = rawCwd.startsWith("~")
      ? rawCwd.replace(/^~(?=$|\/|\\)/, process.env.HOME || "")
      : rawCwd;
    const cwd = resolve(rootDir, expandedRawCwd);

    if (!existsSync(cwd)) {
      await interaction.reply({
        content: `❌ Directory \`${cwd}\` does not exist. Please specify a valid directory.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const dirName = basename(cwd) || "workspace";
    const sessionId = Math.random().toString(36).slice(2, 8);
    const threadName = `${dirName} (${sessionId})`.slice(0, 100);

    await interaction.deferReply();

    try {
      const thread = await textChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 1440,
      });

      const session = createOmpSession(thread, cwd, inputModel || undefined);
      sessions.set(thread.id, session);

      const [state, advisorConfig, branch] = await Promise.all([
        session.initialStatePromise,
        getAdvisorConfig(cwd),
        getGitBranch(cwd),
      ]);

      const modelData = (state?.model as { id?: string; name?: string; provider?: string } | undefined) || {};
      const modelDisplay = modelData.id
        ? `${modelData.provider ? `${modelData.provider}/` : ""}${modelData.id}${modelData.name ? ` (${modelData.name})` : ""}`
        : (inputModel || "default");

      const thinkingLevel = typeof state?.thinkingLevel === "string" ? state.thinkingLevel : "normal";
      const fastMode = Boolean(state?.fastModeActive);

      const advisorText = advisorConfig.enabled
        ? `🟢 On${advisorConfig.model ? ` (\`${advisorConfig.model}\`)` : ""}`
        : "🔴 Off";

      const branchText = branch ? `\`${branch}\`` : "*None (not a git repo)*";

      const sessionEmbed = new EmbedBuilder()
        .setTitle("👋 OMP Session Active")
        .setColor(0x5865f2)
        .setDescription(
          "Type directly in this thread to prompt the agent, or use slash commands (`/skill`, `/cmd`, `/model`, `/fast`, `/think`, `/compact`, `/status`, `/abort`).",
        )
        .addFields(
          { name: "🤖 Active Model", value: `\`${modelDisplay}\``, inline: true },
          { name: "🛡️ Advisor", value: advisorText, inline: true },
          { name: "🌿 Git Branch", value: branchText, inline: true },
          { name: "📁 Working Directory", value: `\`${cwd}\``, inline: false },
          { name: "🧠 Thinking Level", value: `\`${thinkingLevel}\``, inline: true },
          { name: "⚡ Fast Mode", value: fastMode ? "⚡ Active" : "Off", inline: true },
        )
        .setTimestamp();

      await interaction.editReply(
        `🚀 Session started in <#${thread.id}>\n📁 Directory: \`${cwd}\`\n🤖 Model: \`${modelDisplay}\``,
      );
      await thread.send({
        embeds: [sessionEmbed],
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await interaction.editReply(`Failed to start session: ${errorMsg}`);
    }
    return;
  }

  // Session-bound Slash Commands
  const session = sessions.get(interaction.channelId);
  if (!session) {
    await interaction.reply({
      content: "⚠️ This command must be executed inside an active OMP thread created by `/omp-new`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // /skill [name] [prompt]
  if (interaction.commandName === "skill") {
    const skillName = interaction.options.getString("name", true);
    const prompt = interaction.options.getString("prompt", true);
    const fullPrompt = `$${skillName} ${prompt}`;

    if (interaction.channel?.isThread()) {
      startTyping(session, interaction.channel);
    }
    await interaction.reply(`🎯 Invoking skill \`$${skillName}\`...`);
    sendRpc(session, {
      id: `skill_${Date.now()}`,
      type: "prompt",
      message: fullPrompt,
    });
    return;
  }

  // /cmd [command] [args]
  if (interaction.commandName === "cmd") {
    const cmdName = interaction.options.getString("command", true);
    const args = interaction.options.getString("args") || "";
    const fullCommand = `/${cmdName} ${args}`.trim();

    if (interaction.channel?.isThread()) {
      startTyping(session, interaction.channel);
    }
    await interaction.reply(`⚡ Running command \`${fullCommand}\`...`);
    sendRpc(session, {
      id: `cmd_${Date.now()}`,
      type: "prompt",
      message: fullCommand,
    });
    return;
  }


  // /model [selection]
  if (interaction.commandName === "model") {
    const selection = interaction.options.getString("selection");
    if (selection) {
      await interaction.reply(`🔄 Switching model to \`${selection}\`...`);
      sendRpc(session, {
        id: `model_${Date.now()}`,
        type: "prompt",
        message: `/model ${selection}`,
      });
    } else {
      await interaction.reply(`🔍 Fetching current model...`);
      sendRpc(session, { id: "model_info", type: "prompt", message: "/model" });
    }
    return;
  }

  // /fast [mode]
  if (interaction.commandName === "fast") {
    const mode = interaction.options.getString("mode") || "status";
    if (mode === "status") {
      await interaction.reply(`⚡ Checking fast mode...`);
      sendRpc(session, { id: "fast_status", type: "prompt", message: "/fast status" });
    } else {
      const enabled = mode === "on";
      await interaction.reply(`⚡ Setting fast mode to \`${mode}\`...`);
      sendRpc(session, { id: "fast_set", type: "set_fast_mode", enabled });
    }
    return;
  }

  // /think [level]
  if (interaction.commandName === "think") {
    const level = interaction.options.getString("level", true);
    await interaction.reply(`🧠 Setting thinking level to \`${level}\`...`);
    sendRpc(session, { id: "think_set", type: "set_thinking_level", level });
    return;
  }

  // /abort
  if (interaction.commandName === "abort") {
    sendRpc(session, { type: "abort" });
    await interaction.reply("🛑 Turn abort requested.");
    return;
  }

  // /status
  if (interaction.commandName === "status") {
    sendRpc(session, { id: "status_req", type: "get_state" });
    await interaction.reply("📊 Fetching session status...");
    return;
  }

  // /compact [instructions]
  if (interaction.commandName === "compact") {
    const instructions = interaction.options.getString("instructions") || undefined;
    sendRpc(session, { type: "compact", customInstructions: instructions });
    await interaction.reply("🧹 Context compaction triggered.");
    return;
  }

  // /undo
  if (interaction.commandName === "undo") {
    await interaction.reply("↩️ Undoing last turn...");
    sendRpc(session, { id: "undo_req", type: "prompt", message: "/undo" });
    return;
  }

  // /tree
  if (interaction.commandName === "tree") {
    await interaction.reply("🌳 Inspecting session tree...");
    sendRpc(session, { id: "tree_req", type: "prompt", message: "/tree" });
    return;
  }

  // /export
  if (interaction.commandName === "export") {
    await interaction.reply("📤 Exporting session transcript...");
    sendRpc(session, { id: "export_req", type: "export_html" });
    return;
  }
});

// Attachment Helpers
interface ImagePayload {
  type: "image";
  data: string;
  mimeType: string;
}

async function processImageAttachment(
  att: { url: string; contentType?: string | null; name?: string | null },
): Promise<ImagePayload | null> {
  try {
    const res = await fetch(att.url);
    if (!res.ok) {
      console.error(`Failed to download image attachment ${att.name || "unnamed"} (status ${res.status})`);
      return null;
    }
    const arrayBuf = await res.arrayBuffer();
    const base64 = Buffer.from(arrayBuf).toString("base64");
    let mimeType = att.contentType || "";
    if (!mimeType || !mimeType.startsWith("image/")) {
      const ext = (att.name || "").split(".").pop()?.toLowerCase();
      if (ext === "png") mimeType = "image/png";
      else if (ext === "jpg" || ext === "jpeg") mimeType = "image/jpeg";
      else if (ext === "webp") mimeType = "image/webp";
      else if (ext === "gif") mimeType = "image/gif";
      else if (ext === "bmp") mimeType = "image/bmp";
      else mimeType = "image/png";
    }
    return {
      type: "image",
      data: base64,
      mimeType,
    };
  } catch (err) {
    console.error(`Error processing image attachment ${att.name || "unnamed"}:`, err);
    return null;
  }
}

function getAttachmentDir(session: SessionContext, messageId: string): string {
  try {
    const primaryDir = join(session.cwd, ".discord-attachments", session.threadId, messageId);
    mkdirSync(primaryDir, { recursive: true });
    return primaryDir;
  } catch {
    const fallbackDir = join(tmpdir(), "omp-discord-attachments", session.threadId, messageId);
    mkdirSync(fallbackDir, { recursive: true });
    return fallbackDir;
  }
}

async function saveNonImageAttachment(
  session: SessionContext,
  messageId: string,
  att: { url: string; name?: string | null },
): Promise<string | null> {
  try {
    const res = await fetch(att.url);
    if (!res.ok) {
      console.error(`Failed to download attachment ${att.name || "unnamed"} (status ${res.status})`);
      return null;
    }
    const arrayBuf = await res.arrayBuffer();
    const dir = getAttachmentDir(session, messageId);
    const rawName = att.name || "attachment";
    const sanitized = basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
    const targetPath = join(dir, sanitized);
    writeFileSync(targetPath, Buffer.from(arrayBuf));
    return targetPath;
  } catch (err) {
    console.error(`Error saving non-image attachment ${att.name || "unnamed"}:`, err);
    return null;
  }
}

function cleanThreadAttachments(session: SessionContext): void {
  try {
    const primaryThreadDir = join(session.cwd, ".discord-attachments", session.threadId);
    if (existsSync(primaryThreadDir)) {
      rmSync(primaryThreadDir, { recursive: true, force: true });
    }
    const primaryBaseDir = join(session.cwd, ".discord-attachments");
    if (existsSync(primaryBaseDir) && readdirSync(primaryBaseDir).length === 0) {
      rmSync(primaryBaseDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`Failed to clean primary attachment directory for thread ${session.threadId}:`, err);
  }

  try {
    const fallbackThreadDir = join(tmpdir(), "omp-discord-attachments", session.threadId);
    if (existsSync(fallbackThreadDir)) {
      rmSync(fallbackThreadDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`Failed to clean fallback attachment directory for thread ${session.threadId}:`, err);
  }
}

// Handle Chat Messages in Threads
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!isUserAllowed(message.author.id)) return;
  const session = sessions.get(message.channelId);
  if (!session) return;

  if (message.channel.isThread()) {
    startTyping(session, message.channel);
  }

  const images: ImagePayload[] = [];
  const savedFilePaths: string[] = [];

  if (message.attachments.size > 0) {
    for (const [, att] of message.attachments) {
      const isImage = (att.contentType?.startsWith("image/") ?? false) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(att.name || "");
      if (isImage) {
        const img = await processImageAttachment(att);
        if (img) images.push(img);
      } else {
        const filePath = await saveNonImageAttachment(session, message.id, att);
        if (filePath) savedFilePaths.push(filePath);
      }
    }
  }

  let text = message.content.trim();
  if (savedFilePaths.length > 0) {
    const fileRefs = savedFilePaths.map((p) => `@${p}`).join(" ");
    text = text ? `${fileRefs} ${text}` : fileRefs;
  }

  if (!text && images.length === 0) {
    stopTyping(session);
    return;
  }

  sendRpc(session, {
    id: `prompt_${Date.now()}`,
    type: "prompt",
    message: text,
    ...(images.length > 0 ? { images } : {}),
  });
});

// Handle Thread Deletions to clean up OMP processes automatically
client.on(Events.ThreadDelete, (thread) => {
  const session = sessions.get(thread.id);
  if (session) {
    stopTyping(session);
    console.log(`🗑️ Thread ${thread.id} ("${thread.name}") deleted. Terminating OMP session...`);
    try {
      session.process.kill();
    } catch (err) {
      console.error(`Error terminating OMP process for deleted thread ${thread.id}:`, err);
    }
    try {
      cleanThreadAttachments(session);
    } catch (err) {
      console.error(`Error cleaning attachments for thread ${thread.id}:`, err);
    }
  }
});

client.on(Events.ClientReady, () => {
  console.log(`🤖 OMP Discord Bot is online as ${client.user?.tag}!`);
  if (allowedUserIds.size > 0) {
    console.log(`🔒 User allowlist active: ${allowedUserIds.size} allowed user(s).`);
  } else {
    console.warn("⚠️ WARNING: No ALLOWED_USERS configured! All user interactions are blocked (fail-closed). Add Discord user IDs to ALLOWED_USERS in .env.");
  }
});

client.login(DISCORD_TOKEN);
