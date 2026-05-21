import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { handleExtendedCopy, type NotifyLevel, type SessionEntry } from "./yank-core.js";

function renderMarkdownToText(markdown: string): string {
  const width = Math.max(60, Math.min(140, process.stdout.columns ?? 100));
  const md = new Markdown(markdown, 0, 0, getMarkdownTheme());
  const lines = md.render(width).map((line) => stripAnsi(line).replace(/[ \t]+$/g, ""));
  return lines.join("\n").trimEnd();
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("y", {
    description:
      "Yank (copy) assistant message to clipboard. Usage: /y [N] [--plain] (default /y copies rendered last message)",
    handler: async (args, ctx) => {
      const notify = (message: string, level: NotifyLevel = "info") => {
        if (ctx.hasUI) {
          ctx.ui.notify(message, level);
        }
      };

      const trimmedArgs = (args ?? "").trim();
      const effectiveArgs = trimmedArgs.length > 0 ? trimmedArgs : "1 --plain";

      await handleExtendedCopy(
        effectiveArgs,
        ctx.sessionManager.getBranch() as SessionEntry[],
        ctx.sessionManager.getEntries() as SessionEntry[],
        {
          renderMarkdownToText,
          copyToClipboard,
          notify,
        },
      );
    },
  });
}
