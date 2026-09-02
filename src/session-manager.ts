import type { Client, ThreadChannel, Message } from "discord.js";
import { existsSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Subprocess } from "bun";
import type { SessionStore, SessionBinding } from "./storage";
import { createSessionStore } from "./storage";
import type { ToolExecutionTrace, VisualArtifact } from "./observability";

export type OmpProcess = Subprocess<"pipe", "pipe", "inherit">;

export interface SessionContext {
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
  /** Pinned live dashboard message and its throttled update state. */
  hudMessage?: Message;
  hudUpdateTimer?: Timer;
  hudInitPromise?: Promise<void>;
  hudLastEditTimestamp?: number;
  hudState?: Record<string, unknown>;
  /** Active tool traces keyed by the RPC execution/call id. */
  toolTraces?: Map<string, ToolExecutionTrace & {
    message?: Message;
    lastEditTimestamp: number;
    editTimer?: Timer;
  }>;

  /** Visual artifacts awaiting an interactive verdict. */
  visualArtifacts?: Map<string, { artifact: VisualArtifact; messageId?: string }>;
}
export interface SessionManagerOptions {
  store?: SessionStore;
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
    console.error(`Failed to clean primary attachment directory for thread ${threadId}:`, err);
  }

  try {
    const fallbackThreadDir = join(tmpdir(), "omp-discord-attachments", threadId);
    if (existsSync(fallbackThreadDir)) {
      rmSync(fallbackThreadDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`Failed to clean fallback attachment directory for thread ${threadId}:`, err);
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
    if (this.isInitialized) return;
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
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    this.activeSessions.set(session.threadId, session);
    const binding: SessionBinding = {
      threadId: session.threadId,
      cwd: session.cwd,
      initialModel: options.initialModel,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: options.metadata,
    };
    await this.store.set(binding);
  }

  /**
   * Removes session from in-memory tracking and storage without killing process or deleting Discord thread.
   */
  public async remove(threadId: string): Promise<void> {
    this.activeSessions.delete(threadId);
    await this.store.delete(threadId).catch((err) => {
      console.error(`Failed to delete session binding for thread ${threadId} from store:`, err);
    });
  }

  /**
   * Full session termination: stops typing/timers, kills subprocess, cleans attachments, removes from memory and store,
   * and optionally deletes Discord thread channel.
   */
  public async terminate(
    sessionOrThreadId: SessionContext | string,
    client?: Client,
    deleteThread = true,
  ): Promise<void> {
    const threadId = typeof sessionOrThreadId === "string" ? sessionOrThreadId : sessionOrThreadId.threadId;
    const session = typeof sessionOrThreadId === "string" ? this.activeSessions.get(threadId) : sessionOrThreadId;

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
      for (const trace of session.toolTraces?.values() || []) clearTimeout(trace.editTimer);
      session.toolTraces?.clear();
      session.visualArtifacts?.clear();
      try {
        session.process.kill();
      } catch (err) {
        console.error(`Error terminating OMP process for thread ${session.threadId}:`, err);
      }
      cleanThreadAttachments(session.cwd, session.threadId);
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
        console.error(`Error deleting thread ${threadId}:`, err);
      }
    }

    this.activeSessions.delete(threadId);
    await this.store.delete(threadId).catch((err) => {
      console.error(`Failed to delete session binding for thread ${threadId} from store:`, err);
    });
  }

  /**
   * Terminates all active sessions concurrently.
   */
  public async terminateAll(client?: Client, deleteThreads = true): Promise<number> {
    const active = this.getActiveSessions();
    const count = active.length;
    if (count === 0) return 0;
    await Promise.allSettled(active.map((s) => this.terminate(s, client, deleteThreads)));
    return count;
  }

  /**
   * Restores active OMP RPC instances from persistent store upon bot startup/reconnect.
   */
  public async restoreAll(
    client: Client,
    spawnSession: (thread: ThreadChannel, cwd: string, initialModel?: string) => SessionContext,
  ): Promise<number> {
    const bindings = await this.store.list();
    if (bindings.length === 0) {
      console.log("📦 No persisted sessions found to restore.");
      return 0;
    }

    console.log(`📦 Found ${bindings.length} persisted session(s). Restoring bindings...`);
    let restoredCount = 0;

    for (const binding of bindings) {
      try {
        if (!existsSync(binding.cwd)) {
          console.warn(`⚠️ Working directory for thread ${binding.threadId} no longer exists (${binding.cwd}). Cleaning up.`);
          await this.store.delete(binding.threadId);
          continue;
        }

        const channel =
          client.channels.cache.get(binding.threadId) ??
          (await client.channels.fetch(binding.threadId).catch(() => null));

        if (!channel || !channel.isThread()) {
          console.warn(`⚠️ Discord thread ${binding.threadId} is no longer accessible. Cleaning up.`);
          await this.store.delete(binding.threadId);
          continue;
        }

        if (channel.archived || channel.locked) {
          console.log(`ℹ️ Discord thread ${binding.threadId} is archived/locked. Skipping RPC spawn.`);
          continue;
        }

        if (this.activeSessions.has(binding.threadId)) {
          continue;
        }

        const session = spawnSession(channel, binding.cwd, binding.initialModel);
        this.activeSessions.set(channel.id, session);
        restoredCount++;
        console.log(`✅ Restored active OMP session for thread ${channel.id} ("${channel.name}") in ${binding.cwd}`);
      } catch (err) {
        console.error(`Failed to restore session for thread ${binding.threadId}:`, err);
      }
    }

    console.log(`🚀 Session restoration complete: ${restoredCount}/${bindings.length} active session(s) bound.`);
    return restoredCount;
  }

  public async close(): Promise<void> {
    this.activeSessions.clear();
    await this.store.close?.();
    this.isInitialized = false;
  }
}
