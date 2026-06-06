import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, type AutocompleteItem } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import {
  handleExtendedCopy,
  type CodeBlockOption,
  type NotifyLevel,
  type SessionEntry,
} from "./yank-core.js";

type YankFlagSpec = {
  value: string;
  description: string;
  stripFromEffectiveArgs: boolean;
};

const YANK_FLAGS: readonly YankFlagSpec[] = [
  {
    value: "--render",
    description: "Render markdown to plain text",
    stripFromEffectiveArgs: false,
  },
  {
    value: "-r",
    description: "Short alias for --render",
    stripFromEffectiveArgs: false,
  },
  {
    value: "--reset",
    description: "Reset 'always copy full response' for this session",
    stripFromEffectiveArgs: true,
  },
] as const;

const YANK_FLAG_BY_NAME = new Map(YANK_FLAGS.map((flag) => [flag.value, flag]));

function renderMarkdownToText(markdown: string): string {
  const width = Math.max(60, Math.min(140, process.stdout.columns ?? 100));
  const md = new Markdown(markdown, 0, 0, getMarkdownTheme());
  const lines = md.render(width).map((line) => stripAnsi(line).replace(/[ \t]+$/g, ""));
  return lines.join("\n").trimEnd();
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

function preview(text: string, max = 48): string {
  const first = text.split("\n")[0]?.trim() ?? "";
  if (first.length <= max) return first;
  return `${first.slice(0, max - 1)}…`;
}

function tokenize(raw: string): { tokens: string[]; currentToken: string } {
  const trimmed = raw.trim();
  const endsWithSpace = /\s$/.test(raw);
  const tokens = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  const currentToken = endsWithSpace ? "" : (tokens[tokens.length - 1] ?? "");
  return { tokens, currentToken };
}

function getYArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const raw = prefix ?? "";
  const { tokens, currentToken } = tokenize(raw);
  const endsWithSpace = /\s$/.test(raw);
  const consumed = endsWithSpace ? tokens : tokens.slice(0, -1);

  const used = new Set(consumed);
  if (currentToken.startsWith("-") && currentToken.length > 1) {
    used.add(currentToken);
  }

  const hasIndex = consumed.some((t) => /^\d+$/.test(t)) || /^\d+$/.test(currentToken);
  const hasRenderFlag =
    used.has("--render") || used.has("-r") || currentToken === "--render" || currentToken === "-r";

  const candidates: AutocompleteItem[] = [];

  if (!hasIndex) {
    candidates.push({ value: "1", label: "1", description: "Last assistant message" });
  }

  for (const flag of YANK_FLAGS) {
    if (hasRenderFlag && (flag.value === "--render" || flag.value === "-r")) {
      continue;
    }
    if (!used.has(flag.value)) {
      candidates.push({ value: flag.value, label: flag.value, description: flag.description });
    }
  }

  const filtered =
    currentToken.length === 0
      ? candidates
      : candidates.filter((item) => item.value.startsWith(currentToken));

  return filtered.length > 0 ? filtered : null;
}

export default function (pi: ExtensionAPI) {
  let alwaysCopyFullResponse = false;

  pi.registerCommand("y", {
    description:
      "Yank (copy) assistant message to clipboard. Usage: /y [N] [--render|-r] [--reset] (/y behaves like /y 1)",
    getArgumentCompletions: getYArgumentCompletions,
    handler: async (args, ctx) => {
      const notify = (message: string, level: NotifyLevel = "info") => {
        if (ctx.hasUI) {
          ctx.ui.notify(message, level);
        }
      };

      const rawTokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const resetRequested = rawTokens.includes("--reset");
      if (resetRequested) {
        alwaysCopyFullResponse = false;
        notify("Reset: picker will be shown again when multiple code blocks are present", "info");
      }

      const passthroughTokens = rawTokens.filter((token) => {
        const spec = YANK_FLAG_BY_NAME.get(token);
        return !spec?.stripFromEffectiveArgs;
      });

      const trimmedArgs = passthroughTokens.join(" ").trim();
      const effectiveArgs = trimmedArgs.length > 0 ? trimmedArgs : "1";

      await handleExtendedCopy(
        effectiveArgs,
        ctx.sessionManager.getBranch() as SessionEntry[],
        ctx.sessionManager.getEntries() as SessionEntry[],
        {
          renderMarkdownToText,
          copyToClipboard,
          notify,
          pickCodeSection: async (fullText: string, codeBlocks: CodeBlockOption[]) => {
            if (alwaysCopyFullResponse || !ctx.hasUI) {
              return fullText;
            }

            const options: string[] = [];
            const fullLabel = `1. Full response  ${fullText.length} chars, ${countLines(fullText)} lines`;
            options.push(fullLabel);

            for (let i = 0; i < codeBlocks.length; i += 1) {
              const block = codeBlocks[i];
              const lang = block.language ?? "code";
              const linePart = `${countLines(block.code)} lines`;
              options.push(`${i + 2}. ${preview(block.code)}  ${lang}, ${linePart}`);
            }

            const rememberLabel = `${codeBlocks.length + 2}. Always copy full response (session, reset via /y --reset)`;
            options.push(rememberLabel);

            const selected = await ctx.ui.select("Select content to copy:", options);
            if (!selected) {
              return undefined;
            }

            const selectedIndex = options.indexOf(selected);
            if (selectedIndex === 0) {
              return fullText;
            }

            if (selected === rememberLabel) {
              alwaysCopyFullResponse = true;
              return fullText;
            }

            const blockIndex = selectedIndex - 1;
            if (blockIndex >= 0 && blockIndex < codeBlocks.length) {
              return codeBlocks[blockIndex].code;
            }

            return fullText;
          },
        },
      );
    },
  });
}
