import { describe, expect, it } from "bun:test";
import {
  buildDynamicThreadName,
  buildQuickActionRow,
  extractPromptTopic,
  isDefaultThreadName,
  parseQuickActionId,
  parseReactionShortcut,
  updateThreadStatusName,
} from "./ui-helpers";

describe("interactive UI helpers", () => {
  it("builds and parses thread-scoped quick action IDs", () => {
    const row = buildQuickActionRow("thread-123");
    const buttons = row.components.map((component) => component.toJSON());
    expect(buttons.map((button) => ("custom_id" in button ? button.custom_id : undefined))).toEqual([
      "action_undo_thread-123",
      "action_compact_thread-123",
      "action_abort_thread-123",
      "action_status_thread-123",
    ]);
    expect(parseQuickActionId("action_compact_thread-123")).toEqual({
      action: "compact",
      threadId: "thread-123",
    });
    expect(parseQuickActionId("action_unknown_thread-123")).toBeNull();
    expect(parseQuickActionId("action_undo_")).toBeNull();
  });

  it("maps Unicode and named reaction values to shortcuts", () => {
    expect(parseReactionShortcut("🛑")).toBe("abort");
    expect(parseReactionShortcut("x")).toBe("abort");
    expect(parseReactionShortcut("❌")).toBe("abort");
    expect(parseReactionShortcut("🔄")).toBe("undo");
    expect(parseReactionShortcut("arrows_counterclockwise")).toBe("undo");
    expect(parseReactionShortcut("👍")).toBeNull();
    expect(parseReactionShortcut(null)).toBeNull();
  });

  it("extracts skill labels and readable topics", () => {
    expect(extractPromptTopic("$ralph Fix auth bug")).toEqual({
      skill: "ralph",
      topic: "Fix auth bug",
    });
    expect(extractPromptTopic("/skill plan Design the migration")).toEqual({
      skill: "plan",
      topic: "Design the migration",
    });
    expect(extractPromptTopic("  Fix   auth\n bug ")).toEqual({ topic: "Fix auth bug" });
  });

  it("renames only generated defaults and bounds names to Discord's limit", () => {
    expect(isDefaultThreadName("omp-session-a1b2")).toBe(true);
    expect(isDefaultThreadName("🟢 Fix auth bug")).toBe(false);
    expect(buildDynamicThreadName("$ralph Fix auth bug", "omp-session-a1b2")).toBe("🟡 [ralph] Fix auth bug");
    expect(buildDynamicThreadName("Fix auth bug", "custom topic")).toBe("custom topic");

    const longName = updateThreadStatusName("omp-session-a1b2", "error");
    expect(longName.startsWith("🔴 ")).toBe(true);
    expect(longName.length).toBeLessThanOrEqual(100);
    expect(updateThreadStatusName("🟡 [ralph] Fix auth bug", "idle")).toBe("🟢 [ralph] Fix auth bug");
  });
});
