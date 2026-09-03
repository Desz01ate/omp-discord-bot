import type { Client, ThreadChannel, Message } from "discord.js";
import { existsSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import type { Subprocess } from "bun";
import type { SessionStore, SessionBinding } from "./storage";
import { createSessionStore } from "./storage";
import { removeGitWorktree, type WorktreeInfo } from "./workspace";
import type { ToolExecutionTrace } from "./observability";
import type { TurnCheckpoint, PendingRpcRequest } from "./rewind";
export type OmpProcess = Subprocess<"pipe", "pipe", "inherit">;

export interface SessionContext {
  process: OmpProcess;
  threadId: string;
  cwd: string;
  sessionId?: string;
  sessionFile?: string;
  worktree?: WorktreeInfo;
  activePromptMsg?: Message;
  currentStreamBuffer: string;
  lastEditTimestamp: number;
  activeToolStatus?: string;
  editTimer?: Timer;
  typingTimer?: Timer;
  initialStatePromise?: Promise<Record<string, unknown>>;
  resolveInitialState?: (state: Record<string, unknown>) => void;
  /** True after agent_start and cleared when the turn completes. */
  isRunning?: boolean;
  /** Last user prompt, used for thread naming and UI context. */
  lastPrompt?: string;
  /** True while an extension confirmation is waiting for a Discord response. */
  confirmationPending?: boolean;
  /** Prevents a trailing prompt_result from duplicating the agent_end action bar. */
  completionBarAttached?: boolean;
  /** Pinned live dashboard message and its throttled update state. */
  hudMessage?: Message;
  hudUpdateTimer?: Timer;
  hudInitPromise?: Promise<void>;
  hudLastEditTimestamp?: number;
  hudState?: Record<string, unknown>;
  toolTraceHistory?: ToolExecutionTrace[];
  /** Active tool traces keyed by the RPC execution/call id. */
  toolTraces?: Map<string, ToolExecutionTrace>;
  /** Checkpoints tracking user turns and associated assistant messages for rewind. */
  checkpoints?: TurnCheckpoint[];
  /** True when an edit-as-a-rewind operation is actively processing. */
  isRewinding?: boolean;
  /** Active pending RPC requests awaiting response frames. */
  pendingRpcRequests?: Map<string, PendingRpcRequest>;
  /** Cumulative token metrics across prompts/turns in this session. */
  cumulativeTokens?: { input: number; output: number };
  /** Live subagents currently registered or executing in OMP. */
  activeSubagentsMap?: Map<string, { id: string; agent: string; description?: string }>;
}
export interface SessionManagerOptions {
  store?: SessionStore;
}

export function resolveOmpSessionPath(sessionFile?: string, sessionId?: string): string | undefined {
  if (sessionFile && existsSync(sessionFile)) {
    return sessionFile;
  }
  if (sessionId) {
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
    const sessionsRoot = join(agentDir, "sessions");
    if (existsSync(sessionsRoot)) {
      try {
        const subdirs = readdirSync(sessionsRoot);
        for (const subdir of subdirs) {
          const fullSubdir = join(sessionsRoot, subdir);
          try {
            const files = readdirSync(fullSubdir);
            for (const file of files) {
              if (file.endsWith(".jsonl") && file.includes(sessionId)) {
                return join(fullSubdir, file);
              }
            }
          } catch {}
        }
      } catch {}
    }
  }
  return undefined;
}

export function cleanOmpSessionFiles(sessionFile?: string, sessionId?: string): void {
  try {
    if (sessionFile && existsSync(sessionFile)) {
      rmSync(sessionFile, { force: true });
      const dirPath = sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -6) : "";
      if (dirPath && existsSync(dirPath)) {
        rmSync(dirPath, { recursive: true, force: true });
      }
    }
    if (sessionId) {
      const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
      const sessionsRoot = join(agentDir, "sessions");
      if (existsSync(sessionsRoot)) {
        const subdirs = readdirSync(sessionsRoot);
        for (const subdir of subdirs) {
          const fullSubdir = join(sessionsRoot, subdir);
          try {
            const files = readdirSync(fullSubdir);
            for (const file of files) {
              if (file.includes(sessionId)) {
                const targetPath = join(fullSubdir, file);
                rmSync(targetPath, { recursive: true, force: true });
              }
            }
          } catch {}
        }
      }
    }
  } catch (err) {
    console.error("Error cleaning OMP session files:", err);
  }
}

