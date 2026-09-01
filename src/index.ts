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
  type AutocompleteInteraction,
} from "discord.js";
import { spawn, type Subprocess } from "bun";
import { createInterface } from "readline";
import { Readable } from "stream";
import type { ReadableStream as WebReadableStream } from "stream/web";
import { basename, resolve } from "path";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error("Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment.");
  process.exit(1);
}

type OmpProcess = Subprocess<"pipe", "pipe", "inherit">;

interface SessionContext {
  process: OmpProcess;
  threadId: string;
  cwd: string;
  activePromptMsg?: Message;
  currentStreamBuffer: string;
  lastEditTimestamp: number;
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
    // 1. Session creation
    new SlashCommandBuilder()
      .setName("omp-new")
      .setDescription("Start a new OMP session in a dedicated thread")
      .addStringOption((opt) =>
        opt
          .setName("directory")
          .setDescription("Working directory path (default: current working directory)")
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
function createOmpSession(thread: ThreadChannel, cwd: string): SessionContext {
  const proc = spawn(["omp", "--mode", "rpc"], {
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
    void thread.send(`⚠️ OMP process exited (code ${code}).`).catch(() => {});
    sessions.delete(thread.id);
  });

  return session;
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
    return;
  }

  // 2. Turn Start
  if (type === "agent_start") {
    session.currentStreamBuffer = "";
    session.activePromptMsg = await thread.send("🤔 *Thinking...*");
    session.lastEditTimestamp = Date.now();
    return;
  }

  // 3. Streaming Text Updates
  if (type === "message_update") {
    const assistantMessageEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
    const delta = typeof assistantMessageEvent?.delta === "string" ? assistantMessageEvent.delta : undefined;
    if (delta) {
      session.currentStreamBuffer += delta;

      // Throttle Discord edits (~1 edit per 1.2 seconds)
      const now = Date.now();
      if (now - session.lastEditTimestamp > 1200 && session.activePromptMsg) {
        session.lastEditTimestamp = now;
        const text = session.currentStreamBuffer.slice(-1900);
        await session.activePromptMsg.edit(text || "⏳ *Executing...*").catch(() => {});
      }
    }
    return;
  }

  // 4. Tool Execution Events
  if (type === "tool_execution_start") {
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    const inputStr = JSON.stringify(event.input || {});
    const truncated = inputStr.length > 80 ? inputStr.slice(0, 77) + "..." : inputStr;
    await thread.send(`🔧 \`${toolName}\` \`${truncated}\``).catch(() => {});
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

    if (rawOutput.trim()) {
      if (rawOutput.length <= 1950) {
        await thread.send(`\`\`\`\n${rawOutput}\n\`\`\``).catch(() => {});
      } else {
        for (let i = 0; i < rawOutput.length; i += 1900) {
          await thread.send(`\`\`\`\n${rawOutput.slice(i, i + 1900)}\n\`\`\``).catch(() => {});
        }
      }
    }
    return;
  }

  // 7. Response frames (e.g. state / custom query results)
  if (type === "response" && event.command === "get_state" && event.data && typeof event.data === "object") {
    const data = event.data as Record<string, unknown>;
    const model = data.model as { provider?: string; id?: string } | undefined;
    const modelStr = model ? `${model.provider}/${model.id}` : "unknown";
    const tokens = (data.contextUsage as { tokens?: number; contextWindow?: number; percent?: number }) || {};

    const embed = new EmbedBuilder()
      .setTitle("📊 OMP Session Status")
      .setColor(0x5865f2)
      .addFields(
        { name: "Model", value: `\`${modelStr}\``, inline: true },
        { name: "Thinking Level", value: `\`${String(data.thinkingLevel || "normal")}\``, inline: true },
        { name: "Fast Mode", value: data.fastModeActive ? "⚡ Active" : "Off", inline: true },
        {
          name: "Context Usage",
          value: tokens.tokens != null ? `${tokens.tokens.toLocaleString()} / ${tokens.contextWindow?.toLocaleString()} (${Math.round((tokens.percent || 0) * 100)}%)` : "N/A",
          inline: false,
        },
        { name: "Messages", value: `${data.messageCount ?? 0} in session`, inline: true },
      );

    await thread.send({ embeds: [embed] }).catch(() => {});
    return;
  }

  // 8. Turn Finish
  if (type === "agent_end") {
    if (session.activePromptMsg && session.currentStreamBuffer) {
      const full = session.currentStreamBuffer;
      if (full.length <= 1950) {
        await session.activePromptMsg.edit(full).catch(() => {});
      } else {
        await session.activePromptMsg.edit(full.slice(0, 1950)).catch(() => {});
        for (let i = 1950; i < full.length; i += 1950) {
          await thread.send(full.slice(i, i + 1950)).catch(() => {});
        }
      }
    }
    session.activePromptMsg = undefined;
    session.currentStreamBuffer = "";
    return;
  }

  // 9. Prompt Result without agent turn (Local command completion)
  if (type === "prompt_result" && event.agentInvoked === false) {
    if (session.activePromptMsg) {
      await session.activePromptMsg.delete().catch(() => {});
      session.activePromptMsg = undefined;
    }
    session.currentStreamBuffer = "";
  }
}

// Handle Autocomplete Interactions
async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);

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
    const query = focused.value.toLowerCase();
    const filtered = cachedModels
      .filter((m) => m.id.toLowerCase().includes(query) || (m.name && m.name.toLowerCase().includes(query)))
      .slice(0, 25)
      .map((m) => ({
        name: `${m.name || m.id} [${m.provider || "omp"}] (${Math.round((m.contextWindow || 0) / 1000)}k ctx)`.slice(0, 100),
        value: m.id,
      }));
    await interaction.respond(filtered);
    return;
  }
}

// Handle Slash Command Executions
client.on("interactionCreate", async (interaction) => {
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
        ephemeral: true,
      });
      return;
    }

    const textChannel = channel as TextChannel;
    const rawCwd = interaction.options.getString("directory") || process.cwd();
    const cwd = resolve(
      rawCwd.startsWith("~") ? rawCwd.replace(/^~(?=$|\/|\\)/, process.env.HOME || "") : rawCwd,
    );
    const dirName = basename(cwd) || "workspace";
    const sessionId = Math.random().toString(36).slice(2, 8);
    const threadName = `${dirName} (${sessionId})`.slice(0, 100);

    await interaction.deferReply();

    try {
      const thread = await textChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 1440,
      });

      const session = createOmpSession(thread, cwd);
      sessions.set(thread.id, session);

      await interaction.editReply(`🚀 Session started in <#${thread.id}>\n📁 Directory: \`${cwd}\``);
      await thread.send(
        `👋 **OMP Session Active**\nType in this thread or use slash commands (\`/skill\`, \`/cmd\`, \`/model\`, \`/fast\`, \`/think\`, \`/abort\`, \`/status\`).`,
      );
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
      ephemeral: true,
    });
    return;
  }

  // /skill [name] [prompt]
  if (interaction.commandName === "skill") {
    const skillName = interaction.options.getString("name", true);
    const prompt = interaction.options.getString("prompt", true);
    const fullPrompt = `$${skillName} ${prompt}`;

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

// Handle Chat Messages in Threads
client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  const session = sessions.get(message.channelId);
  if (!session) return;

  sendRpc(session, {
    id: `prompt_${Date.now()}`,
    type: "prompt",
    message: message.content,
  });
});

client.on("ready", () => {
  console.log(`🤖 OMP Discord Bot is online as ${client.user?.tag}!`);
});

client.login(DISCORD_TOKEN);
