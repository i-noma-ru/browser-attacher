# browser-attacher

A small local web page for handing files to a Claude Code session. Drop files on the page, press GO, and the server saves them under `inbox/` in your project and writes a one-line prompt to `inbox/.ready`. A listener loop in the Claude Code session reads that file and Claude starts working on what you dropped.

日本語の説明は [README.ja.md](README.ja.md) にあります。The page and the messages are in Japanese.

- One file of server code, Node.js built-in modules only. No npm packages, no external assets.
- Binds to `127.0.0.1` only. There is no authentication; do not expose the port.
- Useful when the terminal cannot take drag-and-drop or pasted images, or when you want to hand over several files with one instruction.

## Status

- Developed and used on macOS with Node.js 18 or later. `start.js` and `stop.js` have a Windows code path that is not covered by the tests in this repository.
- It began as a VS Code extension by the same author and was rewritten as this browser version.

## Run

From the project folder that Claude Code is working in:

```sh
node /path/to/browser-attacher/start.js
```

`start.js` checks whether the server is up, starts it detached if not, and opens `http://127.0.0.1:8931` in the browser. The server keeps running after the terminal closes. Stop it with:

```sh
node /path/to/browser-attacher/stop.js
```

Options, passed through to `server.js`:

| Option | Meaning |
|---|---|
| `--port 9000` | Port (default 8931). Pass the same value to `stop.js`. |
| `--root <dir>` | Project folder. Files go to `<dir>/inbox/`. Default: the current directory. |
| `--modes <file.json>` | Your own list of modes (see below). |

To run the server in the foreground: `node server.js` (Ctrl+C to stop).

## The listener

The server only writes files. Something in the Claude Code session has to notice `inbox/.ready`. Ask Claude to keep this loop running in the background (for example with its Monitor tool), from the project folder:

```sh
while true; do if [ -f inbox/.ready ]; then cat inbox/.ready; echo ""; rm inbox/.ready; fi; sleep 1; done
```

The `echo ""` matters: `.ready` has no trailing newline, and line-based watchers do not fire without one.

## Use

1. Pick a mode at the top of the page.
2. Drop files on the zone (or click to choose; Cmd+V / Ctrl+V pastes an image). Files are staged in the browser and not sent yet.
3. Remove rows you do not want.
4. Press **GO**. The page first empties `inbox/images/` and `inbox/files/`, uploads everything, writes `inbox/.ready`, and shows the result. If the reset fails, nothing is uploaded.

## Where files go

| Kind | Extensions | Saved to |
|---|---|---|
| image | png, jpg, jpeg, webp, gif, heic, bmp | `inbox/images/<name>` |
| pptx | pptx | `inbox/input.pptx` (fixed name, one file) |
| pdf | pdf | `inbox/<name>` |
| file | anything else that is not blocked | `inbox/files/<name>` |

- Executable types (`sh`, `py`, `bat`, `ps1`, `exe`, `js`) are rejected with 400.
- Names with path separators or `..` are rejected with 400.
- Files over 200 MB are rejected with 413.
- PDFs and `input.pptx` directly under `inbox/` are not removed by the reset.

Add `inbox/` to your project's `.gitignore`.

## Modes

A mode decides the prompt written to `.ready`:

```
<header> <file list> / <tail>
```

Example with the default mode:

```
【添付】 画像: inbox/images/ (p1.jpg, p2.jpg) / 上記のファイルを受け取りました。…
```

To define your own, copy `modes.example.json`, edit it, and pass it with `--modes`. Each entry needs `id` (letters, digits, `_`, `-`), `label` (shown in the page), `header`, and `tail`. The first entry is selected by default.

## API

| Method | Path | Body and result |
|---|---|---|
| GET | `/` | The page |
| GET | `/health` | `{"ok": true, "version": "..."}` |
| POST | `/upload?kind=<image\|pptx\|pdf\|file>&name=<file name>` | Raw file bytes (not multipart). Returns `{"ok": true, "saved": "<relative path>"}` |
| POST | `/reset` | No body. Empties `inbox/images/` and `inbox/files/`. Refuses if either is a symbolic link. |
| POST | `/go` | JSON `{"mode","pptx","pdfs","images","files"}`. Writes `inbox/.ready` and returns `{"ok": true, "prompt": "..."}` |

## Tests

```sh
node --test test_server.js test_stop.js
```

The tests start a real server on a free local port in a temporary folder. `test_stop.js` starts two servers and checks that `stop.js` stops only the one on the given port, and leaves a port held by another process alone (skipped on Windows).

## Notes

- Written with AI coding assistance (Claude Code, Gemini).

## License

MIT. See [LICENSE](LICENSE).