export function cleanThreadAttachments(cwd: string, threadId: string): void {
  try {
    const primaryThreadDir = join(cwd, ".discord-attachments", threadId);
    if (existsSync(primaryThreadDir)) {
      rmSync(primaryThreadDir, { recursive: true, force: true });
    }
    const primaryBaseDir = join(cwd, ".discord-attachments");
    if (existsSync(primaryBaseDir) && readdirSync(primaryBaseDir).length === 0) {
      rmSync(primaryBaseDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`Failed to clean primary attachment directory for thread ${ threadId }:`, err);
  }

  try {
    const fallbackThreadDir = join(tmpdir(), "omp-discord-attachments", threadId);
    if (existsSync(fallbackThreadDir)) {
      rmSync(fallbackThreadDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`Failed to clean fallback attachment directory for thread ${ threadId }:`, err);
  }
}
/**
 * Stop typing indicator in Discord thread.
 */
export function stopTyping(session: SessionContext): void {
  if (session.typingTimer) {
    clearInterval(session.typingTimer);
    session.typingTimer = undefined;
  }
}

/**
 * Unified Composite Session Manager.
 * Orchestrates the active in-memory subprocess table and persistent cold storage.
 */
export class SessionManager {
  private readonly store: SessionStore;
  private readonly activeSessions = new Map<string, SessionContext>();
  private isInitialized = false;

  constructor(options: SessionManagerOptions = {}) {
    this.store = options.store || createSessionStore();
  }

  public async init(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    await this.store.init();
    this.isInitialized = true;
  }

  public get(threadId: string): SessionContext | undefined {
    return this.activeSessions.get(threadId);
  }

  public has(threadId: string): boolean {
    return this.activeSessions.has(threadId);
  }

  public getActiveSessions(): SessionContext[] {
    return Array.from(this.activeSessions.values());
  }

  public get count(): number {
    return this.activeSessions.size;
  }

  /**
   * Registers a newly spawned session context in memory and persists its binding to the storage layer.
   */
  public async register(
    session: SessionContext,
    options: {
      initialModel?: string;
      sessionId?: string;
      sessionFile?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    this.activeSessions.set(session.threadId, session);
    const binding: SessionBinding = {
      threadId: session.threadId,
      cwd: session.cwd,
      initialModel: options.initialModel,
      sessionId: options.sessionId ?? session.sessionId,
      sessionFile: options.sessionFile ?? session.sessionFile,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        ...options.metadata,
        ...(session.worktree ? { worktree: session.worktree } : {}),
      },
    };
    await this.store.set(binding);
  }

  /**
   * Updates mutable fields on an active session and persists changes to storage.
   */
  public async update(
    threadId: string,
    updates: Partial<Omit<SessionBinding, "threadId" | "createdAt">>,
  ): Promise<void> {
    const session = this.activeSessions.get(threadId);
    if (session) {
      if (updates.sessionId !== undefined) {
        session.sessionId = updates.sessionId;
      }
      if (updates.sessionFile !== undefined) {
        session.sessionFile = updates.sessionFile;
      }
    }
    const existing = await this.store.get(threadId);
    if (existing) {
      const updated: SessionBinding = {
        ...existing,
        ...updates,
        updatedAt: Date.now(),
        metadata: {
          ...existing.metadata,
          ...updates.metadata,
        },
      };
      await this.store.set(updated);
    }
  }

  /**
   * Removes session from in-memory tracking and storage without killing process or deleting Discord thread.
   */
  public async remove(threadId: string): Promise<void> {
    this.activeSessions.delete(threadId);
    await this.store.delete(threadId).catch((err) => {
      console.error(`Failed to delete session binding for thread ${ threadId } from store:`, err);
    });
  }

  /**
   * Full session termination: stops typing/timers, kills subprocess, cleans attachments, removes from memory and store,
   * removes a bot-created Git worktree, and optionally deletes Discord thread channel.
   */
  public async terminate(
    sessionOrThreadId: SessionContext | string,
    client?: Client,
    deleteThread = true,
  ): Promise<void> {
    const threadId = typeof sessionOrThreadId === "string" ? sessionOrThreadId : sessionOrThreadId.threadId;
    const session = typeof sessionOrThreadId === "string" ? this.activeSessions.get(threadId) : sessionOrThreadId;
    const binding = await this.store.get(threadId).catch(() => null);

    const sessionFile = session?.sessionFile || binding?.sessionFile;
    const sessionId = session?.sessionId || binding?.sessionId;

    if (session) {
      stopTyping(session);
      if (session.editTimer) {
        clearTimeout(session.editTimer);
        session.editTimer = undefined;
      }
      if (session.hudUpdateTimer) {
        clearTimeout(session.hudUpdateTimer);
        session.hudUpdateTimer = undefined;
      }
      session.toolTraces?.clear();
      session.toolTraceHistory = [];
      if (session.pendingRpcRequests) {
        for (const [, req] of session.pendingRpcRequests) {
          clearTimeout(req.timer);
          req.reject(new Error("Session terminated"));
        }
        session.pendingRpcRequests.clear();
      }
      session.checkpoints = [];
      try {
        session.process.kill();
      } catch (err) {
        console.error(`Error terminating OMP process for thread ${ session.threadId }:`, err);
      }
      cleanThreadAttachments(session.cwd, session.threadId);
      if (session.worktree) {
        await removeGitWorktree(session.worktree);
      }
    }

    if (sessionFile || sessionId) {
      cleanOmpSessionFiles(sessionFile, sessionId);
    }

    if (deleteThread && client) {
      try {
        const channel =
          client.channels.cache.get(threadId) ??
          (await client.channels.fetch(threadId).catch(() => null));
        if (channel && channel.isThread()) {
          await channel.delete("Terminated via session manager");
        }
      } catch (err) {
        console.error(`Error deleting thread ${ threadId }:`, err);
      }
    }

    this.activeSessions.delete(threadId);
    await this.store.delete(threadId).catch((err) => {
      console.error(`Failed to delete session binding for thread ${ threadId } from store:`, err);
    });
  }

  /**
   * Terminates all active sessions concurrently.
   */
  public async terminateAll(client?: Client, deleteThreads = true): Promise<number> {
    const active = this.getActiveSessions();
    const count = active.length;
    if (count === 0) {
      return 0;
    }
    await Promise.allSettled(active.map((s) => this.terminate(s, client, deleteThreads)));
    return count;
  }

  /**
   * Restores active OMP RPC instances from persistent store upon bot startup/reconnect.
   */
  public async restoreAll(
    client: Client,
    spawnSession: (
      thread: ThreadChannel,
      cwd: string,
      initialModel?: string,
      metadata?: Record<string, unknown>,
      sessionId?: string,
      sessionFile?: string,
    ) => SessionContext,
  ): Promise<number> {
    const bindings = await this.store.list();
    if (bindings.length === 0) {
      console.log("📦 No persisted sessions found to restore.");
      return 0;
    }

    console.log(`📦 Found ${ bindings.length } persisted session(s). Restoring bindings...`);
    let restoredCount = 0;

    for (const binding of bindings) {
      try {
        if (!existsSync(binding.cwd)) {
          console.warn(`⚠️ Working directory for thread ${ binding.threadId } no longer exists (${ binding.cwd }). Cleaning up.`);
          const worktree = binding.metadata?.worktree as WorktreeInfo | undefined;
          if (worktree) {
            await removeGitWorktree(worktree).catch((err) => {
              console.error(`Failed to clean up orphaned worktree for thread ${ binding.threadId }:`, err);
            });
          }
          cleanThreadAttachments(binding.cwd, binding.threadId);
          cleanOmpSessionFiles(binding.sessionFile, binding.sessionId);
          await this.store.delete(binding.threadId);
          continue;
        }

        const channel =
          client.channels.cache.get(binding.threadId) ??
          (await client.channels.fetch(binding.threadId).catch(() => null));

        if (!channel || !channel.isThread()) {
          console.warn(`⚠️ Discord thread ${ binding.threadId } is no longer accessible. Cleaning up.`);
          const worktree = binding.metadata?.worktree as WorktreeInfo | undefined;
          if (worktree) {
            await removeGitWorktree(worktree).catch((err) => {
              console.error(`Failed to clean up orphaned worktree for thread ${ binding.threadId }:`, err);
            });
          }
          cleanThreadAttachments(binding.cwd, binding.threadId);
          cleanOmpSessionFiles(binding.sessionFile, binding.sessionId);
          await this.store.delete(binding.threadId);
          continue;
        }

        if (channel.archived || channel.locked) {
          console.log(`ℹ️ Discord thread ${ binding.threadId } is archived/locked. Skipping RPC spawn.`);
          continue;
        }

        if (this.activeSessions.has(binding.threadId)) {
          continue;
        }

        const session = spawnSession(
          channel,
          binding.cwd,
          binding.initialModel,
          binding.metadata,
          binding.sessionId,
          binding.sessionFile,
        );
        if (binding.sessionId && !session.sessionId) {
          session.sessionId = binding.sessionId;
        }
        if (binding.sessionFile && !session.sessionFile) {
          session.sessionFile = binding.sessionFile;
        }
        this.activeSessions.set(channel.id, session);
        restoredCount++;
        console.log(`✅ Restored active OMP session for thread ${ channel.id } ("${ channel.name }") in ${ binding.cwd }`);
      } catch (err) {
        console.error(`Failed to restore session for thread ${ binding.threadId }:`, err);
      }
    }

    console.log(`🚀 Session restoration complete: ${ restoredCount }/${ bindings.length } active session(s) bound.`);
    return restoredCount;
  }

  public async close(): Promise<void> {
    this.activeSessions.clear();
    await this.store.close?.();
    this.isInitialized = false;
  }
}
