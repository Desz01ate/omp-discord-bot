import { EmbedBuilder } from "discord.js";

export const OBSERVABILITY_UPDATE_THROTTLE_MS = 1200;
export const MAX_TOOL_PREVIEW_LENGTH = 700;

export interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
  contextWindow?: number;
  contextPercent?: number;
}

export interface HudState {
  model?: string;
  reasoningLevel?: string;
  tokens?: TokenUsage;
  activeSubagents?: string[] | number;
  activeTool?: string;
  branch?: string;
  gitDirty?: boolean;
  cwd?: string;
  turnStatus?: string;
  updatedAt?: number;
}

export type ToolExecutionPhase = "running" | "updated" | "completed" | "failed";

export interface ToolExecutionTrace {
  id: string;
  toolName: string;
  args?: unknown;
  intent?: string;
  phase: ToolExecutionPhase;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  exitCode?: number | null;
  outputPreview?: string;
  error?: string;
}

const TOOL_ICONS: Record<string, string> = {
  bash: "🔨",
  read: "📖",
  edit: "✏️",
  write: "📝",
  task: "🤖",
  browser: "🌐",
  screenshot: "🖼️",
  grep: "🔍",
  glob: "📂",
  eval: "⚙️",
  lsp: "🧠",
};

export function toolIcon(toolName: string): string {
  return TOOL_ICONS[toolName.toLowerCase()] || "🔧";
}

export function formatTokenCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "N/A";
}

function formatContextPercent(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "N/A";
  const percent = value <= 1 ? value * 100 : value;
  return `${Math.round(percent)}%`;
}

export function formatHudEmbed(state: HudState): EmbedBuilder {
  const tokens = state.tokens || {};
  const model = state.model || "unknown";
  const reasoning = state.reasoningLevel || "normal";
  const activeSubagents = Array.isArray(state.activeSubagents)
    ? state.activeSubagents.length > 0
      ? state.activeSubagents.join(", ")
      : "None"
    : typeof state.activeSubagents === "number"
      ? state.activeSubagents > 0
        ? `${state.activeSubagents} active`
        : "None"
      : "None";
  const branch = state.branch || "None (not a git repo)";
  const git = state.gitDirty == null ? branch : `${branch} ${state.gitDirty ? "• uncommitted changes" : "• clean"}`;
  const context = tokens.contextWindow
    ? `${formatTokenCount(tokens.total)} / ${formatTokenCount(tokens.contextWindow)} (${formatContextPercent(tokens.contextPercent)})`
    : tokens.contextPercent == null
      ? "N/A"
      : formatContextPercent(tokens.contextPercent);

  const embed = new EmbedBuilder()
    .setTitle("📡 OMP Live HUD")
    .setColor(state.turnStatus === "running" ? 0xf1c40f : 0x5865f2)
    .addFields(
      { name: "🤖 Model • Reasoning", value: `\`${model}\` • **${reasoning}**`, inline: true },
      { name: "📥 Input Tokens", value: formatTokenCount(tokens.input), inline: true },
      { name: "📤 Output Tokens", value: formatTokenCount(tokens.output), inline: true },
      { name: "🔢 Total Tokens", value: formatTokenCount(tokens.total), inline: true },
      { name: "📐 Context", value: context, inline: true },
      { name: "🤖 Active Subagents", value: activeSubagents, inline: true },
      { name: "🔧 Active Tool", value: state.activeTool || "Idle", inline: true },
      { name: "🌿 Git", value: git, inline: true },
      ...(state.cwd ? [{ name: "📁 Directory", value: `\`${state.cwd}\``, inline: false }] : []),
    )
    .setFooter({ text: "Live session status • updates throttled to protect Discord rate limits" });

  if (state.updatedAt) embed.setTimestamp(state.updatedAt);
  return embed;
}

