import { Database, type Statement } from "bun:sqlite";
import { dirname } from "path";
import { mkdirSync } from "fs";
import type { SessionBinding, SessionStore } from "./types";

export interface SqliteSessionStoreOptions {
  /** Path to the SQLite database file or ':memory:' for in-memory DB */
  dbPath?: string;
  /** Pre-existing Database instance (optional, useful for testing) */
  db?: Database;
}

interface RawSqliteRow {
  thread_id: string;
  cwd: string;
  initial_model: string | null;
  session_id: string | null;
  session_file: string | null;
  created_at: number;
  updated_at: number;
  metadata: string | null;
}

export class SqliteSessionStore implements SessionStore {
  private db: Database | null = null;
  private readonly dbPath: string;
  private readonly externalDb?: Database;
  private isInitialized = false;

  private getStmt: Statement<RawSqliteRow, [string]> | null = null;
  private setStmt: Statement<
    void,
    [string, string, string | null, string | null, string | null, number, number, string | null]
  > | null = null;
  private deleteStmt: Statement<void, [string]> | null = null;
  private listStmt: Statement<RawSqliteRow, []> | null = null;
  private clearStmt: Statement<void, []> | null = null;

  constructor(options: SqliteSessionStoreOptions = {}) {
    this.dbPath = options.dbPath || process.env.SQLITE_DB_PATH || "sessions.sqlite";
    this.externalDb = options.db;
  }

  public async init(): Promise<void> {
    if (this.isInitialized && this.db) {
      return;
    }

    if (this.externalDb) {
      this.db = this.externalDb;
    } else {
      if (this.dbPath !== ":memory:") {
        const dir = dirname(this.dbPath);
        if (dir && dir !== ".") {
          mkdirSync(dir, { recursive: true });
        }
      }
      this.db = new Database(this.dbPath);
    }

    // Set performance and durability pragmas
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");

    // Create session_bindings table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_bindings (
        thread_id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        initial_model TEXT,
        session_id TEXT,
        session_file TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT
      );
    `);

    // Safe column migrations for existing databases
    try {
      this.db.exec("ALTER TABLE session_bindings ADD COLUMN session_id TEXT;");
    } catch {}
    try {
      this.db.exec("ALTER TABLE session_bindings ADD COLUMN session_file TEXT;");
    } catch {}

    // Prepare statements
    this.getStmt = this.db.prepare<RawSqliteRow, [string]>(
      "SELECT thread_id, cwd, initial_model, session_id, session_file, created_at, updated_at, metadata FROM session_bindings WHERE thread_id = ?;"
    );

    this.setStmt = this.db.prepare<
      void,
      [string, string, string | null, string | null, string | null, number, number, string | null]
    >(`
      INSERT INTO session_bindings (thread_id, cwd, initial_model, session_id, session_file, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        cwd = excluded.cwd,
        initial_model = excluded.initial_model,
        session_id = COALESCE(excluded.session_id, session_bindings.session_id),
        session_file = COALESCE(excluded.session_file, session_bindings.session_file),
        updated_at = excluded.updated_at,
        metadata = excluded.metadata;
    `);

    this.deleteStmt = this.db.prepare<void, [string]>(
      "DELETE FROM session_bindings WHERE thread_id = ?;"
    );

    this.listStmt = this.db.prepare<RawSqliteRow, []>(
      "SELECT thread_id, cwd, initial_model, session_id, session_file, created_at, updated_at, metadata FROM session_bindings ORDER BY created_at ASC;"
    );

    this.clearStmt = this.db.prepare<void, []>(
      "DELETE FROM session_bindings;"
    );

    this.isInitialized = true;
  }

  private ensureInitialized(): void {
    if (!this.isInitialized || !this.db) {
      throw new Error("SqliteSessionStore is not initialized. Call init() first.");
    }
  }

  public async get(threadId: string): Promise<SessionBinding | null> {
    this.ensureInitialized();
    const row = this.getStmt!.get(threadId);
    if (!row) {
      return null;
    }
    return this.mapRowToBinding(row);
  }

  public async set(binding: SessionBinding): Promise<void> {
    this.ensureInitialized();
    const now = Date.now();
    const createdAt = binding.createdAt || now;
    const updatedAt = binding.updatedAt || now;
    const metadataStr = binding.metadata ? JSON.stringify(binding.metadata) : null;

    this.setStmt!.run(
      binding.threadId,
      binding.cwd,
      binding.initialModel ?? null,
      binding.sessionId ?? null,
      binding.sessionFile ?? null,
      createdAt,
      updatedAt,
      metadataStr
    );
  }

  public async delete(threadId: string): Promise<boolean> {
    this.ensureInitialized();
    if (!this.db) {
      return false;
    }
    const result = this.db.run("DELETE FROM session_bindings WHERE thread_id = ?;", [threadId]);
    return result.changes > 0;
  }

  public async list(): Promise<SessionBinding[]> {
    this.ensureInitialized();
    const rows = this.listStmt!.all();
    return rows.map((r) => this.mapRowToBinding(r));
  }

  public async clear(): Promise<void> {
    this.ensureInitialized();
    this.clearStmt!.run();
  }

  public async close(): Promise<void> {
    if (this.db) {
      this.getStmt = null;
      this.setStmt = null;
      this.deleteStmt = null;
      this.listStmt = null;
      this.clearStmt = null;
      if (!this.externalDb) {
        this.db.close();
      }
      this.db = null;
      this.isInitialized = false;
    }
  }

  private mapRowToBinding(row: RawSqliteRow): SessionBinding {
    let metadata: Record<string, unknown> | undefined;
    if (row.metadata) {
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        metadata = undefined;
      }
    }

    return {
      threadId: row.thread_id,
      cwd: row.cwd,
      initialModel: row.initial_model ?? undefined,
      sessionId: row.session_id ?? undefined,
      sessionFile: row.session_file ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(metadata ? { metadata } : {}),
    };
  }
}
