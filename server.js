#!/usr/bin/env node
/**
 * browser-attacher: ブラウザから inbox/ へファイルを投入し .ready で Claude Code に合図する受付サーバー。
 *
 * 使い方: node server.js [--port 8931] [--root <作業フォルダ>] [--modes <モード定義の JSON>]
 * Node の組み込みモジュールだけで動く。bind は 127.0.0.1 のみ。
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const VERSION = "1.0.0";
// 既定の作業フォルダは起動した場所。--root で変えられる。ファイルは <作業フォルダ>/inbox/ に入る。
const ROOT = process.cwd();
const INBOX = path.join(ROOT, "inbox");
const MAX_BYTES = 200 * 1024 * 1024;

const KIND_EXT = {
  image: new Set(["png", "jpg", "jpeg", "webp", "gif", "heic", "bmp"]),
  pptx: new Set(["pptx"]),
  pdf: new Set(["pdf"]),
  file: new Set(["xlsx", "tex", "csv", "txt", "md", "docx"]),
};
// 受付装置に実行物は流さない（kind=file の受け皿を通り抜けさせない）
const BLOCKED_EXT = new Set(["sh", "py", "bat", "ps1", "exe", "js"]);

// モード = 受付ページで選ぶ「このファイルで何をするか」。.ready に書く文は「<header> <ファイル一覧> / <tail>」。
// 自分の作業に合わせるときは、同じ形の JSON（modes.example.json）を --modes で渡す。先頭のモードが既定になる。
const DEFAULT_MODES = [
  {
    id: "attach",
    label: "ファイルを渡す（作業はチャットで決める）",
    header: "【添付】",
    tail:
      "上記のファイルを受け取りました。直前のチャットで作業内容が決まっていれば、" +
      "受け取ったファイル名を復唱してそのまま作業に入ってください。" +
      "まだ決まっていなければ、受け取ったファイル名を復唱した上で" +
      "「このファイルで何をしたいですか？」と確認してください。",
  },
  {
    id: "summarize",
    label: "内容を要約する",
    header: "【要約】",
    tail: "これらのファイルを読み、内容を要約してください。",
  },
];

function validateModes(modes) {
  /** モード定義を検証して返す。形が違えば Error。 */
  if (!Array.isArray(modes) || modes.length === 0) {
    throw new Error("モード定義は、1 件以上の配列で書いてください。");
  }
  const seen = new Set();
  for (const mode of modes) {
    for (const key of ["id", "label", "header", "tail"]) {
      if (!mode || typeof mode[key] !== "string" || mode[key].trim() === "") {
        throw new Error(`モード定義の各項目には id・label・header・tail の文字列が必要です（不足: ${key}）。`);
      }
    }
    if (!/^[A-Za-z0-9_-]+$/.test(mode.id)) {
      throw new Error(`モードの id は英数字・_・- だけで書いてください（受け取った値: ${pyRepr(mode.id)}）。`);
    }
    if (seen.has(mode.id)) {
      throw new Error(`モードの id が重複しています: ${mode.id}`);
    }
    seen.add(mode.id);
  }
  return modes;
}

function loadModes(file) {
  /** --modes で渡された JSON を読む。 */
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (exc) {
    throw new Error(`モード定義を読めません（${file}）: ${exc.message}`);
  }
  return validateModes(parsed);
}

// pyRepr: Python の repr(str) と同じ書式（エラーメッセージで受け取った値を見せるため）
const NON_PRINTABLE_RE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;
function pyRepr(s) {
  const str = String(s);
  const hasSingle = str.includes("'");
  const hasDouble = str.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";

  let out = "";
  for (const cp of str) {
    if (cp === "\\") {
      out += "\\\\";
    } else if (cp === quote) {
      out += "\\" + quote;
    } else if (cp === "\n") {
      out += "\\n";
    } else if (cp === "\r") {
      out += "\\r";
    } else if (cp === "\t") {
      out += "\\t";
    } else if (cp !== " " && NON_PRINTABLE_RE.test(cp)) {
      const code = cp.codePointAt(0);
      if (code < 0x100) {
        out += "\\x" + code.toString(16).padStart(2, "0");
      } else if (code < 0x10000) {
        out += "\\u" + code.toString(16).padStart(4, "0");
      } else {
        out += "\\U" + code.toString(16).padStart(8, "0");
      }
    } else {
      out += cp;
    }
  }
  return quote + out + quote;
}

