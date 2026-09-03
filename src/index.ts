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
  AttachmentBuilder,
  type AutocompleteInteraction,
} from "discord.js";
import { spawn, type Subprocess } from "bun";
import { createInterface } from "readline";
import { SessionManager, resolveOmpSessionPath, type SessionContext, type OmpProcess } from "./session-manager";
import {
  handleMessageEditAsRewind,
  recordUserTurnCheckpoint,
  recordAssistantMessage,
  syncCheckpointsWithBranchMessages,
  persistSessionCheckpoints,
  resolvePendingRpcResponse,
  rejectPendingRpcError,
  type TurnCheckpoint,
  type ImagePayload,
} from "./rewind";
import {
  buildDynamicThreadName,
  isDefaultThreadName,
} from "./ui-helpers";
import { Readable } from "stream";
import type { ReadableStream as WebReadableStream } from "stream/web";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import {
  commitWorkspaceChanges,
  createGitWorktree,
  formatDiffForDiscord,
  inspectGitDiff,
  isDownloadableWorkspaceFile,
  isInsideWorkspace,
  listWorkspaceFiles,
  MAX_WORKSPACE_DOWNLOAD_BYTES,
  removeGitWorktree,
  resolveWorkspaceFile,
  type WorktreeInfo,
} from "./workspace";
import {
  extractEventUsage,
  formatHudEmbed,
  formatToolExecutionEmbed,
  formatToolOutputPreview,
  formatToolTracesEmbed,
  mergeHudState,
  OBSERVABILITY_UPDATE_THROTTLE_MS,
  readModelDisplay,
  readNumericValue,
  readSubagentState,
  readTokenUsage,
  toolIcon,
  type HudState,
  type ToolExecutionTrace,
} from "./observability";

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
  if (allowedUserIds.size === 0) {
    return false;
  }
  return allowedUserIds.has(userId);
}


function getSanitizedChildEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.DISCORD_TOKEN;
  delete env.DISCORD_CLIENT_ID;
  delete env.ALLOWED_USERS;
  delete env.WHITELISTED_USERS;
  return env;
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
const sessionManager = new SessionManager();
await sessionManager.init();
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
    if (branch && branch !== "HEAD") {
      return branch;
    }

    const commitProc = spawn(["git", "-c", "safe.directory=*", "rev-parse", "--short", "HEAD"], {
      cwd,
      stderr: "ignore",
    });
    const commit = (await new Response(commitProc.stdout).text()).trim();
    return commit ? `detached@${ commit }` : null;
  } catch {
    return null;
  }
}

async function getGitSnapshot(cwd: string): Promise<{ branch: string | null; dirty: boolean | null }> {
  try {
    const branch = await getGitBranch(cwd);
    if (!branch) {
      return { branch: null, dirty: null };
    }
    const statusProc = spawn(["git", "-c", "safe.directory=*", "status", "--porcelain"], {
      cwd,
      stderr: "ignore",
    });
    const status = (await new Response(statusProc.stdout).text()).trim();
    return { branch, dirty: status.length > 0 };
  } catch {
    return { branch: null, dirty: null };
  }
}

async function ensurePinnedHud(session: SessionContext, thread: ThreadChannel): Promise<void> {
  if (session.hudMessage) {
    return;
  }
  if (session.hudInitPromise) {
    await session.hudInitPromise;
    return;
  }
  const initialization = (async () => {
    session.toolTraces ||= new Map();
    const initialState = (session.hudState || { cwd: session.cwd }) as HudState;
    try {
      const pinned = await thread.messages.fetchPinned().catch(() => null);
      const existing = pinned?.find((message) => message.embeds.some((embed) => embed.title === "📡 OMP Live HUD"));
      session.hudMessage = existing || await thread.send({ embeds: [formatHudEmbed(initialState)] });
      if (!existing) {
        await session.hudMessage.pin("OMP live observability HUD").catch(() => {});
      }
      session.hudLastEditTimestamp = Date.now();
      scheduleHudUpdate(session, thread);
    } catch (error) {
      console.warn(`Unable to create pinned HUD for thread ${ thread.id }:`, error);
    }
  })();
  session.hudInitPromise = initialization;
  try {
    await initialization;
  } finally {
    if (session.hudInitPromise === initialization) {
      session.hudInitPromise = undefined;
    }
  }
}

async function flushHudUpdate(session: SessionContext): Promise<void> {
  clearTimeout(session.hudUpdateTimer);
  session.hudUpdateTimer = undefined;
  if (!session.hudMessage) {
    return;
  }
  session.hudLastEditTimestamp = Date.now();
  await session.hudMessage.edit({ embeds: [formatHudEmbed((session.hudState || { cwd: session.cwd }) as HudState)] }).catch(() => {});
}

function scheduleHudUpdate(session: SessionContext, thread?: ThreadChannel): void {
  if (!session.hudMessage) {
    if (thread) {
      void ensurePinnedHud(session, thread);
    }
    return;
  }
  const elapsed = Date.now() - (session.hudLastEditTimestamp || 0);
  if (elapsed >= OBSERVABILITY_UPDATE_THROTTLE_MS) {
    void flushHudUpdate(session);
    return;
  }
  if (!session.hudUpdateTimer) {
    session.hudUpdateTimer = setTimeout(() => {
      void flushHudUpdate(session);
    }, OBSERVABILITY_UPDATE_THROTTLE_MS - elapsed);
  }
}

/**
 * Retrieve OMP advisor configuration (enabled status and assigned model role).
 */
