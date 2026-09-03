import { describe, expect, it } from "bun:test";
import {
  buildDynamicThreadName,
  extractPromptTopic,
  isDefaultThreadName,
  updateThreadStatusName,
} from "./ui-helpers";

describe("interactive UI helpers", () => {

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
    expect(isDefaultThreadName("🟢 omp-session-a1b2")).toBe(true);
    expect(isDefaultThreadName("🟡 omp-session-xyz")).toBe(true);
    expect(isDefaultThreadName("🟢 Fix auth bug")).toBe(false);
    expect(buildDynamicThreadName("$ralph Fix auth bug", "omp-session-a1b2")).toBe("🟡 [ralph] Fix auth bug");
    expect(buildDynamicThreadName("$ralph Fix auth bug", "🟢 omp-session-a1b2")).toBe("🟡 [ralph] Fix auth bug");
    expect(buildDynamicThreadName("Fix auth bug", "custom topic")).toBe("custom topic");
    const longName = updateThreadStatusName("omp-session-a1b2", "error");
    expect(longName.startsWith("🔴 ")).toBe(true);
    expect(longName.length).toBeLessThanOrEqual(100);
    expect(updateThreadStatusName("🟡 [ralph] Fix auth bug", "idle")).toBe("🟢 [ralph] Fix auth bug");
  });
});
