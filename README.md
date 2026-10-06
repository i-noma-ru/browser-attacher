# browser-attacher

A small local web page for passing files to a Claude Code session. Drop files onto the page, click GO, and the server saves them under `inbox/` in your project and writes a one-line prompt to `inbox/.ready`. A listener loop in the Claude Code session reads that file, and Claude starts working on what you dropped.

日本語の説明は [README.ja.md](README.ja.md) にあります。The web interface and its messages are in Japanese.

- Single-file server using Node.js built-in modules only. No npm packages, no external assets.
- Binds to `127.0.0.1` only. There is no authentication; do not expose the port.
- Useful when your terminal does not support drag-and-drop or pasted images, or when you want to pass multiple files with a single instruction.

## Status

- Developed and used on macOS with Node.js 18 or later. `start.js` and `stop.js` include a Windows code path that is not covered by tests in this repository.
- Originally created as a VS Code extension by the same author, then rewritten as this browser version.

## Run

From the project folder where Claude Code is running:

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

- Written with AI coding assistance (Claude Code, Gemini).

## License

MIT. See [LICENSE](LICENSE).
