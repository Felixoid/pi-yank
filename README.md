# @felixoid/py-yank

Enhanced `/y` yank (copy) command for [pi coding agent](https://github.com/earendil-works/pi).

## Features

- `/y` — same as `/y 1` (raw markdown by default)
- `/y 2` — copy 2nd-to-last assistant message as raw markdown
- `/y --plain` — copy last assistant message as rendered plain text
- `/y 2 --plain` — indexed rendered plain-text copy
- `/y --reset` — reset the session option that always copies full response

For default/indexed forms, raw markdown is copied unless `--plain` is passed. If the selected response contains multiple fenced code blocks, `/y` and `/y N` show an interactive picker so you can copy either the full response or one code block.

`--plain` uses **pi TUI Markdown renderer** (`@earendil-works/pi-tui`) and strips ANSI, so copied text keeps structure (tables, lists, code blocks) in plain text. The interactive picker is skipped in `--plain` mode.

## Install

```bash
pi install npm:@felixoid/py-yank
```

Or test without installing:

```bash
pi -e npm:@felixoid/py-yank
```

## Usage

Inside pi:

```text
/y
/y 2
/y --plain
/y 2 --plain
```

## Notes

- This extension registers its own `/y` command.
- Clipboard backend uses pi's built-in `copyToClipboard` utility.

## Development

```bash
npm install
npm run typecheck
npm test
```

Load locally (project mode):

```bash
pi install .
# or add this path to .pi/settings.json packages
```