// pyJsonDumps: Python の json.dumps(..., ensure_ascii=False) と同じ書式（区切りが ", " と ": "）
function escapeString(str) {
  let res = '"';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const code = str.charCodeAt(i);
    if (ch === '"') {
      res += '\\"';
    } else if (ch === '\\') {
      res += '\\\\';
    } else if (ch === "\b") {
      res += '\\b';
    } else if (ch === "\f") {
      res += '\\f';
    } else if (ch === "\n") {
      res += '\\n';
    } else if (ch === "\r") {
      res += '\\r';
    } else if (ch === "\t") {
      res += '\\t';
    } else if (code < 0x20) {
      res += "\\u00" + code.toString(16).padStart(2, "0");
    } else {
      res += ch;
    }
  }
  res += '"';
  return res;
}

function pyJsonDumps(val) {
  if (val === null || val === undefined) {
    return "null";
  }
  if (typeof val === "boolean") {
    return val ? "true" : "false";
  }
  if (typeof val === "number") {
    return String(val);
  }
  if (typeof val === "string") {
    return escapeString(val);
  }
  if (Array.isArray(val)) {
    return "[" + val.map(pyJsonDumps).join(", ") + "]";
  }
  if (typeof val === "object") {
    const keys = Object.keys(val);
    const items = keys.map((k) => escapeString(k) + ": " + pyJsonDumps(val[k]));
    return "{" + items.join(", ") + "}";
  }
  return "null";
}

function safeName(raw) {
  /** ファイル名を検証してベース名を返す。不正なら ValueError。 */
  const name = (raw || "").trim();
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(
      `ファイル名が不正です（受け取った値: ${pyRepr(raw)}）。` +
        "空・パス区切り・.. を含む名前は保存できません。" +
        "name= にはファイル名だけ（例: p1.jpg）を指定してください。"
    );
  }
  return path.basename(name);
}

function destFor(kind, name, inboxDir = INBOX) {
  /** kind と拡張子を突き合わせ、保存先の絶対パスを返す。不一致なら ValueError。 */
  if (!KIND_EXT[kind]) {
    throw new Error(
      `kind が不正です（受け取った値: ${pyRepr(kind)}）。` +
        "kind= は image / pptx / pdf / file のいずれかを指定してください。"
    );
  }
  const lastDot = name.lastIndexOf(".");
  const ext = lastDot >= 0 ? name.slice(lastDot + 1).toLowerCase() : "";
  if (BLOCKED_EXT.has(ext)) {
    throw new Error(
      `実行可能ファイル（.${ext}）は受け付けません（${name}）。` +
        "受付はデータファイル専用です。スクリプト類は直接ファイルを配置してください。"
    );
  }
  if (kind !== "file" && !KIND_EXT[kind].has(ext)) {
    const allowed = Array.from(KIND_EXT[kind]).sort().join("/");
    throw new Error(
      `kind=${kind} と拡張子（.${ext}）が一致しません（${name}）。` +
        `kind=${kind} で受け付けるのは ${allowed} です。` +
        "正しい kind を指定してください。"
    );
  }
  if (kind === "image") {
    return path.join(inboxDir, "images", name);
  }
  if (kind === "pptx") {
    return path.join(inboxDir, "input.pptx"); // 固定名で上書き（1 件だけ受け付ける）
  }
  if (kind === "pdf") {
    return path.join(inboxDir, name);
  }
  return path.join(inboxDir, "files", name);
}

function buildPrompt(mode, pptx, pdfs, images, files, modes = DEFAULT_MODES) {
  /** .ready に書く1行プロンプトを組み立てる。 */
  const chosen = modes.find((m) => m.id === mode);
  if (!chosen) {
    throw new Error(
      `mode が不正です（受け取った値: ${pyRepr(mode)}）。` +
        `mode は ${modes.map((m) => m.id).join(" / ")} のいずれかを指定してください。`
    );
  }
  const parts = [];
  if (pptx) {
    parts.push("PPTX: inbox/input.pptx");
  }
  if (pdfs && pdfs.length > 0) {
    parts.push(`PDF: inbox/ (${pdfs.join(", ")})`);
  }
  if (images && images.length > 0) {
    parts.push(`画像: inbox/images/ (${images.join(", ")})`);
  }
  if (files && files.length > 0) {
    parts.push(`添付ファイル: inbox/files/ (${files.join(", ")})`);
  }
  if (parts.length === 0) {
    throw new Error(
      "ファイルが1件もありません。" +
        "GO の前にファイルをドロップまたは貼り付けてください。"
    );
  }
  return `${chosen.header} ${parts.join(" / ")} / ${chosen.tail}`;
}

