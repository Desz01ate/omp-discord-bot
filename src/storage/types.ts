export interface SessionBinding {
  /** Discord Thread Channel ID (Primary Key) */
  threadId: string;
  /** Working directory of the session */
  cwd: string;
  /** Initial or selected model identifier */
  initialModel?: string;
  /** Underlying OMP session identifier */
  sessionId?: string;
  /** Underlying OMP session file path (.jsonl) */
  sessionFile?: string;
  /** Timestamp (epoch ms) when the session binding was created */
  createdAt: number;
  /** Timestamp (epoch ms) when the session binding was last updated */
  updatedAt?: number;
  /** Optional arbitrary metadata (e.g. guildId, parentChannelId, createdBy, etc.) */
  metadata?: Record<string, unknown>;
}

export interface SessionStore {
  /** Initialize the storage backend (e.g. create tables, connections) */
  init(): Promise<void>;

  /** Retrieve a session binding by threadId, or null if not found */
  get(threadId: string): Promise<SessionBinding | null>;

  /** Persist or update a session binding */
  set(binding: SessionBinding): Promise<void>;

  /** Delete a session binding by threadId. Returns true if removed, false if not found */
  delete(threadId: string): Promise<boolean>;

  /** List all active persisted session bindings */
  list(): Promise<SessionBinding[]>;

  /** Remove all persisted session bindings */
  clear(): Promise<void>;

  /** Gracefully close storage backend resources */
  close?(): Promise<void> | void;
}
