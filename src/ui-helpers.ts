
export type ThreadStatus = "running" | "idle" | "error" | "pending";

const STATUS_EMOJI: Record<ThreadStatus, string> = {
  running: "🟡",
  idle: "🟢",
  error: "🔴",
  pending: "⏸️",
};

const STATUS_PREFIX = /^(?:🟡|🟢|🔴|⏸️)\s*/u;

export function getThreadStatusEmoji(status: ThreadStatus): string {
  return STATUS_EMOJI[status];
}

/** Return true for names that have not yet been customized for a prompt. */
export function isDefaultThreadName(name: string): boolean {
  const clean = name.trim().replace(STATUS_PREFIX, "").trim();
  return /^omp-session-[^\s]+$/iu.test(clean);
}

/** Extract a compact, human-readable topic and optional OMX skill label from a prompt. */
export function extractPromptTopic(prompt: string): { topic: string; skill?: string } {
  const normalized = prompt.replace(/\s+/gu, " ").trim();
  const skillMatch = /^\$(\w[\w-]*)\s*(.*)$/u.exec(normalized);
  if (skillMatch) {
    return {
      skill: skillMatch[1],
      topic: (skillMatch[2] || "session").trim(),
    };
  }

  const slashSkillMatch = /^\/skill\s+(\w[\w-]*)\s*(.*)$/iu.exec(normalized);
  if (slashSkillMatch) {
    return {
      skill: slashSkillMatch[1],
      topic: (slashSkillMatch[2] || "session").trim(),
    };
  }

  return { topic: normalized || "session" };
}

/**
 * Build a prompt-derived name only while the thread still has its generated default name.
 * Discord thread names are capped at 100 characters.
 */
export function buildDynamicThreadName(prompt: string, currentName: string, status: ThreadStatus = "running"): string {
  if (!isDefaultThreadName(currentName)) {
    return currentName;
  }
  const { topic, skill } = extractPromptTopic(prompt);
  const label = skill ? `[${ skill }] ` : "";
  const prefix = getThreadStatusEmoji(status);
  const combined = `${ prefix } ${ label }${ topic }`.trim();
  return combined.length <= 100 ? combined : `${ combined.slice(0, 97) }...`;
}

/** Replace a prior status prefix while preserving the user's thread topic. */
export function updateThreadStatusName(currentName: string, status: ThreadStatus): string {
  const topic = currentName.trim().replace(STATUS_PREFIX, "").trim() || "OMP session";
  return `${ getThreadStatusEmoji(status) } ${ topic }`.slice(0, 100);
}