function resetInbox(inboxDir = INBOX) {
  /** inbox/images と inbox/files を空のフォルダにリセットする。 */
  const targets = [
    ["images", path.join(inboxDir, "images")],
    ["files", path.join(inboxDir, "files")],
  ];
  for (const [, targetPath] of targets) {
    try {
      const stat = fs.lstatSync(targetPath);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `対象パス ${targetPath} がシンボリックリンクです。安全のためリセットを中止しました。`
        );
      }
    } catch (e) {
      if (e.code === "ENOENT") {
        // 存在しないならリンクではない
      } else {
        throw e;
      }
    }
  }

  const removed = {};
  for (const [key, targetPath] of targets) {
    let count = 0;
    if (fs.existsSync(targetPath)) {
      count = fs.readdirSync(targetPath).length;
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
    fs.mkdirSync(targetPath, { recursive: true });
    removed[key] = count;
  }
  return removed;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

function formatLogDate(d = new Date()) {
  const day = String(d.getDate()).padStart(2, "0");
  const month = MONTHS[d.getMonth()];
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");
  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

function logMessage(req, statusCode) {
  let ip = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "127.0.0.1";
  if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  } else if (ip === "::1") {
    ip = "127.0.0.1";
  }
  const dateStr = formatLogDate();
  const httpVersion = req.httpVersion || "1.1";
  process.stderr.write(
    `${ip} - - [${dateStr}] "${req.method} ${req.url} HTTP/${httpVersion}" ${statusCode} -\n`
  );
}

function handleUpload(req, res, parsedUrl, rootDir, inboxDir, sendJson) {
  const kind = parsedUrl.searchParams.get("kind") || "";
  const rawName = parsedUrl.searchParams.get("name") || "";
  let name, dest;
  try {
    name = safeName(rawName);
    dest = destFor(kind, name, inboxDir);
  } catch (exc) {
    sendJson(400, { ok: false, error: exc.message });
    return;
  }

  const cl = req.headers["content-length"];
  let length = 0;
  if (cl !== undefined) {
    if (!/^\d+$/.test(cl.trim())) {
      sendJson(400, {
        ok: false,
        error: "Content-Length が数値ではありません。ファイル本体を生バイナリで送ってください。",
      });
      return;
    }
    length = parseInt(cl.trim(), 10);
  }

  if (length > MAX_BYTES) {
    sendJson(413, {
      ok: false,
      error: `${name} は ${length} バイトで上限 ${MAX_BYTES} バイト（200MB）を超えています。分割するか手動で配置してください。`,
    });
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const data = Buffer.concat(chunks);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    const rel = path.relative(rootDir, dest).split(path.sep).join("/");
    sendJson(200, { ok: true, saved: rel });
  });
}

function handleGo(req, res, inboxDir, sendJson, modes) {
  const cl = req.headers["content-length"];
  if (cl === "0" || cl === 0) {
    sendJson(400, {
      ok: false,
      error: 'リクエストボディが空です。{"mode": ...} の JSON を送ってください。',
    });
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const data = Buffer.concat(chunks);
    if (data.length === 0) {
      sendJson(400, {
        ok: false,
        error: 'リクエストボディが空です。{"mode": ...} の JSON を送ってください。',
      });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(data.toString("utf8"));
    } catch (exc) {
      sendJson(400, {
        ok: false,
        error: `JSON を解釈できません: ${exc.message}。UTF-8 の JSON を送ってください。`,
      });
      return;
    }
    let prompt;
    try {
      prompt = buildPrompt(
        payload.mode || "",
        payload.pptx,
        payload.pdfs || [],
        payload.images || [],
        payload.files || [],
        modes
      );
    } catch (exc) {
      sendJson(400, { ok: false, error: exc.message });
      return;
    }
    fs.mkdirSync(inboxDir, { recursive: true });
    // 末尾改行なし（リスナー側が改行を補う）
    fs.writeFileSync(path.join(inboxDir, ".ready"), prompt, "utf8");
    sendJson(200, { ok: true, prompt: prompt });
  });
}

