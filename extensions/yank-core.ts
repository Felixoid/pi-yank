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

export function parseCopyArgs(raw: string | undefined): { index: number; plain: boolean } {
  const tokens = (raw ?? "").trim().split(/\s+/).filter(Boolean);
  let index = 1;
  let plain = false;

  for (const token of tokens) {
    if (token === "--plain") {
      plain = true;
      continue;
    }

    if (/^\d+$/.test(token)) {
      index = Math.max(1, Number.parseInt(token, 10));
    }
  }

  return { index, plain };
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
};

function getAssistantEntries(entries: SessionEntry[]): SessionEntry[] {
  return entries.filter((entry) => entry.type === "message" && entry.message?.role === "assistant");
}

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

function getCopyableAssistantMessages(entries: SessionEntry[]): Array<{ entry: SessionEntry; text: string }> {
  return getAssistantEntries(entries)
    .map((entry) => ({ entry, text: extractAssistantText(entry.message?.content) }))
    .filter((item) => item.text.length > 0);
}

export async function handleExtendedCopy(
  argsRaw: string,
  branch: SessionEntry[],
  allEntries: SessionEntry[],
  deps: CopyDeps,
): Promise<void> {
  const { index, plain } = parseCopyArgs(argsRaw);

  // Prefer current branch; fall back to all entries for resumed sessions where branch can be sparse.
  let copyableMessages = getCopyableAssistantMessages(branch);
  if (copyableMessages.length === 0) {
    copyableMessages = getCopyableAssistantMessages(allEntries);
  }

  if (copyableMessages.length === 0) {
    deps.notify("No assistant messages with text found in this session", "warning");
    return;
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
  if (!plain && deps.pickCodeSection) {
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

  const output = plain ? deps.renderMarkdownToText(rawMarkdown) : rawOutput;

  try {
    await deps.copyToClipboard(output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.notify(`Clipboard copy failed: ${message}`, "error");
    return;
  }

  const mode = plain ? "rendered text" : "raw markdown";
  const label = index === 1 ? "last" : `#${index} from last`;
  deps.notify(`Copied ${label} assistant message (${mode}, ${output.length} chars)`, "info");
}
