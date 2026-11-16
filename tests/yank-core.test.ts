import { describe, expect, it, vi } from "vitest";
import {
  extractAssistantText,
  filterMessages,
  handleExtendedCopy,
  listCopyableMessages,
  parseCopyArgs,
  type NotifyLevel,
  type SessionEntry,
} from "../extensions/yank-core.js";

describe("parseCopyArgs", () => {
  it("parses index and render flags", () => {
    expect(parseCopyArgs("")).toEqual({ index: 1, render: false, pick: false });
    expect(parseCopyArgs("2")).toEqual({ index: 2, render: false, pick: false });
    expect(parseCopyArgs("--render")).toEqual({ index: 1, render: true, pick: false });
    expect(parseCopyArgs("-r")).toEqual({ index: 1, render: true, pick: false });
    expect(parseCopyArgs("2 --render")).toEqual({ index: 2, render: true, pick: false });
    expect(parseCopyArgs("-r 3")).toEqual({ index: 3, render: true, pick: false });
    expect(parseCopyArgs("0 --render")).toEqual({ index: 1, render: true, pick: false });
    expect(parseCopyArgs("? -r")).toEqual({ index: 1, render: true, pick: true });
  });
});

describe("listCopyableMessages", () => {
  const entries: SessionEntry[] = [
    { type: "message", message: { role: "assistant", content: "greeting" } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "first question" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall" }] } },
    { type: "message", message: { role: "assistant", content: "first answer" } },
    { type: "compaction" },
    { type: "message", message: { role: "user", content: "second question" } },
    { type: "message", message: { role: "assistant", content: "second answer" } },
  ];

  it("pairs replies with the preceding prompt and numbers them like /y N", () => {
    expect(listCopyableMessages(entries, [])).toEqual([
      { index: 3, prompt: "", text: "greeting", turnPos: 1, turnSize: 1 },
      { index: 2, prompt: "first question", text: "first answer", turnPos: 1, turnSize: 1 },
      { index: 1, prompt: "second question", text: "second answer", turnPos: 1, turnSize: 1 },
    ]);
  });

  it("numbers several replies to one prompt within the turn", () => {
    const turn: SessionEntry[] = [
      { type: "message", message: { role: "user", content: "q" } },
      { type: "message", message: { role: "assistant", content: "a" } },
      { type: "message", message: { role: "toolResult", content: "tool output" } },
      { type: "message", message: { role: "assistant", content: "b" } },
      { type: "message", message: { role: "user", content: "q2" } },
      { type: "message", message: { role: "assistant", content: "c" } },
    ];
    expect(listCopyableMessages(turn, []).map((m) => [m.text, m.turnPos, m.turnSize])).toEqual([
      ["a", 1, 2],
      ["b", 2, 2],
      ["c", 1, 1],
    ]);
  });

  it("falls back to all entries when the branch has no text", () => {
    expect(listCopyableMessages([], entries)).toHaveLength(3);
  });
});

describe("filterMessages", () => {
  const messages = [
    { index: 2, prompt: "Fix the Parser", text: "done", turnPos: 1, turnSize: 1 },
    { index: 1, prompt: "docs", text: "updated README for parser", turnPos: 1, turnSize: 1 },
  ];

  it("matches every term case-insensitively across prompt and reply", () => {
    expect(filterMessages(messages, "parser").map((m) => m.index)).toEqual([2, 1]);
    expect(filterMessages(messages, "PARSER readme").map((m) => m.index)).toEqual([1]);
    expect(filterMessages(messages, "  ")).toBe(messages);
    expect(filterMessages(messages, "nothing")).toEqual([]);
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

  describe("/y ?", () => {
    const deps = (copied: string[], pickMessage?: (m: unknown[]) => Promise<number | undefined>) => ({
      renderMarkdownToText: (md: string) => md,
      copyToClipboard: async (text: string) => {
        copied.push(text);
      },
      notify: vi.fn(),
      pickMessage,
    });

    it("passes messages newest first and copies the picked index", async () => {
      const copied: string[] = [];
      const pickMessage = vi.fn(async (_messages: unknown[]) => 2);

      await handleExtendedCopy("?", mkBranch(), mkBranch(), deps(copied, pickMessage));

      expect(pickMessage.mock.calls[0][0]).toMatchObject([
        { index: 1, text: "second" },
        { index: 2, prompt: "u1" },
      ]);
      expect(copied[0]).toContain("| a | b |");
    });

    it("cancels when the picker is dismissed", async () => {
      const copied: string[] = [];
      const d = deps(copied, async () => undefined);

      await handleExtendedCopy("?", mkBranch(), mkBranch(), d);

      expect(copied).toEqual([]);
      expect(d.notify).toHaveBeenCalledWith("Copy cancelled", "info");
    });

    it("warns without an interactive picker", async () => {
      const copied: string[] = [];
      const d = deps(copied);

      await handleExtendedCopy("?", mkBranch(), mkBranch(), d);

      expect(copied).toEqual([]);
      expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "warning");
    });
  });
});
