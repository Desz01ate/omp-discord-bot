import { existsSync } from "fs";
import type { SessionStore } from "./types";
import { SqliteSessionStore, type SqliteSessionStoreOptions } from "./sqlite";
import { InMemorySessionStore } from "./memory";

export * from "./types";
export * from "./sqlite";
export * from "./memory";

export interface SessionStoreFactoryOptions extends SqliteSessionStoreOptions {
  /** Storage provider type: 'sqlite' | 'memory' */
  type?: "sqlite" | "memory" | string;
}

/**
 * Creates and returns a SessionStore instance based on the specified type or environment configuration.
 */
export function createSessionStore(options: SessionStoreFactoryOptions = {}): SessionStore {
  const storeType = options.type || process.env.SESSION_STORAGE_TYPE || "sqlite";

  switch (storeType.toLowerCase()) {
    case "memory":
    case "in-memory":
      return new InMemorySessionStore();
    case "sqlite":
    default:
      return new SqliteSessionStore({
        dbPath: options.dbPath || process.env.SQLITE_DB_PATH || (existsSync("sessions.sqlite") ? "sessions.sqlite" : "data/sessions.sqlite"),
        db: options.db,
      });
  }
}