export function formatToolArguments(args: unknown): string {
  if (args == null) return "";
  let rendered: string;
  if (typeof args === "string") {
    rendered = args;
  } else {
    try {
      rendered = JSON.stringify(args) ?? String(args);
    } catch {
      rendered = String(args);
    }
  }
  rendered = rendered.replace(/```/g, "``\\`");
  return rendered.length > MAX_TOOL_PREVIEW_LENGTH ? `${rendered.slice(0, MAX_TOOL_PREVIEW_LENGTH - 3)}...` : rendered;
}

export function formatToolOutputPreview(output: unknown): string {
  if (output == null) return "";
  const raw = typeof output === "string" ? output : formatToolArguments(output);
  const normalized = raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  if (!normalized) return "";
  const singleLine = normalized.length > MAX_TOOL_PREVIEW_LENGTH
    ? `${normalized.slice(0, MAX_TOOL_PREVIEW_LENGTH - 3)}...`
    : normalized;
  return singleLine.replace(/```/g, "``\\`");
}

export function formatToolSummary(trace: ToolExecutionTrace): string {
  if (trace.intent && trace.intent.trim()) {
    return trace.intent.trim();
  }
  const args = trace.args;
  if (!args) return "";
  if (typeof args === "string") return args.trim();
  if (typeof args === "object" && args !== null) {
    const record = args as Record<string, unknown>;
    for (const key of ["command", "path", "pattern", "query", "url", "file", "name", "title"]) {
      if (typeof record[key] === "string" && record[key]) {
        return `${key !== "command" && key !== "path" && key !== "url" ? `${key}: ` : ""}${record[key]}`;
      }
    }
    try {
      const serialized = JSON.stringify(record);
      return serialized.length > 50 ? `${serialized.slice(0, 47)}...` : serialized;
    } catch {
      return "";
    }
  }
  return "";
}

export function formatToolTracesEmbed(traces: ToolExecutionTrace[]): EmbedBuilder {
  if (!traces || traces.length === 0) {
    return new EmbedBuilder()
      .setTitle("🛠️ Tool Traces")
      .setColor(0x5865f2)
      .setDescription("No tool calls recorded.")
      .setFooter({ text: "Live tool execution tracing" });
  }

  const hasFailed = traces.some((t) => t.phase === "failed");
  const isRunning = traces.some((t) => t.phase === "running" || t.phase === "updated");
  const allCompleted = traces.every((t) => t.phase === "completed");

  const color = hasFailed ? 0xed4245 : isRunning ? 0xf1c40f : allCompleted ? 0x57f287 : 0x5865f2;

  const activeTrace =
    [...traces].reverse().find((t) => t.phase === "running" || t.phase === "updated") ||
    traces[traces.length - 1];

  if (traces.length === 1) {
    const icon = toolIcon(activeTrace.toolName);
    const status =
      activeTrace.phase === "running"
        ? "⏳ Running"
        : activeTrace.phase === "updated"
          ? "🔄 Updating"
          : activeTrace.phase === "failed"
            ? "❌ Failed"
            : "✅ Completed";
    const duration = activeTrace.durationMs == null ? "—" : `${(activeTrace.durationMs / 1000).toFixed(2)}s`;
    return new EmbedBuilder()
      .setTitle(`${icon} ${activeTrace.toolName}`)
      .setColor(color)
      .addFields(
        { name: "Status", value: status, inline: true },
        { name: "Duration", value: duration, inline: true },
        ...(activeTrace.exitCode !== undefined
          ? [{ name: "Exit", value: activeTrace.exitCode == null ? "unknown" : String(activeTrace.exitCode), inline: true }]
          : []),
        ...(activeTrace.intent ? [{ name: "Intent", value: activeTrace.intent.slice(0, 1024), inline: false }] : []),
        ...(activeTrace.error ? [{ name: "Error", value: activeTrace.error.slice(0, 1024), inline: false }] : []),
      )
      .setFooter({ text: `Trace ${activeTrace.id}` });
  }

  const icon = toolIcon(activeTrace.toolName);
  let title: string;
  if (isRunning) {
    title = `🛠️ Tool Traces (${traces.length}) • ${icon} ${activeTrace.toolName}`;
  } else if (hasFailed) {
    const failCount = traces.filter((t) => t.phase === "failed").length;
    title = `🛠️ Tool Traces (${traces.length} tools • ${failCount} failed)`;
  } else {
    title = `🛠️ Tool Traces (${traces.length} completed)`;
  }

  const embed = new EmbedBuilder().setTitle(title).setColor(color);

  const maxVisible = 10;
  let descriptionLines: string[] = [];
  if (traces.length <= maxVisible) {
    descriptionLines = traces.map((t, idx) => {
      const tIcon = toolIcon(t.toolName);
      const statusEmoji =
        t.phase === "running"
          ? "⏳"
          : t.phase === "updated"
            ? "🔄"
            : t.phase === "failed"
              ? "❌"
              : "✅";
      const dur =
        t.durationMs != null
          ? `${(t.durationMs / 1000).toFixed(2)}s`
          : t.phase === "running" || t.phase === "updated"
            ? "running"
            : "—";
      const summary = formatToolSummary(t);
      const summaryStr = summary ? ` — \`${summary.replace(/`/g, "'").slice(0, 50)}\`` : "";
      return `${idx + 1}. ${statusEmoji} ${tIcon} **${t.toolName}** (${dur})${summaryStr}`;
    });
  } else {
    const omitted = traces.length - maxVisible;
    const visible = traces.slice(-maxVisible);
    descriptionLines.push(`*(... ${omitted} earlier tool call${omitted > 1 ? "s" : ""} omitted)*`);
    descriptionLines.push(
      ...visible.map((t, idx) => {
        const actualIdx = traces.length - maxVisible + idx + 1;
        const tIcon = toolIcon(t.toolName);
        const statusEmoji =
          t.phase === "running"
            ? "⏳"
            : t.phase === "updated"
              ? "🔄"
              : t.phase === "failed"
                ? "❌"
                : "✅";
        const dur =
          t.durationMs != null
            ? `${(t.durationMs / 1000).toFixed(2)}s`
            : t.phase === "running" || t.phase === "updated"
              ? "running"
              : "—";
        const summary = formatToolSummary(t);
        const summaryStr = summary ? ` — \`${summary.replace(/`/g, "'").slice(0, 50)}\`` : "";
        return `${actualIdx}. ${statusEmoji} ${tIcon} **${t.toolName}** (${dur})${summaryStr}`;
      }),
    );
  }
  embed.setDescription(descriptionLines.join("\n"));

  const statusLabel =
    activeTrace.phase === "running"
      ? "⏳ Running"
      : activeTrace.phase === "updated"
        ? "🔄 Updating"
        : activeTrace.phase === "failed"
          ? "❌ Failed"
          : "✅ Completed";
  const durationLabel = activeTrace.durationMs == null ? "—" : `${(activeTrace.durationMs / 1000).toFixed(2)}s`;
  const latestHeading = isRunning
    ? `⏳ Active Tool • ${icon} ${activeTrace.toolName}`
    : `Latest Tool • ${icon} ${activeTrace.toolName}`;

  let statusLine = `**Status**: ${statusLabel} • **Duration**: ${durationLabel}`;
  if (activeTrace.exitCode !== undefined) {
    statusLine += ` • **Exit**: \`${activeTrace.exitCode == null ? "unknown" : activeTrace.exitCode}\``;
  }

  embed.addFields(
    { name: latestHeading, value: statusLine, inline: false },
    ...(activeTrace.intent ? [{ name: "Intent", value: activeTrace.intent.slice(0, 1024), inline: false }] : []),
    ...(activeTrace.error ? [{ name: "Error", value: activeTrace.error.slice(0, 1024), inline: false }] : []),
  );

  const totalDurationMs = traces.reduce((acc, t) => acc + (t.durationMs || 0), 0);
  const totalDurationStr = totalDurationMs > 0 ? ` • Total tool time: ${(totalDurationMs / 1000).toFixed(2)}s` : "";
  embed.setFooter({ text: `${traces.length} tool call${traces.length > 1 ? "s" : ""} in turn${totalDurationStr}` });

  return embed;
}

export function formatToolExecutionEmbed(trace: ToolExecutionTrace): EmbedBuilder {
  return formatToolTracesEmbed([trace]);
}