async function getAdvisorConfig(cwd?: string): Promise<{ enabled: boolean; model: string | null }> {
  try {
    const env = getSanitizedChildEnv();
    const [enabledProc, rolesProc] = [
      spawn(["omp", "config", "get", "advisor.enabled"], cwd ? { cwd, env, stderr: "ignore" } : { env, stderr: "ignore" }),
      spawn(["omp", "config", "get", "modelRoles"], cwd ? { cwd, env, stderr: "ignore" } : { env, stderr: "ignore" }),
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
    env: getSanitizedChildEnv(),
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

    readline.on("line", (line: string) => {
      if (!line.trim()) {
        return;
      }
      try {
        const frame: unknown = JSON.parse(line);
        if (!frame || typeof frame !== "object") {
          return;
        }
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

  console.log(`Discovered ${ fetchedCommands.length } native OMP commands and ${ fetchedModels.length } models.`);
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
      )
      .addBooleanOption((opt) =>
        opt
          .setName("worktree")
          .setDescription("Create an isolated Git worktree for this session")
          .setRequired(false),
      ),

    new SlashCommandBuilder()
      .setName("omp-terminate-all")
      .setDescription("Terminate all active OMP sessions and delete their Discord threads"),

    new SlashCommandBuilder()
      .setName("diff")
      .setDescription("Inspect Git changes in this session workspace")
      .addBooleanOption((opt) =>
        opt.setName("staged").setDescription("Show staged changes instead of unstaged changes").setRequired(false),
      )
      .addStringOption((opt) =>
        opt.setName("path").setDescription("Limit the diff to a workspace path").setAutocomplete(true).setRequired(false),
      ),

    new SlashCommandBuilder()
      .setName("download")
      .setDescription("Download a file from this session workspace")
      .addStringOption((opt) =>
        opt.setName("path").setDescription("Workspace-relative file path").setAutocomplete(true).setRequired(true),
      ),

    new SlashCommandBuilder()
      .setName("commit")
      .setDescription("Commit staged or tracked workspace changes")
      .addStringOption((opt) => opt.setName("message").setDescription("Commit message").setRequired(true)),

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
  partials: [Partials.Channel, Partials.Message, Partials.User],
});

// Spawn OMP RPC instance for a thread
function createOmpSession(
  thread: ThreadChannel,
  cwd: string,
  initialModel?: string,
  metadata?: Record<string, unknown>,
  sessionId?: string,
  sessionFile?: string,
): SessionContext {
  let resolveInitialState: ((state: Record<string, unknown>) => void) | undefined;
  const initialStatePromise = new Promise<Record<string, unknown>>((resolve) => {
    resolveInitialState = resolve;
    setTimeout(() => resolve({}), 3000);
  });

  const args = ["omp", "--mode", "rpc"];
  const resumeTarget = resolveOmpSessionPath(sessionFile, sessionId);
  if (resumeTarget) {
    args.push(`--resume=${ resumeTarget }`);
  }
  if (initialModel) {
    args.push(`--model=${ initialModel }`);
  }
  const proc = spawn(args, {
    cwd,
    env: getSanitizedChildEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  const metadataWorktree = metadata?.worktree;
  const worktree =
    metadataWorktree && typeof metadataWorktree === "object"
      ? (() => {
          const candidate = metadataWorktree as Record<string, unknown>;
          if (
            typeof candidate.path === "string" &&
            typeof candidate.branch === "string" &&
            typeof candidate.repoRoot === "string" &&
            typeof candidate.gitDir === "string"
          ) {
            return candidate as unknown as WorktreeInfo;
          }
          return undefined;
        })()
      : undefined;
  const restoredCheckpoints = Array.isArray(metadata?.checkpoints)
    ? (metadata.checkpoints as TurnCheckpoint[])
    : [];
  const session: SessionContext = {
    process: proc,
    threadId: thread.id,
    cwd,
    sessionId,
    sessionFile: resumeTarget || sessionFile,
    ...(worktree ? { worktree } : {}),
    currentStreamBuffer: "",
    lastEditTimestamp: 0,
    initialStatePromise,
    resolveInitialState,
    hudState: { model: initialModel, cwd, turnStatus: "idle", updatedAt: Date.now() },
    hudLastEditTimestamp: 0,
    toolTraces: new Map(),
    toolTraceHistory: [],
    checkpoints: restoredCheckpoints,
    pendingRpcRequests: new Map(),
    cumulativeTokens: { input: 0, output: 0 },
    activeSubagentsMap: new Map(),
  };
  void ensurePinnedHud(session, thread);

  const nodeStdout = Readable.fromWeb(proc.stdout as unknown as WebReadableStream);
  const readline = createInterface({
    input: nodeStdout,
    terminal: false,
  });

  readline.on("line", (line: string) => {
    if (!line.trim()) {
      return;
    }
    try {
      const event: unknown = JSON.parse(line);
      if (event && typeof event === "object") {
        void handleRpcEvent(session, thread, event as Record<string, unknown>);
      }
    } catch (err) {
      console.error("RPC parse error:", err);
    }
  });
  proc.exited.then((code: number | null) => {
    session.isRunning = false;
    session.confirmationPending = false;
    stopTyping(session);
    if (session.editTimer) {
      clearTimeout(session.editTimer);
      session.editTimer = undefined;
    }
    if (session.pendingRpcRequests) {
      for (const [, req] of session.pendingRpcRequests) {
        clearTimeout(req.timer);
        req.reject(new Error(`OMP process exited with code ${ code }`));
      }
      session.pendingRpcRequests.clear();
    }
    clearTimeout(session.hudUpdateTimer);
    session.hudUpdateTimer = undefined;
    session.toolTraces?.clear();
    session.toolTraceHistory = [];
    session.activePromptMsg = undefined;
    void thread.send(`⚠️ OMP process exited (code ${ code }).`).catch(() => {});
    void sessionManager.terminate(session, undefined, false);
  });
  return session;
}

async function terminateSession(session: SessionContext, deleteThread = true): Promise<void> {
  await sessionManager.terminate(session, client, deleteThread);
}

async function updateThreadNameFromPrompt(thread: ThreadChannel, prompt: string): Promise<void> {
  if (!isDefaultThreadName(thread.name)) {
    return;
  }
  const nextName = buildDynamicThreadName(prompt, thread.name, "idle");
  if (nextName === thread.name) {
    return;
  }
  await thread.setName(nextName).catch((err) => {
    console.warn(`Failed to derive a name for thread ${ thread.id }:`, err);
  });
}

/**
 * Format tool execution details into a concise, user-friendly status line.
 */
function formatToolStatus(toolName: string, rawArgs?: unknown, rawIntent?: unknown): string {
  const intent = typeof rawIntent === "string" ? rawIntent.trim() : "";
  if (intent) {
    return `⚡ *${ intent }* (\`${ toolName }\`)`;
  }

  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;

  if (toolName === "bash" && typeof args.command === "string") {
    const cmd = args.command.trim();
    const shortCmd = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    return `🔧 \`bash\`: \`${ shortCmd }\``;
  }

  if ((toolName === "read" || toolName === "write" || toolName === "edit") && typeof args.path === "string") {
    return `📄 \`${ toolName }\`: \`${ args.path }\``;
  }

  if (toolName === "grep") {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    return `🔍 \`grep\`: \`${ pattern }\``;
  }

  if (toolName === "glob") {
    const pattern = typeof args.path === "string" ? args.path : "";
    return `📂 \`glob\`: \`${ pattern }\``;
  }

  if (toolName === "eval" && typeof args.title === "string") {
    return `⚙️ \`eval\`: *${ args.title }*`;
  }

  if (toolName === "lsp" && typeof args.action === "string") {
    return `🧠 \`lsp\`: *${ args.action }*`;
  }

  return `🔧 *Running \`${ toolName }\`...*`;
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
      chunk += `\n${ fenceType }`;
      remaining = `${ currentFence }\n` + remaining;
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
  if (!session.activePromptMsg) {
    return;
  }

  session.lastEditTimestamp = Date.now();

  const hasTraces = session.toolTraceHistory && session.toolTraceHistory.length > 0;
  const textTail = session.currentStreamBuffer ? session.currentStreamBuffer.slice(-1800) : "";

  if (hasTraces) {
    const embed = formatToolTracesEmbed(session.toolTraceHistory!);
    await session.activePromptMsg
      .edit({
        content: textTail || null,
        embeds: [embed],
      })
      .catch(() => {});
  } else if (textTail) {
    await session.activePromptMsg
      .edit({
        content: textTail,
        embeds: [],
      })
      .catch(() => {});
  } else {
    const status = session.activeToolStatus || "🤔 *Thinking...*";
    await session.activePromptMsg
      .edit({
        content: status,
        embeds: [],
      })
      .catch(() => {});
  }
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
  if (!session.activePromptMsg) {
    return;
  }
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
function executionIdForEvent(event: Record<string, unknown>, toolName: string): string {
  const candidate = event.executionId ?? event.toolExecutionId ?? event.toolCallId ?? event.callId ?? event.id;
  return typeof candidate === "string" || typeof candidate === "number"
    ? String(candidate)
    : `${ toolName }_${ Date.now().toString(36) }_${ Math.random().toString(36).slice(2, 6) }`;
}

function toolOutputFromEvent(event: Record<string, unknown>): unknown {
  return event.output ?? event.result ?? event.text ?? event.content ?? event.error;
}

function toolExitCodeFromEvent(event: Record<string, unknown>): number | null | undefined {
  const raw = event.exitCode ?? event.exit_status ?? event.code ?? (event.result && typeof event.result === "object"
    ? (event.result as Record<string, unknown>).exitCode
    : undefined);
  if (raw === null) {
    return null;
  }
  return readNumericValue(raw);
}

function updateHudActivity(session: SessionContext, thread: ThreadChannel, activeTool: string | undefined, turnStatus?: string): void {
  const current = (session.hudState || { cwd: session.cwd }) as HudState;
  session.hudState = {
    ...current,
    activeTool,
    ...(turnStatus ? { turnStatus } : {}),
    cwd: session.cwd,
    updatedAt: Date.now(),
  } as unknown as Record<string, unknown>;
  scheduleHudUpdate(session, thread);
}

async function handleToolExecutionStart(session: SessionContext, thread: ThreadChannel, event: Record<string, unknown>): Promise<void> {
  session.toolTraces ||= new Map();
  session.toolTraceHistory ||= [];
  const toolName = typeof event.toolName === "string"
    ? event.toolName
    : typeof event.tool === "string"
      ? event.tool
      : "tool";
  const id = executionIdForEvent(event, toolName);
  const trace: ToolExecutionTrace = {
    id,
    toolName,
    args: event.args ?? event.input,
    intent: typeof event.intent === "string" ? event.intent : undefined,
    phase: "running",
    startedAt: Date.now(),
  };
  session.toolTraces.set(id, trace);
  session.toolTraceHistory.push(trace);
  session.activeToolStatus = formatToolStatus(toolName, trace.args, trace.intent);
  updateHudActivity(session, thread, `${ toolIcon(toolName) } ${ toolName }`, "running");
  scheduleActivePromptUpdate(session);
}

async function handleToolExecutionUpdate(session: SessionContext, thread: ThreadChannel, event: Record<string, unknown>): Promise<void> {
  session.toolTraces ||= new Map();
  session.toolTraceHistory ||= [];
  const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
  const id = executionIdForEvent(event, toolName);
  let trace = session.toolTraces.get(id);
  if (!trace) {
    trace = {
      id,
      toolName,
      phase: "running",
      startedAt: Date.now(),
    };
    session.toolTraces.set(id, trace);
    session.toolTraceHistory.push(trace);
  }
  trace.phase = "updated";
  const output = formatToolOutputPreview(toolOutputFromEvent(event));
  if (output) {
    trace.outputPreview = output;
  }
  session.activeToolStatus = formatToolStatus(trace.toolName, trace.args, trace.intent);
  updateHudActivity(session, thread, `${ toolIcon(trace.toolName) } ${ trace.toolName }`, "running");
  scheduleActivePromptUpdate(session);
}

async function handleToolExecutionEnd(session: SessionContext, thread: ThreadChannel, event: Record<string, unknown>): Promise<void> {
  session.toolTraces ||= new Map();
  session.toolTraceHistory ||= [];
  const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
  const id = executionIdForEvent(event, toolName);
  let trace = session.toolTraces.get(id);
  if (!trace) {
    trace = {
      id,
      toolName,
      phase: "running",
      startedAt: Date.now(),
    };
    session.toolTraces.set(id, trace);
    session.toolTraceHistory.push(trace);
  }
  trace.endedAt = Date.now();
  trace.durationMs = trace.endedAt - trace.startedAt;
  trace.exitCode = toolExitCodeFromEvent(event);
  trace.outputPreview = formatToolOutputPreview(toolOutputFromEvent(event)) || trace.outputPreview;
  trace.error = typeof event.error === "string" ? event.error : trace.error;
  trace.phase = trace.error || (trace.exitCode != null && trace.exitCode !== 0) ? "failed" : "completed";
  scheduleActivePromptUpdate(session);
  session.toolTraces.delete(id);
  const nextRunningTrace = [...session.toolTraces.values()].reverse().find(
    (t) => t.phase === "running" || t.phase === "updated",
  );
  session.activeToolStatus = nextRunningTrace
    ? formatToolStatus(nextRunningTrace.toolName, nextRunningTrace.args, nextRunningTrace.intent)
    : undefined;
  updateHudActivity(
    session,
    thread,
    nextRunningTrace ? `${ toolIcon(nextRunningTrace.toolName) } ${ nextRunningTrace.toolName }` : undefined,
    "running",
  );
}



function syncSubagentsHud(session: SessionContext, thread: ThreadChannel): void {
  session.activeSubagentsMap ||= new Map();
  const activeList = [...session.activeSubagentsMap.values()].map((s) => s.agent || s.id);
  const current = (session.hudState || { cwd: session.cwd }) as HudState;
  session.hudState = {
    ...current,
    activeSubagents: activeList,
    cwd: session.cwd,
    updatedAt: Date.now(),
  } as unknown as Record<string, unknown>;
  scheduleHudUpdate(session, thread);
}

function updateSubagentHud(session: SessionContext, thread: ThreadChannel, delta: number): void {
  const current = (session.hudState || { cwd: session.cwd }) as HudState;
  const raw = current.activeSubagents;
  const count = typeof raw === "number" ? raw : Array.isArray(raw) ? raw.length : 0;
  session.hudState = {
    ...current,
    activeSubagents: Math.max(0, count + delta),
    cwd: session.cwd,
    updatedAt: Date.now(),
  } as unknown as Record<string, unknown>;
  scheduleHudUpdate(session, thread);
}

async function handleRpcEvent(
  session: SessionContext,
  thread: ThreadChannel,
  event: Record<string, unknown>,
): Promise<void> {
  const type = typeof event.type === "string" ? event.type : "";
  // Resolve pending RPC request promises
  if (type === "response") {
    resolvePendingRpcResponse(session, event);
  } else if (type === "error" || type === "fatal_error") {
    if (typeof event.id === "string") {
      rejectPendingRpcError(
        session,
        event.id,
        typeof event.message === "string" ? event.message : "RPC error",
      );
    }
  }

  // 1. Ready & Protocol Negotiation
  if (type === "ready") {
    sendRpc(session, {
      id: "init",
      type: "negotiate_protocol",
      protocolVersion: 2,
    });
    sendRpc(session, {
      id: "init_subagent_sub",
      type: "set_subagent_subscription",
      level: "progress",
    });
    sendRpc(session, {
      id: "init_state",
      type: "get_state",
    });
    return;
  }

  // 2. Fatal RPC errors
  if (type === "error" || type === "fatal_error") {
    session.isRunning = false;
    session.confirmationPending = false;
    stopTyping(session);
    if (session.editTimer) {
      clearTimeout(session.editTimer);
      session.editTimer = undefined;
    }

    const errorText = typeof event.message === "string" ? event.message : "OMP reported a fatal error.";
    await thread.send(`🔴 **OMP error:** ${ errorText }`).catch(() => {});
    return;
  }

  // 3. Turn Start
  if (type === "agent_start") {
    session.isRunning = true;
    session.completionBarAttached = false;
    session.confirmationPending = false;
    if (session.editTimer) {
      clearTimeout(session.editTimer);
      session.editTimer = undefined;
    }
    session.toolTraceHistory = [];
    session.toolTraces = new Map();
    session.currentStreamBuffer = "";
    session.activeToolStatus = undefined;
    session.activePromptMsg = await thread.send("🤔 *Thinking...*");
    recordAssistantMessage(session, session.activePromptMsg.id);
    session.lastEditTimestamp = Date.now();
    updateHudActivity(session, thread, undefined, "running");
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
    await handleToolExecutionStart(session, thread, event);
    return;
  }

  if (type === "tool_execution_update") {
    await handleToolExecutionUpdate(session, thread, event);
    return;
  }

  if (type === "tool_execution_end") {
    await handleToolExecutionEnd(session, thread, event);
    return;
  }

  if (type === "turn_start") {
    updateHudActivity(session, thread, undefined, "running");
    session.activeToolStatus = undefined;
    return;
  }

  if (type === "turn_end") {
    const usage = extractEventUsage(event);
    if (usage) {
      session.cumulativeTokens ||= { input: 0, output: 0 };
      if (usage.input != null) {
        session.cumulativeTokens.input += usage.input;
      }
      if (usage.output != null) {
        session.cumulativeTokens.output += usage.output;
      }
      const prevHud = (session.hudState || { cwd: session.cwd }) as HudState;
      const prevTokens = prevHud.tokens || {};
      session.hudState = {
        ...prevHud,
        tokens: {
          ...prevTokens,
          input: session.cumulativeTokens.input,
          output: session.cumulativeTokens.output,
        },
        turnStatus: "idle",
        activeTool: undefined,
        cwd: session.cwd,
        updatedAt: Date.now(),
      } as unknown as Record<string, unknown>;
      scheduleHudUpdate(session, thread);
    } else {
      updateHudActivity(session, thread, undefined, "idle");
    }
    session.activeToolStatus = undefined;
    return;
  }

  // 5. Interactive UI / Approval Request (Buttons in Discord)
  if (type === "extension_ui_request") {
    const method = typeof event.method === "string" ? event.method : "";
    const id = typeof event.id === "string" ? event.id : "";
    const messageText = typeof event.message === "string" ? event.message : "Confirmation needed";

    if (method === "confirm" && id) {
      session.confirmationPending = true;
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve_${ id }`)
          .setLabel("Approve")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`reject_${ id }`)
          .setLabel("Deny")
          .setStyle(ButtonStyle.Danger),
      );

      const msg = await thread.send({
        content: `⚠️ **Action Required**: ${ messageText }`,
        components: [row],
      });
      recordAssistantMessage(session, msg.id);

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
              ? `✅ Approved by <@${ confirmation.user.id }>`
              : `❌ Denied by <@${ confirmation.user.id }>`,
            components: [],
          })
          .catch(() => {});
      }
      session.confirmationPending = false;
    }
    return;
  }

  if (type === "subagent_lifecycle") {
    const payload = event.payload as {
      id?: string;
      agent?: string;
      status?: string;
      description?: string;
    } | undefined;
    if (payload?.id) {
      session.activeSubagentsMap ||= new Map();
      if (payload.status === "started") {
        session.activeSubagentsMap.set(payload.id, {
          id: payload.id,
          agent: payload.agent || "subagent",
          description: payload.description,
        });
      } else {
        session.activeSubagentsMap.delete(payload.id);
      }
      syncSubagentsHud(session, thread);
    }
    return;
  }

  if (type === "config_update") {
    const data = event as Record<string, unknown>;
    const model = readModelDisplay(data);
    const thinkingLevel = typeof data.thinkingLevel === "string" ? data.thinkingLevel : undefined;
    const currentHud = (session.hudState || { cwd: session.cwd }) as HudState;
    session.hudState = {
      ...currentHud,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { reasoningLevel: thinkingLevel } : {}),
      cwd: session.cwd,
      updatedAt: Date.now(),
    } as unknown as Record<string, unknown>;
    scheduleHudUpdate(session, thread);
    return;
  }

  if (type === "model_changed") {
    sendRpc(session, { id: `sync_model_${ Date.now() }`, type: "get_state" });
    return;
  }

  if (type === "thinking_level_changed") {
    const thinkingLevel = typeof event.thinkingLevel === "string" ? event.thinkingLevel : undefined;
    if (thinkingLevel) {
      const currentHud = (session.hudState || { cwd: session.cwd }) as HudState;
      session.hudState = {
        ...currentHud,
        reasoningLevel: thinkingLevel,
        cwd: session.cwd,
        updatedAt: Date.now(),
      } as unknown as Record<string, unknown>;
      scheduleHudUpdate(session, thread);
    } else {
      sendRpc(session, { id: `sync_think_${ Date.now() }`, type: "get_state" });
    }
    return;
  }

  if (type === "subagent_progress" || type === "subagent_event" || type === "subagent_update") {
    return;
  }

  if (type === "subagent_start") {
    updateSubagentHud(session, thread, 1);
    return;
  }

  if (type === "subagent_end" || type === "subagent_result") {
    updateSubagentHud(session, thread, -1);
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
      const formatted = trimmed.startsWith("```") ? trimmed : `\`\`\`\n${ trimmed }\n\`\`\``;
      const chunks = splitDiscordMessage(formatted, 1900);
      for (const chunk of chunks) {
        const sent = await thread.send(chunk).catch(() => null);
        if (sent) {
          recordAssistantMessage(session, sent.id);
        }
      }
    }
    return;
  }

  // 7. Response frames (e.g. state / custom query results)
  if (type === "response" && event.command === "get_state" && event.data && typeof event.data === "object") {
    const data = event.data as Record<string, unknown>;
    if (typeof data.sessionId === "string" && data.sessionId) {
      session.sessionId = data.sessionId;
    }
    if (typeof data.sessionFile === "string" && data.sessionFile) {
      session.sessionFile = data.sessionFile;
    }
    if (session.sessionId || session.sessionFile) {
      void sessionManager.update(session.threadId, {
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
      }).catch((err) => {
        console.error(`Failed to update session binding info for thread ${ session.threadId }:`, err);
      });
    }

    if (session.resolveInitialState) {
      session.resolveInitialState(data);
      session.resolveInitialState = undefined;
    }
    const gitSnapshot = await getGitSnapshot(session.cwd);
    const hud = mergeHudState(session, data);
    hud.branch = gitSnapshot.branch || undefined;
    hud.gitDirty = gitSnapshot.dirty === null ? undefined : gitSnapshot.dirty;
    session.hudState = hud as unknown as Record<string, unknown>;
    scheduleHudUpdate(session, thread);

    if (event.id === "status_req") {
      const model = data.model as { provider?: string; id?: string; name?: string } | undefined;
      const modelStr = model ? `${model.provider ? `${ model.provider }/` : ""}${ model.id }${model.name ? ` (${ model.name })` : ""}` : "unknown";
      const tokens = (data.contextUsage as { tokens?: number; contextWindow?: number; percent?: number }) || {};

      const [advisorConfig, branch] = await Promise.all([
        getAdvisorConfig(session.cwd),
        Promise.resolve(gitSnapshot.branch),
      ]);

      const advisorText = advisorConfig.enabled
        ? `🟢 On${advisorConfig.model ? ` (\`${ advisorConfig.model }\`)` : ""}`
        : "🔴 Off";
      const branchText = branch ? `\`${ branch }\`` : "*None*";

      const embed = new EmbedBuilder()
        .setTitle("📊 OMP Session Status")
        .setColor(0x5865f2)
        .addFields(
          { name: "🤖 Model", value: `\`${ modelStr }\``, inline: true },
          { name: "🧠 Thinking Level", value: `\`${ String(data.thinkingLevel || "normal") }\``, inline: true },
          { name: "⚡ Fast Mode", value: data.fastModeActive ? "⚡ Active" : "Off", inline: true },
          { name: "🛡️ Advisor", value: advisorText, inline: true },
          { name: "🌿 Git Branch", value: branchText, inline: true },
          {
            name: "Context Usage",
            value: tokens.tokens != null ? `${ tokens.tokens.toLocaleString() } / ${ tokens.contextWindow?.toLocaleString() } (${ Math.round((tokens.percent || 0) * 100) }%)` : "N/A",
            inline: true,
          },
          { name: "📁 Directory", value: `\`${ session.cwd }\``, inline: false },
          { name: "💬 Messages", value: `${ data.messageCount ?? 0 } in session`, inline: true },
        );

      await thread.send({ embeds: [embed] }).catch(() => {});
    }
    return;
  }

  if (type === "response" && event.command === "get_branch_messages" && event.data && typeof event.data === "object") {
    const data = event.data as { messages?: Array<{ entryId: string; text: string }> };
    if (Array.isArray(data.messages)) {
      syncCheckpointsWithBranchMessages(session, data.messages);
      void persistSessionCheckpoints(session, sessionManager);
    }
    return;
  }
  if (type === "response" && event.command === "get_subagents" && event.data && typeof event.data === "object") {
    const data = event.data as { subagents?: Array<{ id: string; agent?: string; status?: string; description?: string }> };
    session.activeSubagentsMap ||= new Map();
    session.activeSubagentsMap.clear();
    if (Array.isArray(data.subagents)) {
      for (const s of data.subagents) {
        if (s && s.id && (s.status === "running" || s.status === "started")) {
          session.activeSubagentsMap.set(s.id, {
            id: s.id,
            agent: s.agent || "subagent",
            description: s.description,
          });
        }
      }
    }
    syncSubagentsHud(session, thread);
    return;
  }

  if (type === "response" && event.command === "set_thinking_level") {
    sendRpc(session, { id: `sync_think_${ Date.now() }`, type: "get_state" });
    return;
  }

  // 8. Turn Finish
  if (type === "agent_end") {
    if (session.isRewinding) {
      session.isRunning = false;
      session.confirmationPending = false;
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
      return;
    }

    session.isRunning = false;
    session.confirmationPending = false;
    stopTyping(session);
    if (session.editTimer) {
      clearTimeout(session.editTimer);
      session.editTimer = undefined;
    }
    const full = session.currentStreamBuffer.trim();
    const responseText = full || "✅ *Completed.*";
    const chunks = splitDiscordMessage(responseText, 1950);

    if (session.activePromptMsg) {
      recordAssistantMessage(session, session.activePromptMsg.id);
      await session.activePromptMsg
        .edit({ content: chunks[0], embeds: [], components: [] })
        .catch(() => {});
      for (let i = 1; i < chunks.length; i++) {
        const extraMsg = await thread.send(chunks[i]).catch(() => null);
        if (extraMsg) {
          recordAssistantMessage(session, extraMsg.id);
        }
      }
    } else {
      const firstMsg = await thread.send(chunks[0]).catch(() => null);
      if (firstMsg) {
        recordAssistantMessage(session, firstMsg.id);
      }
      for (let i = 1; i < chunks.length; i++) {
        const extraMsg = await thread.send(chunks[i]).catch(() => null);
        if (extraMsg) {
          recordAssistantMessage(session, extraMsg.id);
        }
      }
    }

    session.completionBarAttached = true;
    const usage = extractEventUsage(event);
    if (usage) {
      session.cumulativeTokens ||= { input: 0, output: 0 };
      if (usage.input != null) {
        session.cumulativeTokens.input += usage.input;
      }
      if (usage.output != null) {
        session.cumulativeTokens.output += usage.output;
      }
    }
    const gitSnapshot = await getGitSnapshot(session.cwd);
    const currentHud = (session.hudState || { cwd: session.cwd }) as HudState;
    const prevTokens = currentHud.tokens || {};
    session.hudState = {
      ...currentHud,
      tokens: {
        ...prevTokens,
        ...(session.cumulativeTokens ? { input: session.cumulativeTokens.input, output: session.cumulativeTokens.output } : {}),
      },
      branch: gitSnapshot.branch || undefined,
      gitDirty: gitSnapshot.dirty === null ? undefined : gitSnapshot.dirty,
      updatedAt: Date.now(),
    } as unknown as Record<string, unknown>;
    session.activePromptMsg = undefined;
    session.currentStreamBuffer = "";
    session.activeToolStatus = undefined;
    updateHudActivity(session, thread, undefined, "idle");

    // Sync checkpoint entryIds with OMP transcript and refresh latest session state & subagents
    sendRpc(session, { id: `sync_branch_${ Date.now() }`, type: "get_branch_messages" });
    sendRpc(session, { id: `sync_state_${ Date.now() }`, type: "get_state" });
    sendRpc(session, { id: `sync_subagents_${ Date.now() }`, type: "get_subagents" });
    return;
  }

  // 9. Prompt Result, including local command completion without agent_end.
  if (type === "prompt_result") {
    if (session.isRewinding) {
      session.isRunning = false;
      session.confirmationPending = false;
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
      return;
    }

    session.isRunning = false;
    session.confirmationPending = false;
    stopTyping(session);
    if (session.editTimer) {
      clearTimeout(session.editTimer);
      session.editTimer = undefined;
    }
    const shouldAttachActionBar = !session.completionBarAttached || event.agentInvoked === false;
    if (shouldAttachActionBar) {
      const resultText = typeof event.result === "string"
        ? event.result.trim()
        : typeof event.message === "string"
          ? event.message.trim()
          : "";
      const summary = resultText || "✅ *Completed.*";
      const chunks = splitDiscordMessage(summary, 1950);
      if (session.activePromptMsg) {
        recordAssistantMessage(session, session.activePromptMsg.id);
        await session.activePromptMsg
          .edit({ content: chunks[0], embeds: [], components: [] })
          .catch(() => {});
        for (let i = 1; i < chunks.length; i++) {
          const extraMsg = await thread.send(chunks[i]).catch(() => null);
          if (extraMsg) {
            recordAssistantMessage(session, extraMsg.id);
          }
        }
        session.activePromptMsg = undefined;
      } else {
        const firstMsg = await thread.send(chunks[0]).catch(() => null);
        if (firstMsg) {
          recordAssistantMessage(session, firstMsg.id);
        }
        for (let i = 1; i < chunks.length; i++) {
          const extraMsg = await thread.send(chunks[i]).catch(() => null);
          if (extraMsg) {
            recordAssistantMessage(session, extraMsg.id);
          }
        }
      }
      session.completionBarAttached = true;
    }

    session.currentStreamBuffer = "";
    session.activeToolStatus = undefined;
    updateHudActivity(session, thread, undefined, "idle");

    // Sync checkpoint entryIds with OMP transcript and refresh latest session state & subagents
    sendRpc(session, { id: `sync_branch_${ Date.now() }`, type: "get_branch_messages" });
    sendRpc(session, { id: `sync_state_${ Date.now() }`, type: "get_state" });
    sendRpc(session, { id: `sync_subagents_${ Date.now() }`, type: "get_subagents" });
  }
}

function getModelSuggestions(queryRaw: string): Array<{ name: string; value: string }> {
  const query = queryRaw.toLowerCase();
  return cachedModels
    .filter((m) => m.id.toLowerCase().includes(query) || (m.name && m.name.toLowerCase().includes(query)))
    .slice(0, 25)
    .map((m) => ({
      name: `${ m.name || m.id } [${ m.provider || "omp" }] (${ Math.round((m.contextWindow || 0) / 1000) }k ctx)`.slice(0, 100),
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
        name: `📁 . (Root: ${ basename(rootDir) || rootDir })`,
        value: ".",
      });
      if (existsSync(rootDir)) {
        const entries = readdirSync(rootDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
            suggestions.push({
              name: `📁 ${ entry.name }/`,
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
    if (!isInsideWorkspace(searchDir, rootDir)) {
      return suggestions.slice(0, 25);
    }

    if (existsSync(searchDir) && statSync(searchDir).isDirectory()) {
      if (searchDir === targetPath && existsSync(targetPath)) {
        suggestions.push({
          name: `📁 ${ rawInput } (current)`,
          value: rawInput,
        });
      }

      const entries = readdirSync(searchDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if ((entry.name.startsWith(".") || entry.name === "node_modules") && !filePrefix.startsWith(".") && filePrefix !== "node_modules") {
          continue;
        }
        if (filePrefix && !entry.name.toLowerCase().startsWith(filePrefix)) {
          continue;
        }

        let val: string;
        if (isAbs) {
          val = join(searchDir, entry.name);
        } else {
          const relToRoot = relative(rootDir, join(searchDir, entry.name));
          val = relToRoot.startsWith(".") ? relToRoot : `./${ relToRoot }`;
        }
        suggestions.push({
          name: `📁 ${ entry.name }/ (${ val })`.slice(0, 100),
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

  if ((interaction.commandName === "download" || interaction.commandName === "diff") && focused.name === "path") {
    const session = sessionManager.get(interaction.channelId);
    if (!session) {
      await interaction.respond([]);
      return;
    }
    const query = String(focused.value);
    const suggestions = listWorkspaceFiles(session.cwd, query)
      .filter((file) => interaction.commandName === "diff" || isDownloadableWorkspaceFile(file))
      .slice(0, 25)
      .map((file) => ({
        name: `${ file.relativePath } (${ file.size } bytes)`.slice(0, 100),
        value: file.relativePath.slice(0, 100),
      }));
    await interaction.respond(suggestions);
    return;
  }

  if (interaction.commandName === "skill" && focused.name === "name") {
    const query = focused.value.toLowerCase();
    const filtered = OMX_SKILLS
      .filter((s) => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query))
      .slice(0, 25)
      .map((s) => ({
        name: `$${ s.name } — ${ s.description.slice(0, 80) }`,
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
        name: `/${ c.name } ${ c.input?.hint || "" } ${c.description ? `(${ c.description.slice(0, 60) })` : ""}`.trim().slice(0, 100),
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


  if (!interaction.isChatInputCommand()) {
    return;
  }

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
    const useWorktree = interaction.options.getBoolean("worktree") ?? false;
    const rawCwd = inputDir || rootDir;
    const expandedRawCwd = rawCwd.startsWith("~")
      ? rawCwd.replace(/^~(?=$|\/|\\)/, process.env.HOME || "")
      : rawCwd;
    const cwd = resolve(rootDir, expandedRawCwd);
    const normalizedRoot = resolve(rootDir);

    if (!isInsideWorkspace(cwd, normalizedRoot)) {
      await interaction.reply({
        content: `⛔ Access denied: Directory must be inside the workspace root (\`${ normalizedRoot }\`).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!existsSync(cwd)) {
      await interaction.reply({
        content: `❌ Directory \`${ cwd }\` does not exist. Please specify a valid directory.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const sessionId = Math.random().toString(36).slice(2, 8);
    const threadName = `omp-session-${ sessionId }`;
    await interaction.deferReply();

    let createdWorktree: WorktreeInfo | undefined;
    try {
      const createPrivateThreads = process.env.CREATE_PRIVATE_THREADS !== "false";
      let thread: ThreadChannel;

      if (createPrivateThreads && textChannel.type === ChannelType.GuildText) {
        try {
          thread = await textChannel.threads.create({
            name: threadName,
            type: ChannelType.PrivateThread,
            autoArchiveDuration: 1440,
          });
        } catch (privErr) {
          console.warn("Could not create private thread (missing permission?), falling back to public thread:", privErr);
          thread = await textChannel.threads.create({
            name: threadName,
            autoArchiveDuration: 1440,
          });
        }
      } else {
        thread = await textChannel.threads.create({
          name: threadName,
          autoArchiveDuration: 1440,
        });
      }

      let sessionCwd = cwd;
      if (useWorktree) {
        const worktreeResult = await createGitWorktree(cwd, thread.id);
        if (!worktreeResult.ok || !worktreeResult.worktree) {
          throw new Error(worktreeResult.error || "Unable to create an isolated Git worktree.");
        }
        createdWorktree = worktreeResult.worktree;
        sessionCwd = createdWorktree.path;
      }
      const session = createOmpSession(
        thread,
        sessionCwd,
        inputModel || undefined,
        createdWorktree ? { worktree: createdWorktree } : undefined,
      );
      await sessionManager.register(session, {
        initialModel: inputModel || undefined,
        metadata: {
          guildId: thread.guildId,
          parentChannelId: thread.parentId,
          createdById: interaction.user.id,
          ...(createdWorktree ? { worktree: createdWorktree } : {}),
        },
      });
      await ensurePinnedHud(session, thread);
      const [state, advisorConfig, branch] = await Promise.all([
        session.initialStatePromise,
        getAdvisorConfig(sessionCwd),
        getGitBranch(sessionCwd),
      ]);

      const modelData = (state?.model as { id?: string; name?: string; provider?: string } | undefined) || {};
      const modelDisplay = modelData.id
        ? `${modelData.provider ? `${ modelData.provider }/` : ""}${ modelData.id }${modelData.name ? ` (${ modelData.name })` : ""}`
        : (inputModel || "default");

      const thinkingLevel = typeof state?.thinkingLevel === "string" ? state.thinkingLevel : "normal";
      const fastMode = Boolean(state?.fastModeActive);

      const advisorText = advisorConfig.enabled
        ? `🟢 On${advisorConfig.model ? ` (\`${ advisorConfig.model }\`)` : ""}`
        : "🔴 Off";

      const branchText = branch ? `\`${ branch }\`` : "*None (not a git repo)*";

      const sessionEmbed = new EmbedBuilder()
        .setTitle("👋 OMP Session Active")
        .setColor(0x5865f2)
        .setDescription(
          "Type directly in this thread to prompt the agent, or use slash commands (`/skill`, `/cmd`, `/model`, `/fast`, `/think`, `/compact`, `/status`, `/abort`).",
        )
        .addFields(
          { name: "🤖 Active Model", value: `\`${ modelDisplay }\``, inline: true },
          { name: "🛡️ Advisor", value: advisorText, inline: true },
          { name: "🌿 Git Branch", value: branchText, inline: true },
          { name: "📁 Working Directory", value: `\`${ sessionCwd }\``, inline: false },
          { name: "⚡ Fast Mode", value: fastMode ? "⚡ Active" : "Off", inline: true },
        )
        .setTimestamp();

      await interaction.editReply(
        `🚀 Session started in <#${ thread.id }>\n📁 Directory: \`${ sessionCwd }\`${createdWorktree ? `\n🌿 Isolated branch: \`${ createdWorktree.branch }\`` : ""}\n🤖 Model: \`${ modelDisplay }\``,
      );
      await thread.send({
        embeds: [sessionEmbed],
      });
    } catch (err) {
      if (createdWorktree) {
        await removeGitWorktree(createdWorktree);
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      await interaction.editReply(`Failed to start session: ${ errorMsg }`);
    }
    return;
  }

  // Terminate All Sessions
  if (interaction.commandName === "omp-terminate-all") {
    const count = sessionManager.count;
    if (count === 0) {
      await interaction.reply({
        content: "ℹ️ No active OMP sessions found.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();
    console.log(`🛑 /omp-terminate-all requested: Terminating ${ count } active session(s)...`);

    await sessionManager.terminateAll(client, true);
    try {
      await interaction.editReply(
        `🛑 Successfully terminated ${ count } active OMP session${ count === 1 ? "" : "s" } and deleted associated Discord thread${ count === 1 ? "" : "s" }.`,
      );
    } catch {
      // Channel might have been deleted if command was run inside one of the terminated threads
    }
    return;
  }

  // Session-bound Slash Commands
  const session = sessionManager.get(interaction.channelId);
  if (!session) {
    await interaction.reply({
      content: "⚠️ This command must be executed inside an active OMP thread created by `/omp-new`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // /diff [staged] [path]
  if (interaction.commandName === "diff") {
    const staged = interaction.options.getBoolean("staged") ?? false;
    const pathFilter = interaction.options.getString("path") || undefined;
    const result = await inspectGitDiff(session.cwd, { staged, path: pathFilter });
    if (result.error) {
      await interaction.reply(`❌ ${ result.error }`);
      return;
    }
    const scope = result.path ? ` for \`${ result.path }\`` : "";
    if (!result.hasChanges) {
      await interaction.reply(`ℹ️ No ${ staged ? "staged" : "unstaged" } changes${ scope } found in this workspace.`);
      return;
    }
    const summaryEmbed = new EmbedBuilder()
      .setTitle(`${ staged ? "Staged" : "Unstaged" } Git Changes`)
      .setColor(0x2f80ed)
      .addFields(
        { name: "Summary", value: result.summary || "Changed files detected.", inline: false },
        ...(result.stat.trim() ? [{ name: "Diff stat", value: `\`\`\`\n${ result.stat.trim().slice(0, 900) }\n\`\`\``, inline: false }] : []),
      )
      .setTimestamp();
    if (!result.hasDiff) {
      await interaction.reply({
        content: `ℹ️ Git reports changes${ scope }, but there is no ${ staged ? "staged" : "unstaged" } patch to display (for example, an untracked file).`,
        embeds: [summaryEmbed],
      });
      return;
    }
    const formatted = formatDiffForDiscord(result.diff);
    if (formatted.inline) {
      await interaction.reply({ content: formatted.content, embeds: [summaryEmbed] });
    } else {
      await interaction.reply({
        content: "📎 The diff is too large for a Discord message; the complete patch is attached.",
        embeds: [summaryEmbed],
        files: [{ attachment: formatted.attachment!, name: formatted.filename! }],
      });
    }
    return;
  }

  // /download [path]
  if (interaction.commandName === "download") {
    const requestedPath = interaction.options.getString("path", true);
    const result = resolveWorkspaceFile(session.cwd, requestedPath);
    if (!result.ok || !result.file) {
      await interaction.reply({ content: `❌ ${ result.error || "Unable to resolve that file." }`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!isDownloadableWorkspaceFile(result.file)) {
      await interaction.reply({
        content: `❌ That file is ${ Math.ceil(result.file.size / (1024 * 1024)) }MB, which exceeds Discord's 25MB attachment limit.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    try {
      const contents = readFileSync(result.file.absolutePath);
      if (contents.byteLength > MAX_WORKSPACE_DOWNLOAD_BYTES) {
        await interaction.reply({ content: "❌ The file grew beyond Discord's 25MB attachment limit while it was being read.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({
        content: `📎 Downloading \`${ result.file.relativePath }\` (${ contents.byteLength } bytes).`,
        files: [{ attachment: contents, name: basename(result.file.relativePath) }],
      });
    } catch {
      await interaction.reply({ content: "❌ Unable to read that file from the session workspace.", flags: MessageFlags.Ephemeral });
    }
    return;
  }

  // /commit [message]
  if (interaction.commandName === "commit") {
    const message = interaction.options.getString("message", true);
    await interaction.deferReply();
    const result = await commitWorkspaceChanges(session.cwd, message);
    if (result.error) {
      await interaction.editReply(`❌ ${ result.error }`);
    } else if (!result.committed) {
      await interaction.editReply("ℹ️ There are no staged or tracked changes to commit.");
    } else {
      await interaction.editReply(`✅ Committed workspace changes${result.hash ? ` as \`${ result.hash }\`` : ""}.`);
    }
    return;
  }

  if (interaction.commandName === "skill") {
    const skillName = interaction.options.getString("name", true);
    const prompt = interaction.options.getString("prompt", true);
    const fullPrompt = `$${ skillName } ${ prompt }`;

    if (interaction.channel?.isThread()) {
      startTyping(session, interaction.channel);
    }
    await interaction.reply(`🎯 Invoking skill \`$${ skillName }\`...`);
    sendRpc(session, {
      id: `skill_${ Date.now() }`,
      type: "prompt",
      message: fullPrompt,
    });
    return;
  }

  // /cmd [command] [args]
  if (interaction.commandName === "cmd") {
    const cmdName = interaction.options.getString("command", true);
    const args = interaction.options.getString("args") || "";
    const fullCommand = `/${ cmdName } ${ args }`.trim();

    if (interaction.channel?.isThread()) {
      startTyping(session, interaction.channel);
    }
    await interaction.reply(`⚡ Running command \`${ fullCommand }\`...`);
    sendRpc(session, {
      id: `cmd_${ Date.now() }`,
      type: "prompt",
      message: fullCommand,
    });
    return;
  }


  // /model [selection]
  if (interaction.commandName === "model") {
    const selection = interaction.options.getString("selection");
    if (selection) {
      await interaction.reply(`🔄 Switching model to \`${ selection }\`...`);
      session.hudState = {
        ...(session.hudState || { cwd: session.cwd }),
        model: selection,
        updatedAt: Date.now(),
      } as unknown as Record<string, unknown>;
      scheduleHudUpdate(session);
      sendRpc(session, {
        id: `model_${ Date.now() }`,
        type: "prompt",
        message: `/model ${ selection }`,
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
      await interaction.reply(`⚡ Setting fast mode to \`${ mode }\`...`);
      sendRpc(session, { id: "fast_set", type: "set_fast_mode", enabled });
    }
    return;
  }

  // /think [level]
  if (interaction.commandName === "think") {
    const level = interaction.options.getString("level", true);
    await interaction.reply(`🧠 Setting thinking level to \`${ level }\`...`);
    session.hudState = {
      ...(session.hudState || { cwd: session.cwd }),
      reasoningLevel: level,
      updatedAt: Date.now(),
    } as unknown as Record<string, unknown>;
    scheduleHudUpdate(session);
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

const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024; // 25MB
const ATTACHMENT_FETCH_TIMEOUT_MS = 15000; // 15 seconds


async function processImageAttachment(
  att: { url: string; contentType?: string | null; name?: string | null; size?: number },
): Promise<ImagePayload | null> {
  if (typeof att.size === "number" && att.size > MAX_ATTACHMENT_SIZE_BYTES) {
    console.warn(`Attachment ${ att.name || "unnamed" } exceeds max size limit (${ att.size } > ${ MAX_ATTACHMENT_SIZE_BYTES } bytes).`);
    return null;
  }
  try {
    const res = await fetch(att.url, { signal: AbortSignal.timeout(ATTACHMENT_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.error(`Failed to download image attachment ${ att.name || "unnamed" } (status ${ res.status })`);
      return null;
    }
    const contentLength = Number(res.headers.get("content-length"));
    if (contentLength && contentLength > MAX_ATTACHMENT_SIZE_BYTES) {
      console.warn(`Image attachment ${ att.name || "unnamed" } exceeds size limit (${ contentLength } bytes).`);
      return null;
    }
    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength > MAX_ATTACHMENT_SIZE_BYTES) {
      console.warn(`Image attachment ${ att.name || "unnamed" } exceeds size limit (${ arrayBuf.byteLength } bytes).`);
      return null;
    }
    const base64 = Buffer.from(arrayBuf).toString("base64");
    let mimeType = att.contentType || "";
    if (!mimeType || !mimeType.startsWith("image/")) {
      const ext = (att.name || "").split(".").pop()?.toLowerCase();
      if (ext === "png") {
 mimeType = "image/png"; 
} else if (ext === "jpg" || ext === "jpeg") {
 mimeType = "image/jpeg"; 
} else if (ext === "webp") {
 mimeType = "image/webp"; 
} else if (ext === "gif") {
 mimeType = "image/gif"; 
} else if (ext === "bmp") {
 mimeType = "image/bmp"; 
} else {
  mimeType = "image/png";
}
    }
    return {
      type: "image",
      data: base64,
      mimeType,
    };
  } catch (err) {
    console.error(`Error processing image attachment ${ att.name || "unnamed" }:`, err);
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
  att: { url: string; name?: string | null; size?: number },
): Promise<string | null> {
  if (typeof att.size === "number" && att.size > MAX_ATTACHMENT_SIZE_BYTES) {
    console.warn(`Attachment ${ att.name || "unnamed" } exceeds max size limit (${ att.size } > ${ MAX_ATTACHMENT_SIZE_BYTES } bytes).`);
    return null;
  }
  try {
    const res = await fetch(att.url, { signal: AbortSignal.timeout(ATTACHMENT_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.error(`Failed to download attachment ${ att.name || "unnamed" } (status ${ res.status })`);
      return null;
    }
    const contentLength = Number(res.headers.get("content-length"));
    if (contentLength && contentLength > MAX_ATTACHMENT_SIZE_BYTES) {
      console.warn(`Attachment ${ att.name || "unnamed" } exceeds size limit (${ contentLength } bytes).`);
      return null;
    }
    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength > MAX_ATTACHMENT_SIZE_BYTES) {
      console.warn(`Attachment ${ att.name || "unnamed" } exceeds size limit (${ arrayBuf.byteLength } bytes).`);
      return null;
    }
    const dir = getAttachmentDir(session, messageId);
    const rawName = att.name || "attachment";
    const sanitized = basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
    const targetPath = join(dir, sanitized);
    writeFileSync(targetPath, Buffer.from(arrayBuf));
    return targetPath;
  } catch (err) {
    console.error(`Error saving non-image attachment ${ att.name || "unnamed" }:`, err);
    return null;
  }
}


async function extractMessagePrompt(
  session: SessionContext,
  message: Message,
): Promise<{ text: string; images: ImagePayload[] }> {
  const images: ImagePayload[] = [];
  const savedFilePaths: string[] = [];

  if (message.attachments.size > 0) {
    for (const [, att] of message.attachments) {
      const isImage = (att.contentType?.startsWith("image/") ?? false) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(att.name || "");
      if (isImage) {
        const img = await processImageAttachment(att);
        if (img) {
          images.push(img);
        }
      } else {
        const filePath = await saveNonImageAttachment(session, message.id, att);
        if (filePath) {
          savedFilePaths.push(filePath);
        }
      }
    }
  }

  let text = message.content.trim();
  if (savedFilePaths.length > 0) {
    const fileRefs = savedFilePaths.map((p) => `@${ p }`).join(" ");
    text = text ? `${ fileRefs } ${ text }` : fileRefs;
  }

  return { text, images };
}

// Handle Chat Messages in Threads
client.on("messageCreate", async (message) => {
  if (message.author.bot) {
    return;
  }
  if (!isUserAllowed(message.author.id)) {
    return;
  }
  const session = sessionManager.get(message.channelId);
  if (!session) {
    return;
  }
  if (session.isRewinding) {
    await message.reply("⏳ *Session is currently rewinding. Please wait a moment before sending new messages.*").catch(() => {});
    return;
  }

  const { text, images } = await extractMessagePrompt(session, message);
  if (!text && images.length === 0) {
    stopTyping(session);
    return;
  }

  if (message.channel.isThread()) {
    startTyping(session, message.channel);
  }

  session.lastPrompt = message.content.trim() || "Attachment";
  if (message.channel.isThread()) {
    await updateThreadNameFromPrompt(message.channel, session.lastPrompt);
  }

  recordUserTurnCheckpoint(session, message.id, message.content.trim());
  void persistSessionCheckpoints(session, sessionManager);

  sendRpc(session, {
    id: `prompt_${ Date.now() }`,
    type: "prompt",
    message: text,
    ...(images.length > 0 ? { images } : {}),
  });
});

// Handle Message Edit as Rewind
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  await handleMessageEditAsRewind(oldMessage, newMessage, {
    sessionManager,
    isUserAllowed,
    extractMessagePrompt,
    startTyping,
    updateThreadNameFromPrompt,
    sendRpc,
  });
});

// Handle Thread Deletions to clean up OMP processes automatically
client.on(Events.ThreadDelete, (thread) => {
  console.log(`🗑️ Thread ${ thread.id } ("${ thread.name }") deleted. Terminating OMP session...`);
  void sessionManager.terminate(thread.id, client, false);
});

client.on(Events.ClientReady, async () => {
  console.log(`🤖 OMP Discord Bot is online as ${ client.user?.tag }!`);
  if (allowedUserIds.size > 0) {
    console.log(`🔒 User allowlist active: ${ allowedUserIds.size } allowed user(s).`);
  } else {
    console.warn("⚠️ WARNING: No ALLOWED_USERS configured! All user interactions are blocked (fail-closed). Add Discord user IDs to ALLOWED_USERS in .env.");
  }
  await sessionManager.restoreAll(client, createOmpSession);
});

client.login(DISCORD_TOKEN);
