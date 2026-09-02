import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";

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

export interface VisualArtifact {
  id: string;
  source: string;
  sourceType: "path" | "url" | "data";
  name: string;
  mimeType?: string;
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

export function formatToolExecutionEmbed(trace: ToolExecutionTrace): EmbedBuilder {
  const icon = toolIcon(trace.toolName);
  const status = trace.phase === "running"
    ? "⏳ Running"
    : trace.phase === "updated"
      ? "🔄 Updating"
      : trace.phase === "failed"
        ? "❌ Failed"
        : "✅ Completed";
  const duration = trace.durationMs == null ? "—" : `${(trace.durationMs / 1000).toFixed(2)}s`;
  const color = trace.phase === "failed" ? 0xed4245 : trace.phase === "completed" ? 0x57f287 : 0x5865f2;
  const embed = new EmbedBuilder()
    .setTitle(`${icon} ${trace.toolName}`)
    .setColor(color)
    .addFields(
      { name: "Status", value: status, inline: true },
      { name: "Duration", value: duration, inline: true },
      ...(trace.exitCode !== undefined ? [{ name: "Exit", value: trace.exitCode == null ? "unknown" : String(trace.exitCode), inline: true }] : []),
      ...(trace.intent ? [{ name: "Intent", value: trace.intent.slice(0, 1024), inline: false }] : []),
      ...(trace.args !== undefined ? [{ name: "Input", value: `||\`\`\`json\n${formatToolArguments(trace.args)}\n\`\`\`||`, inline: false }] : []),
      ...(trace.outputPreview ? [{ name: "Output Preview", value: `||\`\`\`\n${trace.outputPreview}\n\`\`\`||`, inline: false }] : []),
      ...(trace.error ? [{ name: "Error", value: trace.error.slice(0, 1024), inline: false }] : []),
    )
    .setFooter({ text: `Trace ${trace.id}` });
  return embed;
}

function looksLikeImagePath(value: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|bmp|svg|avif)(?:[?#].*)?$/i.test(value);
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function looksLikeData(value: string): boolean {
  return /^data:image\//i.test(value);
}

function mimeFromName(name: string): string | undefined {
  const ext = name.match(/\.([a-z0-9]+)(?:[?#].*)?$/i)?.[1]?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    avif: "image/avif",
  };
  return map[ext];
}

function isVisualHint(key: string): boolean {
  return /(?:image|screenshot|visual|artifact|preview|capture)/i.test(key);
}

function candidateFromObject(value: Record<string, unknown>, keyHint: string, id: string): VisualArtifact | null {
  const mimeType = typeof value.mimeType === "string"
    ? value.mimeType
    : typeof value.contentType === "string"
      ? value.contentType
      : undefined;
  const name = typeof value.name === "string"
    ? value.name
    : typeof value.filename === "string"
      ? value.filename
      : `${id}.png`;
  const objectType = typeof value.type === "string" ? value.type : "";
  const visualObject = isVisualHint(keyHint) || /(?:image|screenshot|visual)/i.test(objectType);
  const data = typeof value.data === "string" ? value.data : typeof value.base64 === "string" ? value.base64 : undefined;
  if (data && (mimeType?.startsWith("image/") || looksLikeData(data) || visualObject)) {
    return {
      id,
      source: data,
      sourceType: "data",
      name,
      mimeType: mimeType || data.match(/^data:(image\/[^;,]+)/i)?.[1] || mimeFromName(name),
    };
  }

  const url = typeof value.url === "string" ? value.url : typeof value.href === "string" ? value.href : undefined;
  if (url && (mimeType?.startsWith("image/") || looksLikeImagePath(url) || visualObject)) {
    return { id, source: url, sourceType: "url", name, mimeType: mimeType || mimeFromName(url) };
  }

  const path = typeof value.path === "string" ? value.path : typeof value.filePath === "string" ? value.filePath : undefined;
  if (path && (mimeType?.startsWith("image/") || looksLikeImagePath(path) || visualObject)) {
    return { id, source: path, sourceType: "path", name, mimeType: mimeType || mimeFromName(path) };
  }
  return null;
}

/**
 * Find the first image artifact in a tool/subagent RPC event. The RPC schema has
 * changed over time, so this intentionally accepts common `artifact`, `image`,
 * `screenshot`, `result`, and nested array shapes.
 */
export function extractVisualArtifact(event: unknown, id = `visual_${Date.now().toString(36)}`): VisualArtifact | null {
  const visited = new Set<object>();
  const visit = (value: unknown, keyHint: string, depth: number): VisualArtifact | null => {
    if (depth > 7 || value == null) return null;
    if (typeof value === "string") {
      if (looksLikeData(value)) return { id, source: value, sourceType: "data", name: `${id}.png`, mimeType: value.match(/^data:(image\/[^;,]+)/i)?.[1] };
      if (isVisualHint(keyHint) && value.length > 64 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        return { id, source: value, sourceType: "data", name: `${id}.png`, mimeType: "image/png" };
      }
      const inlineImage = value.match(/(?:https?:\/\/[^\s"'`]+|(?:~|\.{0,2}\/|\/)[^\s"'`]+\.(?:png|jpe?g|webp|gif|bmp|svg|avif)(?:\?[^\s"'`]*)?)/i)?.[0]?.replace(/[),.;]+$/, "");
      if (inlineImage && (looksLikeUrl(inlineImage) || looksLikeImagePath(inlineImage))) {
        return {
          id,
          source: inlineImage,
          sourceType: looksLikeUrl(inlineImage) ? "url" : "path",
          name: inlineImage.split(/[\\/]/).pop() || `${id}.png`,
          mimeType: mimeFromName(inlineImage),
        };
      }
      if (looksLikeUrl(value) && (looksLikeImagePath(value) || isVisualHint(keyHint))) {
        return { id, source: value, sourceType: "url", name: `${id}.png`, mimeType: mimeFromName(value) };
      }
      if (looksLikeImagePath(value)) {
        return { id, source: value, sourceType: "path", name: value.split(/[\\/]/).pop() || `${id}.png`, mimeType: mimeFromName(value) };
      }
      return null;
    }
    if (typeof value !== "object") return null;
    if (visited.has(value)) return null;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const result = visit(item, keyHint, depth + 1);
        if (result) return result;
      }
      return null;
    }
    const object = value as Record<string, unknown>;
    const direct = candidateFromObject(object, keyHint, id);
    if (direct) return direct;
    const keys = ["artifact", "artifacts", "image", "images", "screenshot", "screenshots", "visual", "visualArtifact", "result", "output", "data"];
    for (const key of keys) {
      if (!(key in object)) continue;
      const result = visit(object[key], key, depth + 1);
      if (result) return result;
    }
    for (const [key, nested] of Object.entries(object)) {
      if (keys.includes(key)) continue;
      const result = visit(nested, key, depth + 1);
      if (result) return result;
    }
    return null;
  };
  return visit(event, "event", 0);
}

export function createVisualVerdictRow(artifactId: string): ActionRowBuilder<ButtonBuilder> {
  const safeId = artifactId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 60);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`visual:approve:${safeId}`)
      .setLabel("✅ Approve UI")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`visual:reject:${safeId}`)
      .setLabel("❌ Reject UI")
      .setStyle(ButtonStyle.Danger),
  );
}

export function parseVisualVerdictCustomId(customId: string): { verdict: "approve" | "reject"; artifactId: string } | null {
  const match = customId.match(/^visual:(approve|reject):(.+)$/);
  if (!match) return null;
  return { verdict: match[1] as "approve" | "reject", artifactId: match[2] };
}

export function createVisualVerdictResponse(
  artifactId: string,
  verdict: "approved" | "rejected",
  feedback?: string,
): Record<string, unknown> {
  return {
    type: "visual_verdict",
    artifactId,
    verdict,
    ...(feedback ? { feedback } : {}),
  };
}

export function createVisualVerdictEmbed(artifact: VisualArtifact): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("🖼️ Visual QA Verdict")
    .setDescription(`Review **${artifact.name}** and choose a verdict below.`)
    .setColor(0x5865f2)
    .setFooter({ text: `Artifact ${artifact.id}` });
}
