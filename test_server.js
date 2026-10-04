#!/usr/bin/env node
// server.js のテスト。一時フォルダを作業フォルダにして、空きポートで実際に起動して確かめる。
// 実行: node --test test_server.js

"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const mod = require("./server.js");

const CUSTOM_MODES = [
  { id: "slides", label: "写真からスライド", header: "【スライド作成】", tail: "スライドを作成してください。" },
  { id: "attach", label: "渡すだけ <b>", header: "【添付】", tail: "受け取りました。" },
];

let root;
let inbox;
let server;
let base;

async function call(method, urlPath, body, headers = {}) {
  const response = await fetch(base + urlPath, { method, body, headers });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, text, json };
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "attacher-test-"));
  inbox = path.join(root, "inbox");
  server = mod.createServer({ root, modes: CUSTOM_MODES });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

test("safeName はパス区切りと .. を拒む", () => {
  assert.equal(mod.safeName(" p1.jpg "), "p1.jpg");
  for (const bad of ["", ".", "..", "a/b.png", "a\\b.png", "a\0.png"]) {
    assert.throws(() => mod.safeName(bad), /ファイル名が不正/);
  }
});

test("destFor は種別と拡張子で保存先を決め、実行物と不一致を拒む", () => {
  assert.equal(mod.destFor("image", "p1.PNG", "/x/inbox"), path.join("/x/inbox", "images", "p1.PNG"));
  assert.equal(mod.destFor("pptx", "old.pptx", "/x/inbox"), path.join("/x/inbox", "input.pptx"));
  assert.equal(mod.destFor("pdf", "doc.pdf", "/x/inbox"), path.join("/x/inbox", "doc.pdf"));
  assert.equal(mod.destFor("file", "表.csv", "/x/inbox"), path.join("/x/inbox", "files", "表.csv"));
  assert.throws(() => mod.destFor("image", "a.pdf", "/x/inbox"), /一致しません/);
  assert.throws(() => mod.destFor("file", "run.sh", "/x/inbox"), /実行可能ファイル/);
  assert.throws(() => mod.destFor("movie", "a.mp4", "/x/inbox"), /kind が不正/);
});

test("buildPrompt は「見出し ファイル一覧 / 末尾の文」を 1 行で作る", () => {
  assert.equal(
    mod.buildPrompt("slides", true, ["doc.pdf"], ["p1.png", "p2.png"], ["表.csv"], CUSTOM_MODES),
    "【スライド作成】 PPTX: inbox/input.pptx / PDF: inbox/ (doc.pdf) / 画像: inbox/images/ (p1.png, p2.png) / 添付ファイル: inbox/files/ (表.csv) / スライドを作成してください。"
  );
  // モードを渡さなければ既定のモード
  assert.match(mod.buildPrompt("attach", false, [], ["a.png"], []), /^【添付】 画像: inbox\/images\/ \(a\.png\) \/ /);
  assert.throws(() => mod.buildPrompt("nope", false, [], ["a.png"], [], CUSTOM_MODES), /mode が不正.*slides \/ attach/);
  assert.throws(() => mod.buildPrompt("slides", false, [], [], [], CUSTOM_MODES), /ファイルが1件もありません/);
});

test("validateModes は形の違うモード定義を拒む", () => {
  assert.equal(mod.validateModes(mod.DEFAULT_MODES), mod.DEFAULT_MODES);
  assert.throws(() => mod.validateModes([]), /1 件以上の配列/);
  assert.throws(() => mod.validateModes({}), /1 件以上の配列/);
  assert.throws(() => mod.validateModes([{ id: "a", label: "x", header: "h" }]), /不足: tail/);
  assert.throws(() => mod.validateModes([{ id: "a b", label: "x", header: "h", tail: "t" }]), /英数字/);
  const one = { id: "a", label: "x", header: "h", tail: "t" };
  assert.throws(() => mod.validateModes([one, { ...one }]), /重複/);
});

