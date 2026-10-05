"use strict";
// 指定したポートで動いている、このフォルダの server.js だけを止める。使い方: node stop.js [--port 8931]
// 終了コード: 0=止めた・既に停止 / 1=別のプロセスがポートを使っている・止められなかった

const { spawnSync } = require("child_process");
const path = require("path");

// start.js は server.js を絶対パスで起動するので、コマンドラインにこのパスが入る
const SERVER = path.join(__dirname, "server.js");

const portIndex = process.argv.indexOf("--port");
const port = portIndex === -1 ? 8931 : parseInt(process.argv[portIndex + 1], 10);
const url = `http://127.0.0.1:${port}/health`;

function commandForPid(pid) {
  if (process.platform === "win32") {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`;
    return String(spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).stdout || "").trim();
  }
  return String(spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout || "").trim();
}

function listeningPids() {
  if (process.platform === "win32") {
    const output = String(spawnSync("netstat", ["-ano"], { encoding: "utf8" }).stdout || "");
    const pattern = new RegExp(`^\\s*TCP\\s+\\S*:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, "gim");
    return [...new Set([...output.matchAll(pattern)].map((match) => Number(match[1])))];
  }
  const output = String(spawnSync("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout || "");
  return [...new Set(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(Number).filter(Number.isInteger))];
}

function stop(pid) {
  if (process.platform === "win32") {
    spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], { encoding: "utf8" });
    return;
  }
  process.kill(pid, "SIGTERM");
}

async function down() {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return !(response.status === 200 && (await response.json()).ok === true);
  } catch {
    return true;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const pids = listeningPids();
  if (pids.length === 0) {
    console.log("既に停止しています（受付サーバーは動いていません）");
    return;
  }

  const targets = pids.filter((pid) => commandForPid(pid).includes(SERVER));
  if (targets.length === 0) {
    console.error(`ポート ${port} は別のプロセス（PID ${pids.join(", ")}）が使っています。止めません`);
    process.exitCode = 1;
    return;
  }

  try {
    for (const pid of targets) stop(pid);
  } catch {
    // 止まったかどうかは、下の応答の確認で決める
  }

  for (let i = 0; i < 10; i += 1) {
    await sleep(300);
    if (await down()) {
      console.log("受付を終了しました");
      return;
    }
  }

  console.error("停止できませんでした（まだ応答しています）");
  process.exitCode = 1;
}

main();
