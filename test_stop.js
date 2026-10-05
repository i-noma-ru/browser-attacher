#!/usr/bin/env node
// stop.js のテスト。空きポートで server.js を 2 つ起動し、指定したポートの 1 つだけが止まることを確かめる。
// 実行: node --test test_stop.js

"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const SERVER = path.join(__dirname, "server.js");
const STOP = path.join(__dirname, "stop.js");
// プロセスの照合に lsof と ps を使うので、Windows では確かめない
const SKIP = process.platform === "win32" ? "win32 では確かめない" : false;

let root;
let portA;
let portB;
let otherPort;
let other;
const children = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function healthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return response.status === 200 && (await response.json()).ok === true;
  } catch {
    return false;
  }
}

async function startServer(port) {
  const child = spawn(process.execPath, [SERVER, "--port", String(port), "--root", root], { stdio: "ignore" });
  children.push(child);
  for (let i = 0; i < 40; i += 1) {
    if (await healthy(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`ポート ${port} のサーバーが起動しませんでした`);
}

const stop = (port) => spawnSync(process.execPath, [STOP, "--port", String(port)], { encoding: "utf8" });

before(async () => {
  if (SKIP) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "attacher-stop-test-"));
  portA = await freePort();
  portB = await freePort();
  otherPort = await freePort();
  // このサーバーではない別のプロセス（/health には応答するが ok ではない）
  other = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ok":false}');
  });
  await new Promise((resolve) => other.listen(otherPort, "127.0.0.1", resolve));
  await startServer(portA);
  await startServer(portB);
});

after(() => {
  for (const child of children) child.kill();
  if (other) other.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test("指定したポートのサーバーだけを止める（ほかのポートは動いたまま）", { skip: SKIP }, async () => {
  const result = stop(portA);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await healthy(portA), false);
  assert.equal(await healthy(portB), true, "別のポートのサーバーまで止まりました");
});

test("動いていないポートは「既に停止」で正常に終わる", { skip: SKIP }, async () => {
  const result = stop(portA);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /既に停止/);
  assert.equal(await healthy(portB), true);
});

test("別のプロセスが使っているポートは止めずに終了コード 1", { skip: SKIP }, async () => {
  const result = stop(otherPort);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(other.listening, true);
  assert.equal(await healthy(portB), true);
});

test("残りのサーバーも、ポートを指定して止められる", { skip: SKIP }, async () => {
  const result = stop(portB);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(await healthy(portB), false);
});