test("resetInbox はシンボリックリンクなら消さずに止まる", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attacher-link-"));
  const target = path.join(dir, "target");
  fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "keep.txt"), "x");
  fs.symlinkSync(target, path.join(dir, "inbox", "images"), process.platform === "win32" ? "junction" : undefined);
  assert.throws(() => mod.resetInbox(path.join(dir, "inbox")), /シンボリックリンク/);
  assert.equal(fs.existsSync(path.join(target, "keep.txt")), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("GET /health と受付ページ（モードは渡した定義から作り、文字はエスケープする）", async () => {
  const health = await call("GET", "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true, version: mod.VERSION });

  const page = await call("GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.text, /<option value="slides" selected>写真からスライド<\/option>/);
  assert.match(page.text, /<option value="attach">渡すだけ &lt;b&gt;<\/option>/);
});

test("アップロードは種別ごとの場所へ保存し、不正な入力は 400 で断る", async () => {
  const image = await call("POST", "/upload?kind=image&name=p1.png", Buffer.from("PNG"));
  assert.deepEqual(image.json, { ok: true, saved: "inbox/images/p1.png" });
  assert.equal(fs.readFileSync(path.join(inbox, "images", "p1.png"), "utf8"), "PNG");

  assert.equal((await call("POST", "/upload?kind=pdf&name=doc.pdf", Buffer.from("PDF"))).json.saved, "inbox/doc.pdf");
  assert.equal((await call("POST", "/upload?kind=pptx&name=old.pptx", Buffer.from("PPTX"))).json.saved, "inbox/input.pptx");
  assert.equal((await call("POST", `/upload?kind=file&name=${encodeURIComponent("表.csv")}`, Buffer.from("a,b"))).json.saved, "inbox/files/表.csv");

  for (const urlPath of [
    "/upload?kind=image&name=a.pdf",
    "/upload?kind=file&name=run.sh",
    `/upload?kind=image&name=${encodeURIComponent("../x.png")}`,
    "/upload?kind=movie&name=a.mp4",
    "/upload?kind=image",
  ]) {
    const response = await call("POST", urlPath, Buffer.from("x"));
    assert.equal(response.status, 400, urlPath);
    assert.equal(response.json.ok, false);
  }
  assert.equal(fs.existsSync(path.join(root, "x.png")), false);
});

test("GO は .ready に 1 行（末尾改行なし）を書き、不正な入力は 400 で断る", async () => {
  const ok = await call("POST", "/go", JSON.stringify({ mode: "slides", pptx: true, pdfs: ["doc.pdf"], images: ["p1.png"], files: ["表.csv"] }));
  assert.equal(ok.status, 200);
  const ready = fs.readFileSync(path.join(inbox, ".ready"), "utf8");
  assert.equal(ready, ok.json.prompt);
  assert.equal(ready.endsWith("\n"), false);
  assert.match(ready, /^【スライド作成】 PPTX: inbox\/input\.pptx \/ PDF: /);

  for (const body of [JSON.stringify({ mode: "nope", images: ["p1.png"] }), JSON.stringify({ mode: "slides" }), "{not json", ""]) {
    assert.equal((await call("POST", "/go", body)).status, 400, body);
  }
});

test("リセットは images と files だけを空にする（直下の PDF と PPTX は残す）", async () => {
  const response = await call("POST", "/reset", "");
  assert.deepEqual(response.json, { ok: true, removed: { images: 1, files: 1 } });
  assert.deepEqual(fs.readdirSync(path.join(inbox, "images")), []);
  assert.deepEqual(fs.readdirSync(path.join(inbox, "files")), []);
  assert.equal(fs.existsSync(path.join(inbox, "doc.pdf")), true);
  assert.equal(fs.existsSync(path.join(inbox, "input.pptx")), true);
});

test("未対応のパスは 404、未対応のメソッドは 405", async () => {
  assert.equal((await call("GET", "/nope")).status, 404);
  assert.equal((await call("POST", "/nope", "")).status, 404);
  assert.equal((await call("PUT", "/health", "")).status, 405);
});

test("起動時の引数の誤りは終了コード 2", () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, "server.js"), ...args], { encoding: "utf8", timeout: 10000 });
  assert.equal(run("--bogus").status, 2);
  assert.equal(run("--port", "abc").status, 2);
  assert.equal(run("--root", path.join(root, "no-such-dir")).status, 2);
  const bad = path.join(root, "bad-modes.json");
  fs.writeFileSync(bad, "[]");
  const result = run("--modes", bad);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /1 件以上の配列/);
});
