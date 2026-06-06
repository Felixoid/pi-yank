import { describe, expect, it, vi } from "vitest";
import {
  extractAssistantText,
  handleExtendedCopy,
  parseCopyArgs,
  type NotifyLevel,
  type SessionEntry,
} from "../extensions/yank-core.js";

describe("parseCopyArgs", () => {
  it("parses index and render flags", () => {
    expect(parseCopyArgs("")).toEqual({ index: 1, render: false });
    expect(parseCopyArgs("2")).toEqual({ index: 2, render: false });
    expect(parseCopyArgs("--render")).toEqual({ index: 1, render: true });
    expect(parseCopyArgs("-r")).toEqual({ index: 1, render: true });
    expect(parseCopyArgs("2 --render")).toEqual({ index: 2, render: true });
    expect(parseCopyArgs("-r 3")).toEqual({ index: 3, render: true });
    expect(parseCopyArgs("0 --render")).toEqual({ index: 1, render: true });
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

  it("copies rendered text in --render mode", async () => {
    const copied: string[] = [];

    await handleExtendedCopy("2 --render", mkBranch(), mkBranch(), {
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

  it("uses interactive picker for non-render mode when one or more code blocks exist", async () => {
    const copied: string[] = [];
    const branch: SessionEntry[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "```python\nprint('a')\n```" }],
        },
      },
    ];

    await handleExtendedCopy("1", branch, branch, {
      renderMarkdownToText: (md) => md,
      copyToClipboard: async (text) => {
        copied.push(text);
      },
      notify: vi.fn(),
      pickCodeSection: async (_full, blocks) => blocks[0].code,
    });

    expect(copied[0]).toBe("print('a')");
  });

  it("skips picker in --render mode", async () => {
    const copied: string[] = [];
    const pickCodeSection = vi.fn(async () => "unexpected");
    const branch: SessionEntry[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "```python\nprint('a')\n```\n\n```rust\nfn main() {}\n```" }],
        },
      },
    ];

    await handleExtendedCopy("1 --render", branch, branch, {
      renderMarkdownToText: (md) => `RENDERED:${md}`,
      copyToClipboard: async (text) => {
        copied.push(text);
      },
      notify: vi.fn(),
      pickCodeSection,
    });

    expect(pickCodeSection).not.toHaveBeenCalled();
    expect(copied[0].startsWith("RENDERED:")).toBe(true);
  });

  it("cancels copy when picker is dismissed", async () => {
    const copyToClipboard = vi.fn(async () => undefined);
    const notify = vi.fn();
    const branch: SessionEntry[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "```python\nprint('a')\n```\n\n```rust\nfn main() {}\n```" }],
        },
      },
    ];

    await handleExtendedCopy("1", branch, branch, {
      renderMarkdownToText: (md) => md,
      copyToClipboard,
      notify,
      pickCodeSection: async () => undefined,
    });

    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Copy cancelled", "info");
  });
});
