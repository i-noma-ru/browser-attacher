# browser-attacher

A small local web page for passing files to a Claude Code session. Drop files onto the page, click GO, and the server saves them under `inbox/` in your project and writes a one-line prompt to `inbox/.ready`. A listener loop in the Claude Code session reads that file, and Claude starts working on what you dropped.
Many terminals cannot take a dropped file or a pasted image, so this page takes them instead and tells Claude where they were saved.

日本語の説明は [README.ja.md](README.ja.md) にあります。The web interface and its messages are in Japanese.

## When to use

- When your terminal does not support drag-and-drop or pasted images.
- When you want to pass several files (photos, a PDF, a PPTX) to Claude with a single instruction.
- When you want the instruction to Claude written for you: a mode such as "summarize" puts a ready-made prompt in `.ready`, so you only drop and click GO.

Not for you if you need to reach the page from another machine (it binds to `127.0.0.1` only and has no authentication), or if you need Windows support that is covered by tests (the Windows code path in `start.js` and `stop.js` is not tested here).

## What it looks like

Drop `p1.jpg` and `p2.jpg`, keep the default mode, and click **GO**. The page shows the result and the prompt it wrote:

```
保存 2 件 / .ready を書きました。

【添付】 画像: inbox/images/ (p1.jpg, p2.jpg) / 上記のファイルを受け取りました。…
```

The listener in the Claude Code session prints that same prompt, and Claude starts working on the files in `inbox/images/`.

## Requirements

- Node.js 18 or later. The server is a single file using Node.js built-in modules only: no npm packages, no external assets.
- Developed and used on macOS. `start.js` and `stop.js` include a Windows code path that is not covered by tests in this repository.
- Binds to `127.0.0.1` only. There is no authentication; do not expose the port.

## Install

Nothing to install beyond Node.js. From the project folder where Claude Code is running:

```sh
node /path/to/browser-attacher/start.js
```

`start.js` checks whether the server is running, starts it as a detached process if not, and opens `http://127.0.0.1:8931` in the browser. The server keeps running after the terminal closes. To stop it:

```sh
node /path/to/browser-attacher/stop.js
```

Options passed through to `server.js`:

| Option | Meaning |
|---|---|
| `--port 9000` | Port (default: 8931). Pass the same value to `stop.js`. |
| `--root <dir>` | Project folder. Files are saved to `<dir>/inbox/`. Default: the current directory. |
| `--modes <file.json>` | Custom mode definitions (see below). |

To run the server in the foreground: `node server.js` (press Ctrl+C to stop).

## The listener

The server only writes files. Something in the Claude Code session must detect `inbox/.ready`. Ask Claude to run this loop in the background (for example, using its Monitor tool) from the project folder:

```sh
while true; do if [ -f inbox/.ready ]; then cat inbox/.ready; echo ""; rm inbox/.ready; fi; sleep 1; done
```

The `echo ""` is necessary: `.ready` has no trailing newline, and line-based watchers do not trigger without one.

## Use

1. Select a mode at the top of the page.
2. Drop files onto the drop zone (or click to choose; Cmd+V / Ctrl+V pastes an image). Files are staged in the browser and not yet sent.
3. Remove any unwanted rows.
4. Click **GO**. The page first empties `inbox/images/` and `inbox/files/`, uploads all files, writes `inbox/.ready`, and displays the result. If the reset fails, nothing is uploaded.

## Where files go

| Kind | Extensions | Saved to |
|---|---|---|
| image | png, jpg, jpeg, webp, gif, heic, bmp | `inbox/images/<name>` |
| pptx | pptx | `inbox/input.pptx` (fixed filename, single file) |
| pdf | pdf | `inbox/<name>` |
| file | anything else that is not blocked | `inbox/files/<name>` |

- Executable file types (`sh`, `py`, `bat`, `ps1`, `exe`, `js`) are rejected with HTTP 400.
- Filenames with path separators or `..` are rejected with HTTP 400.
- Files exceeding 200 MB are rejected with HTTP 413.
- PDFs and `input.pptx` directly under `inbox/` are not removed by the reset.

Add `inbox/` to your project's `.gitignore`.

## Modes

A mode determines the prompt written to `.ready`:

```
<header> <file list> / <tail>
```

Example with the default mode:

```
【添付】 画像: inbox/images/ (p1.jpg, p2.jpg) / 上記のファイルを受け取りました。…
```

To define your own, copy `modes.example.json`, edit it, and pass it via `--modes`. Each entry requires `id` (letters, digits, `_`, `-`), `label` (displayed on the page), `header`, and `tail`. The first entry is selected by default.

## API

| Method | Path | Body and result |
|---|---|---|
| GET | `/` | Web interface HTML |
| GET | `/health` | `{"ok": true, "version": "..."}` |
| POST | `/upload?kind=<image\|pptx\|pdf\|file>&name=<file name>` | Raw file bytes (not multipart). Returns `{"ok": true, "saved": "<relative path>"}` |
| POST | `/reset` | No body. Clears `inbox/images/` and `inbox/files/`. Rejects if either is a symbolic link. |
| POST | `/go` | JSON object with the keys `mode`, `pptx`, `pdfs`, `images`, `files`. Writes `inbox/.ready` and returns `{"ok": true, "prompt": "..."}` |

## Tests

```sh
node --test test_server.js test_stop.js
```

The tests start a real server on an available local port in a temporary folder. `test_stop.js` starts two servers and verifies that `stop.js` stops only the server on the specified port, leaving any port used by another process untouched (skipped on Windows).

## Notes

- Originally created as a VS Code extension by the same author, then rewritten as this browser version.
- Written with AI coding assistance (Claude Code, Gemini).

## License

MIT. See [LICENSE](LICENSE).
