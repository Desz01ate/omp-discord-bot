import type { ThreadChannel } from "discord.js";
import { basename } from "path";
import { readFileSync } from "fs";
import { recordAssistantMessage } from "./rewind";
import {
  isDownloadableWorkspaceFile,
  MAX_WORKSPACE_DOWNLOAD_BYTES,
  resolveWorkspaceFile,
} from "./workspace";
import type { SessionContext } from "./session-manager";

export const UPLOAD_ARTIFACT_TOOL_DEFINITION = {
  name: "upload_artifact",
  label: "Upload artifact to Discord",
  description: "Upload one file from the current workspace to the active Discord thread. Use this when the user asks to receive a generated file.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative path of the file to upload",
      },
      description: {
        type: "string",
        description: "Optional short caption shown with the Discord attachment",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
} as const;

type SendRpc = (session: SessionContext, command: Record<string, unknown>) => void;

function sanitizeAttachmentFilename(relativePath: string): string {
  const base = basename(relativePath);
  return base.replace(/[^a-zA-Z0-9._-]/g, "_") || "artifact";
}

export function sendHostToolResult(
  session: SessionContext,
  id: string,
  text: string,
  details: Record<string, unknown> = {},
  isError = false,
  sendRpc: SendRpc,
): void {
  try {
    sendRpc(session, {
      type: "host_tool_result",
      id,
      result: {
        content: [{ type: "text", text }],
        details,
      },
      isError,
    });
  } catch (err) {
    console.error(`[RPC:${ session.threadId }] Failed to send host tool result:`, err);
  }
}

export async function handleUploadArtifactCall(
  session: SessionContext,
  thread: ThreadChannel,
  request: { id: string; toolCallId: string; toolName: string; arguments?: Record<string, unknown> },
  sendRpc: SendRpc,
): Promise<void> {
  const { id } = request;
  session.pendingHostToolCalls ||= new Map();
  if (session.pendingHostToolCalls.has(id)) {
    return;
  }

  const abortController = new AbortController();
  let settled = false;

  const settle = (text: string, details: Record<string, unknown> = {}, isError = false) => {
    if (settled) {
      return;
    }
    settled = true;
    session.pendingHostToolCalls?.delete(id);
    sendHostToolResult(session, id, text, details, isError, sendRpc);
  };

  session.pendingHostToolCalls.set(id, {
    id,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    resolve: () => {},
    reject: (error) => {
      settle(error instanceof Error && error.message ? error.message : "Host tool call was rejected", {}, true);
    },
    abortController,
  });

  if (abortController.signal.aborted) {
    settle("Host tool call was cancelled", {}, true);
    return;
  }

  const args = request.arguments && typeof request.arguments === "object" ? request.arguments : {};
  const requestedPath = typeof args.path === "string" ? args.path : "";
  const caption = typeof args.description === "string" ? args.description.trim() : "";

  if (!requestedPath.trim()) {
    settle("A workspace-relative file path is required.", {}, true);
    return;
  }

  const resolved = resolveWorkspaceFile(session.cwd, requestedPath);
  if (!resolved.ok || !resolved.file) {
    settle(resolved.error || "Unable to resolve that file in the workspace.", {}, true);
    return;
  }

  if (!isDownloadableWorkspaceFile(resolved.file)) {
    const mb = Math.ceil(resolved.file.size / (1024 * 1024));
    settle(`File size (${ mb }MB) exceeds Discord's 25MB attachment limit.`, {}, true);
    return;
  }

  if (abortController.signal.aborted) {
    settle("Host tool call was cancelled", {}, true);
    return;
  }

  let contents: Buffer;
  try {
    contents = readFileSync(resolved.file.absolutePath);
  } catch {
    settle("Unable to read the file from the session workspace.", {}, true);
    return;
  }

  if (contents.byteLength > MAX_WORKSPACE_DOWNLOAD_BYTES) {
    settle("The file grew beyond Discord's 25MB attachment limit while it was being read.", {}, true);
    return;
  }

  if (abortController.signal.aborted) {
    settle("Host tool call was cancelled", {}, true);
    return;
  }

  const safeFilename = sanitizeAttachmentFilename(resolved.file.relativePath);

  try {
    const sentMsg = await thread.send({
      content: caption || undefined,
      files: [{ attachment: contents, name: safeFilename }],
    });
    recordAssistantMessage(session, sentMsg.id);
    settle(
      `Uploaded ${ safeFilename } (${ contents.byteLength } bytes) to the active Discord thread.`,
      {
        path: resolved.file.relativePath,
        filename: safeFilename,
        size: contents.byteLength,
        messageId: sentMsg.id,
      },
      false,
    );
  } catch (err) {
    const discordError = err instanceof Error ? err.message : "Discord upload failed";
    settle(`Failed to upload attachment to Discord: ${ discordError }`, {}, true);
  }
}

export function handleHostToolCancel(session: SessionContext, targetId: string): void {
  const pending = session.pendingHostToolCalls?.get(targetId);
  if (!pending) {
    return;
  }
  pending.abortController.abort(new Error("Host tool cancelled by OMP"));
  pending.reject(new Error("Host tool call was cancelled"));
}

