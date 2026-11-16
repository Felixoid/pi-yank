import { DynamicBorder, getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  SelectList,
  Spacer,
  Text,
  type Focusable,
  type KeybindingsManager,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTruncatePrimaryContext,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { filterMessages, type CopyableMessage } from "./yank-core.js";

const MAX_VISIBLE = 12;
const PROMPT_WIDTH_RATIO = 0.35;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

type RowParts = { head: string; prompt: string; tail: string };

function rowParts(message: CopyableMessage): RowParts {
  return {
    head: `${message.index}. `,
    prompt: message.prompt ? oneLine(message.prompt) : "(no prompt)",
    tail: message.turnSize > 1 ? ` [${message.turnPos}/${message.turnSize}]` : "",
  };
}

function toItem(message: CopyableMessage): SelectItem {
  const { head, prompt, tail } = rowParts(message);
  return { value: String(message.index), label: `${head}${prompt}${tail}`, description: oneLine(message.text) };
}

/** Searchable list of assistant messages, newest first. Resolves to the `/y N` index. */
export class MessagePicker extends Container implements Focusable {
  private readonly input = new Input();
  private readonly listContainer = new Container();
  private list!: SelectList;
  private _focused = false;
  private readonly partsByValue: Map<string, RowParts>;
  private readonly layout: SelectListLayoutOptions = {
    truncatePrimary: (ctx) => this.truncatePrimary(ctx),
  };

  constructor(
    private readonly tui: TUI,
    theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly messages: CopyableMessage[],
    private readonly done: (index: number | undefined) => void,
  ) {
    super();
    this.partsByValue = new Map(messages.map((m) => [String(m.index), rowParts(m)]));
    this.addChild(new DynamicBorder());
    this.addChild(new Text(theme.fg("accent", theme.bold("Copy assistant message")), 0, 0));
    this.addChild(
      new Text(theme.fg("muted", "Type to search prompts and replies, enter copies, escape cancels"), 0, 0),
    );
    this.addChild(new Spacer(1));
    this.addChild(this.input);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new DynamicBorder());
    this.rebuildList();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  private rebuildList(): void {
    const items = filterMessages(this.messages, this.input.getValue()).map(toItem);
    this.list = new SelectList(items, MAX_VISIBLE, getSelectListTheme(), this.layout);
    this.list.onSelect = (item) => this.done(Number.parseInt(item.value, 10));
    this.list.onCancel = () => this.done(undefined);
    this.listContainer.clear();
    this.listContainer.addChild(this.list);
  }

  render(width: number): string[] {
    const promptColumn = Math.max(12, Math.floor(width * PROMPT_WIDTH_RATIO));
    this.layout.minPrimaryColumnWidth = promptColumn;
    this.layout.maxPrimaryColumnWidth = promptColumn;
    return super.render(width);
  }

  /** Shortens only the prompt, so the index and [x/y] marker stay visible. */
  private truncatePrimary({ text, item, maxWidth }: SelectListTruncatePrimaryContext): string {
    const parts = this.partsByValue.get(item.value);
    if (!parts || visibleWidth(text) <= maxWidth) return text;
    const promptWidth = maxWidth - visibleWidth(parts.head) - visibleWidth(parts.tail);
    if (promptWidth < 4) return truncateToWidth(text, maxWidth, "…");
    return `${parts.head}${truncateToWidth(parts.prompt, promptWidth, "…")}${parts.tail}`;
  }

  handleInput(data: string): void {
    const kb = this.keybindings;
    if (
      kb.matches(data, "tui.select.up") ||
      kb.matches(data, "tui.select.down") ||
      kb.matches(data, "tui.select.confirm") ||
      kb.matches(data, "tui.select.cancel")
    ) {
      this.list.handleInput(data);
    } else {
      this.input.handleInput(data);
      this.rebuildList();
    }
    this.tui.requestRender();
  }
}
