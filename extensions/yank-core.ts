export type MessageContentBlock = {
  type?: string;
  text?: string;
};

export type SessionEntry = {
  type: string;
  message?: {
    role?: string;
    content?: unknown;
  };
};

export type NotifyLevel = "info" | "warning" | "error";

export function parseCopyArgs(raw: string | undefined): {
  index: number;
  render: boolean;
  pick: boolean;
} {
  const tokens = (raw ?? "").trim().split(/\s+/).filter(Boolean);
  let index = 1;
  let render = false;
  let pick = false;

  for (const token of tokens) {
    if (token === "--render" || token === "-r") {
      render = true;
      continue;
    }

    if (token === "?") {
      pick = true;
      continue;
    }

    if (/^\d+$/.test(token)) {
      index = Math.max(1, Number.parseInt(token, 10));
    }
  }

  return { index, render, pick };
}

export function extractAssistantText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return (content as MessageContentBlock[])
    .filter((block) => {
      if (typeof block?.text !== "string") {
        return false;
      }

      // Be tolerant for migrated/resumed sessions where type may be missing.
      return block.type === undefined || block.type === "text";
    })
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

export type CodeBlockOption = {
  language?: string;
  code: string;
};

type CopyDeps = {
  renderMarkdownToText: (markdown: string) => string;
  copyToClipboard: (text: string) => Promise<void>;
  notify: (message: string, level?: NotifyLevel) => void;
  pickCodeSection?: (
    fullText: string,
    codeBlocks: CodeBlockOption[],
  ) => Promise<string | undefined>;
  /** Resolves to the chosen message index (1 = last), or undefined when cancelled. */
  pickMessage?: (messages: CopyableMessage[]) => Promise<number | undefined>;
};

export type CopyableMessage = {
  /** 1 = last assistant message, as in `/y N`. */
  index: number;
  /** Text of the closest preceding user message, empty when none. */
  prompt: string;
  text: string;
  /** 1-based position among the replies to the same prompt. */
  turnPos: number;
  turnSize: number;
};

function extractFencedCodeBlocks(markdown: string): CodeBlockOption[] {
  const blocks: CodeBlockOption[] = [];
  const regex = /```([^\n`]*)\n([\s\S]*?)```/g;

  for (const match of markdown.matchAll(regex)) {
    const languageRaw = match[1]?.trim();
    const code = (match[2] ?? "").replace(/\n$/, "");
    if (!code.trim()) {
      continue;
    }

    blocks.push({
      language: languageRaw.length > 0 ? languageRaw : undefined,
      code,
    });
  }

  return blocks;
}

type CollectedMessage = { prompt: string; text: string; turn: number };

function collectMessages(entries: SessionEntry[]): CollectedMessage[] {
  const result: CollectedMessage[] = [];
  let prompt = "";
  let turn = 0;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role === "user") {
      prompt = extractAssistantText(entry.message?.content);
      turn += 1;
    } else if (role === "assistant") {
      const text = extractAssistantText(entry.message?.content);
      if (text.length > 0) result.push({ prompt, text, turn });
    }
  }

  return result;
}

/** Copyable assistant messages, oldest first. Falls back to all entries when the branch is sparse (resumed sessions). */
export function listCopyableMessages(
  branch: SessionEntry[],
  allEntries: SessionEntry[],
): CopyableMessage[] {
  let messages = collectMessages(branch);
  if (messages.length === 0) {
    messages = collectMessages(allEntries);
  }
  const turnSizes = new Map<number, number>();
  for (const m of messages) {
    turnSizes.set(m.turn, (turnSizes.get(m.turn) ?? 0) + 1);
  }

  const seen = new Map<number, number>();
  return messages.map(({ prompt, text, turn }, i) => {
    const turnPos = (seen.get(turn) ?? 0) + 1;
    seen.set(turn, turnPos);
    return {
      index: messages.length - i,
      prompt,
      text,
      turnPos,
      turnSize: turnSizes.get(turn) ?? 1,
    };
  });
}

/** Case-insensitive match where every whitespace-separated term must occur in the prompt or reply. */
export function filterMessages(messages: CopyableMessage[], query: string): CopyableMessage[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return messages;
  return messages.filter((m) => {
    const haystack = `${m.prompt}\n${m.text}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export async function handleExtendedCopy(
  argsRaw: string,
  branch: SessionEntry[],
  allEntries: SessionEntry[],
  deps: CopyDeps,
): Promise<void> {
  const parsed = parseCopyArgs(argsRaw);
  const { render } = parsed;
  let { index } = parsed;

  const copyableMessages = listCopyableMessages(branch, allEntries);

  if (copyableMessages.length === 0) {
    deps.notify("No assistant messages with text found in this session", "warning");
    return;
  }

  if (parsed.pick) {
    if (!deps.pickMessage) {
      deps.notify("/y ? requires interactive mode", "warning");
      return;
    }
    const picked = await deps.pickMessage([...copyableMessages].reverse());
    if (picked === undefined) {
      deps.notify("Copy cancelled", "info");
      return;
    }
    index = picked;
  }

  if (index > copyableMessages.length) {
    deps.notify(
      `Requested /y ${index}, but only ${copyableMessages.length} assistant message(s) with text exist`,
      "warning",
    );
    return;
  }

  const selected = copyableMessages[copyableMessages.length - index];
  const rawMarkdown = selected.text;

  let rawOutput = rawMarkdown;
  if (!render && deps.pickCodeSection) {
    const codeBlocks = extractFencedCodeBlocks(rawMarkdown);
    if (codeBlocks.length > 0) {
      const picked = await deps.pickCodeSection(rawMarkdown, codeBlocks);
      if (picked === undefined) {
        deps.notify("Copy cancelled", "info");
        return;
      }
      rawOutput = picked;
    }
  }

  const output = render ? deps.renderMarkdownToText(rawMarkdown) : rawOutput;

  try {
    await deps.copyToClipboard(output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.notify(`Clipboard copy failed: ${message}`, "error");
    return;
  }

  const mode = render ? "rendered text" : "raw markdown";
  const label = index === 1 ? "last" : `#${index} from last`;
  deps.notify(`Copied ${label} assistant message (${mode}, ${output.length} chars)`, "info");
}