function handleReset(req, res, inboxDir, sendJson) {
  req.on("data", () => {});
  req.on("end", () => {
    let removed;
    try {
      removed = resetInbox(inboxDir);
    } catch (exc) {
      sendJson(500, {
        ok: false,
        error: `受信フォルダのリセットに失敗しました: ${exc.message}。フォルダの権限やシンボリックリンク設定を確認してください。`,
      });
      return;
    }
    sendJson(200, { ok: true, removed: removed });
  });
}

function createServer(options = {}) {
  const rootDir = options.root || ROOT;
  const inboxDir = options.inbox || path.join(rootDir, "inbox");
  const modes = validateModes(options.modes || DEFAULT_MODES);
  const page = pageHtml(modes);

  const server = http.createServer((req, res) => {
    function sendJson(status, payload) {
      const body = Buffer.from(pyJsonDumps(payload), "utf8");
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(body.length),
        "Server": `browser-attacher/${VERSION}`,
      });
      res.end(body);
      logMessage(req, status);
    }

    function sendHtml(status, htmlStr) {
      const body = Buffer.from(htmlStr, "utf8");
      res.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": String(body.length),
        "Server": `browser-attacher/${VERSION}`,
      });
      res.end(body);
      logMessage(req, status);
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    } catch {
      sendJson(400, { ok: false, error: "不正な URL です" });
      return;
    }

    const pathname = parsedUrl.pathname;

    if (req.method === "GET") {
      if (pathname === "/") {
        sendHtml(200, page);
      } else if (pathname === "/health") {
        sendJson(200, { ok: true, version: VERSION });
      } else {
        sendJson(404, { ok: false, error: `未対応のパスです: ${pathname}` });
      }
    } else if (req.method === "POST") {
      if (pathname === "/upload") {
        handleUpload(req, res, parsedUrl, rootDir, inboxDir, sendJson);
      } else if (pathname === "/go") {
        handleGo(req, res, inboxDir, sendJson, modes);
      } else if (pathname === "/reset") {
        handleReset(req, res, inboxDir, sendJson);
      } else {
        sendJson(404, { ok: false, error: `未対応のパスです: ${pathname}` });
      }
    } else {
      sendJson(405, { ok: false, error: `未対応のメソッドです: ${req.method}` });
    }
  });

  server.on("clientError", (err, socket) => {
    if (socket.writable) {
      const body = Buffer.from(
        pyJsonDumps({
          ok: false,
          error: "Content-Length が数値ではありません。ファイル本体を生バイナリで送ってください。",
        }),
        "utf8"
      );
      socket.write(
        `HTTP/1.1 400 Bad Request\r\n` +
          `Server: browser-attacher/${VERSION}\r\n` +
          `Content-Type: application/json; charset=utf-8\r\n` +
          `Content-Length: ${body.length}\r\n` +
          `Connection: close\r\n\r\n`
      );
      socket.write(body);
    }
    socket.destroy(err);
  });

  return server;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function pageHtml(modes) {
  const options = modes
    .map((m, i) => `      <option value="${escapeHtml(m.id)}"${i === 0 ? " selected" : ""}>${escapeHtml(m.label)}</option>`)
    .join("\n");
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude 受付（browser-attacher）</title>
<style>
body { font-family: -apple-system, "Hiragino Sans", "Yu Gothic UI", sans-serif;
       max-width: 720px; margin: 24px auto; padding: 0 16px; color: #222; }
h1 { font-size: 20px; }
.row { margin: 12px 0; }
#zone { border: 2px dashed #8aa; border-radius: 8px; padding: 32px 16px; text-align: center;
        color: #567; cursor: pointer; background: #f7fafa; }
#zone.hot { background: #e6f2ff; border-color: #37c; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { border-bottom: 1px solid #ddd; padding: 6px 4px; text-align: left; }
td.num { text-align: right; white-space: nowrap; }
button { font-size: 14px; padding: 4px 10px; }
#go { font-size: 16px; padding: 8px 24px; }
#result { white-space: pre-wrap; background: #f4f4f4; padding: 12px; border-radius: 6px;
          font-size: 13px; min-height: 1em; }
.err { color: #b00; }
</style>
</head>
<body>
<h1>Claude 受付（browser-attacher）</h1>
<div class="row">
  <label>モード:
    <select id="mode">
${options}
    </select>
  </label>
</div>
<div class="row">
  <div id="zone">ここにファイルをドロップ<br>（クリックで選択・⌘V / Ctrl+V で画像貼り付け）</div>
  <input type="file" id="picker" multiple style="display:none">
</div>
<div class="row"><table id="list"></table></div>
<div class="row"><button id="go">GO</button> <span id="count"></span></div>
<div class="row"><div id="result"></div></div>
<script>
var IMAGE_EXT = ["png","jpg","jpeg","webp","gif","heic","bmp"];
var FILE_EXT = ["xlsx","tex","csv","txt","md","docx"];
var staged = [];

function extOf(name) {
  var i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}
function kindOf(name) {
  var e = extOf(name);
  if (IMAGE_EXT.indexOf(e) >= 0) return "image";
  if (e === "pptx") return "pptx";
  if (e === "pdf") return "pdf";
  return "file";
}
function human(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
function say(msg, isErr) {
  var r = document.getElementById("result");
  r.textContent = msg;
  r.className = isErr ? "err" : "";
}
function render() {
  var t = document.getElementById("list");
  t.innerHTML = "";
  staged.forEach(function (item, idx) {
    var tr = document.createElement("tr");
    [item.name, item.kind].forEach(function (v) {
      var td = document.createElement("td");
      td.textContent = v;
      tr.appendChild(td);
    });
    var size = document.createElement("td");
    size.className = "num";
    size.textContent = human(item.file.size);
    tr.appendChild(size);
    var act = document.createElement("td");
    act.className = "num";
    var btn = document.createElement("button");
    btn.textContent = "削除";
    btn.onclick = function () { staged.splice(idx, 1); render(); };
    act.appendChild(btn);
    tr.appendChild(act);
    t.appendChild(tr);
  });
  document.getElementById("count").textContent = staged.length ? staged.length + " 件" : "";
}
function add(file, fallbackName) {
  var name = file.name || fallbackName;
  var kind = kindOf(name);
  if (kind === "pptx") {
    var old = staged.filter(function (s) { return s.kind === "pptx"; })[0];
    if (old) {
      say("PPTX は1件だけ受け付けます（inbox/input.pptx 固定名）。" + old.name + " を " + name + " で置き換えました。", true);
      staged.splice(staged.indexOf(old), 1);
    }
  }
  staged.push({ file: file, name: name, kind: kind });
}
function addAll(files, tag) {
  for (var i = 0; i < files.length; i++) {
    add(files[i], tag + "-" + Date.now() + "-" + i + ".png");
  }
  render();
}

var zone = document.getElementById("zone");
var picker = document.getElementById("picker");
zone.onclick = function () { picker.click(); };
picker.onchange = function () { addAll(picker.files, "file"); picker.value = ""; };
zone.ondragover = function (e) { e.preventDefault(); zone.className = "hot"; };
zone.ondragleave = function () { zone.className = ""; };
zone.ondrop = function (e) {
  e.preventDefault();
  zone.className = "";
  addAll(e.dataTransfer.files, "drop");
};
document.addEventListener("paste", function (e) {
  var items = e.clipboardData && e.clipboardData.files;
  if (items && items.length) addAll(items, "paste");
});

document.getElementById("go").onclick = function () {
  if (!staged.length) { say("ファイルがありません。ドロップまたは貼り付けてください。", true); return; }
  var go = document.getElementById("go");
  go.disabled = true;
  say("送信中…");
  fetch("/reset", { method: "POST" })
    .then(function (res) {
      return res.json().then(
        function (j) { return { status: res.status, body: j }; },
        function () { return { status: res.status, body: null }; }
      );
    })
    .then(function (r) {
      if (r.status !== 200 || !r.body || !r.body.ok) {
        var err = (r.body && r.body.error) || ("リセットに失敗しました (HTTP " + r.status + ")");
        throw new Error(err);
      }
      startUpload();
    })
    .catch(function (err) {
      say("リセットに失敗しました: " + (err.message || err), true);
      go.disabled = false;
    });

  function startUpload() {
    var queue = staged.slice();
    var ok = { pptx: null, pdfs: [], images: [], files: [] };
    var failed = [];
    var step = function (i) {
      if (i >= queue.length) return finish();
      var item = queue[i];
      var url = "/upload?kind=" + item.kind + "&name=" + encodeURIComponent(item.name);
      // 1件ずつ独立に送る（1件失敗しても残りを続行する）
      return fetch(url, { method: "POST", body: item.file })
        .then(function (res) { return res.json().then(function (j) { return { status: res.status, body: j }; }); })
        .then(function (r) {
          if (r.body && r.body.ok) {
            if (item.kind === "pptx") ok.pptx = "inbox/input.pptx";
            else if (item.kind === "pdf") ok.pdfs.push(item.name);
            else if (item.kind === "image") ok.images.push(item.name);
            else ok.files.push(item.name);
          } else {
            failed.push(item.name + ": " + ((r.body && r.body.error) || ("HTTP " + r.status)));
          }
        })
        .catch(function (err) { failed.push(item.name + ": " + err); })
        .then(function () { return step(i + 1); });
    };
    var finish = function () {
      var saved = (ok.pptx ? 1 : 0) + ok.pdfs.length + ok.images.length + ok.files.length;
      if (!saved) {
        say("保存 0 件。失敗:\\n" + failed.join("\\n"), true);
        go.disabled = false;
        return;
      }
      var body = { mode: document.getElementById("mode").value, pptx: ok.pptx,
                   pdfs: ok.pdfs, images: ok.images, files: ok.files };
      fetch("/go", { method: "POST", body: JSON.stringify(body) })
        .then(function (res) { return res.json(); })
        .then(function (j) {
          if (!j.ok) throw new Error(j.error);
          var msg = "保存 " + saved + " 件 / .ready を書きました。\\n\\n" + j.prompt;
          if (failed.length) msg += "\\n\\n失敗 " + failed.length + " 件:\\n" + failed.join("\\n");
          say(msg, failed.length > 0);
          staged = [];
          render();
        })
        .catch(function (err) { say(".ready の書き込みに失敗しました: " + err, true); })
        .then(function () { go.disabled = false; });
    };
    step(0);
  }
};
render();
</script>
</body>
</html>
`;
}

const PAGE_HTML = pageHtml(DEFAULT_MODES);

function main() {
  let port = 8931;
  let root = ROOT;
  let modes = DEFAULT_MODES;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (!["--port", "--root", "--modes"].includes(args[i]) || value === undefined) {
      console.error("使い方: node server.js [--port 8931] [--root <作業フォルダ>] [--modes <モード定義の JSON>]");
      process.exit(2);
    }
    if (args[i] === "--port") {
      port = parseInt(value, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error(`--port の値が不正です: ${value}`);
        process.exit(2);
      }
    } else if (args[i] === "--root") {
      root = path.resolve(value);
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        console.error(`--root のフォルダがありません: ${root}`);
        process.exit(2);
      }
    } else {
      try {
        modes = loadModes(path.resolve(value));
      } catch (exc) {
        console.error(exc.message);
        process.exit(2);
      }
    }
    i++;
  }

  const server = createServer({ root, modes });
  server.listen(port, "127.0.0.1", () => {
    console.log(
      `browser-attacher: http://127.0.0.1:${port} で待機中（保存先 ${path.join(root, "inbox")}・Ctrl+C で終了）`
    );
  });

  const cleanup = () => {
    console.log("browser-attacher: 終了しました");
    // Node の server.close() は keep-alive 接続（開いたままのブラウザ）が閉じるまで待つので、
    // 接続を切ってから終了する（切らないと、止めたあともプロセスが残る）
    server.closeAllConnections();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

if (require.main === module) {
  main();
}

module.exports = {
  VERSION,
  ROOT,
  INBOX,
  MAX_BYTES,
  KIND_EXT,
  BLOCKED_EXT,
  DEFAULT_MODES,
  validateModes,
  loadModes,
  safeName,
  destFor,
  buildPrompt,
  resetInbox,
  createServer,
  pageHtml,
  PAGE_HTML,
};
