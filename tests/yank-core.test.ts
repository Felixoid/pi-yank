import { describe, expect, it, vi } from "vitest";
import {
  extractAssistantText,
  handleExtendedCopy,
  parseCopyArgs,
  type NotifyLevel,
  type SessionEntry,
} from "../extensions/yank-core.js";

describe("parseCopyArgs", () => {
  it("parses index and plain flag", () => {
    expect(parseCopyArgs("")).toEqual({ index: 1, plain: false });
    expect(parseCopyArgs("2")).toEqual({ index: 2, plain: false });
    expect(parseCopyArgs("--plain")).toEqual({ index: 1, plain: true });
    expect(parseCopyArgs("2 --plain")).toEqual({ index: 2, plain: true });
    expect(parseCopyArgs("--plain 3")).toEqual({ index: 3, plain: true });
    expect(parseCopyArgs("0 --plain")).toEqual({ index: 1, plain: true });
  });
});

describe("extractAssistantText", () => {
  it("extracts from string and text blocks", () => {
    expect(extractAssistantText("hello")).toBe("hello");
    expect(
      extractAssistantText([
        { type: "thinking", text: "ignore" },
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
  });

  it("returns empty when no text", () => {
    expect(extractAssistantText(undefined)).toBe("");
    expect(extractAssistantText([{ type: "toolCall" }])).toBe("");
  });

  it("accepts resumed-like blocks where type is missing", () => {
    expect(extractAssistantText([{ text: "hello" }, { type: "text", text: "world" }])).toBe(
      "hello\nworld",
    );
  });
});

describe("handleExtendedCopy", () => {
  const mkBranch = (): SessionEntry[] => [
    { type: "message", message: { role: "user", content: "u1" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "# title\n\n| a | b |\n| - | - |\n| 1 | 2 |" }],
      },
    },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "second" }] } },
  ];

  it("copies raw markdown for default mode", async () => {
    const copied: string[] = [];
    const notices: Array<{ message: string; level?: NotifyLevel }> = [];

    await handleExtendedCopy("2", mkBranch(), mkBranch(), {
      renderMarkdownToText: (md) => `RENDERED:${md}`,
      copyToClipboard: async (text) => {
        copied.push(text);
      },
      notify: (message, level) => notices.push({ message, level }),
    });

    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain("| a | b |");
    expect(notices[0]?.level).toBe("info");
  });

  it("copies rendered text in --plain mode", async () => {
    const copied: string[] = [];

    await handleExtendedCopy("2 --plain", mkBranch(), mkBranch(), {
      renderMarkdownToText: vi.fn((md: string) => `RENDERED:${md}`),
      copyToClipboard: async (text) => {
        copied.push(text);
      },
      notify: vi.fn(),
    });

    expect(copied[0].startsWith("RENDERED:")).toBe(true);
  });

  it("warns when index is out of range", async () => {
    const notify = vi.fn();

    await handleExtendedCopy("99", mkBranch(), mkBranch(), {
      renderMarkdownToText: vi.fn(),
      copyToClipboard: vi.fn(async () => undefined),
      notify,
    });

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("only 2 assistant"), "warning");
  });

  it("reports clipboard failures", async () => {
    const notify = vi.fn();

    await handleExtendedCopy("1", mkBranch(), mkBranch(), {
      renderMarkdownToText: (md) => md,
      copyToClipboard: async () => {
        throw new Error("boom");
      },
      notify,
    });

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Clipboard copy failed"), "error");
  });

  it("falls back to all entries when branch has no assistant text (resume case)", async () => {
    const copied: string[] = [];
    const branchOnlyToolCalls: SessionEntry[] = [
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall" }] } },
    ];
    const allEntries: SessionEntry[] = [
      ...branchOnlyToolCalls,
      { type: "message", message: { role: "assistant", content: [{ text: "from entries" }] } },
    ];

    await handleExtendedCopy("1", branchOnlyToolCalls, allEntries, {
      renderMarkdownToText: (md) => md,
      copyToClipboard: async (text) => {
        copied.push(text);
      },
      notify: vi.fn(),
    });

    expect(copied[0]).toBe("from entries");
  });
});
