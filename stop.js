"use strict";
// このフォルダの server.js を止め、応答が無くなるまで確かめる。使い方: node stop.js [--port 8931]

const { spawnSync } = require("child_process");
const path = require("path");

// start.js は server.js を絶対パスで起動するので、そのパスでプロセスを探す
const SERVER = path.join(__dirname, "server.js");

const portIndex = process.argv.indexOf("--port");
const port = portIndex === -1 ? 8931 : parseInt(process.argv[portIndex + 1], 10);
const url = `http://127.0.0.1:${port}/health`;
const windowsFilter = "$p = Get-CimInstance Win32_Process -Filter \"Name LIKE 'node%'\" | Where-Object { $_.CommandLine -like '*browser-attacher*server.js*' };";

function outputLines(result) {
  const output = String(result.stdout || "").trim();
  return output ? output.split(/\r?\n/).length : 0;
}

function runningCount() {
  if (process.platform === "win32") {
    return outputLines(spawnSync("powershell", ["-NoProfile", "-Command", `${windowsFilter} $p | Select-Object -ExpandProperty ProcessId`], { encoding: "utf8" }));
  }
  return outputLines(spawnSync("pgrep", ["-f", SERVER], { encoding: "utf8" }));
}

function stopServers() {
  if (process.platform === "win32") {
    spawnSync("powershell", ["-NoProfile", "-Command", `${windowsFilter} $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { encoding: "utf8" });
    return;
  }
  spawnSync("pkill", ["-f", SERVER]);
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
  const count = runningCount();
  if (count === 0) {
    console.log("既に停止しています（受付サーバーは動いていません）");
    return;
  }

  stopServers();
  for (let i = 0; i < 10; i += 1) {
    await sleep(300);
    if (await down()) {
      console.log(`受付を終了しました（${count} 件停止）`);
      return;
    }
  }

  console.log("停止できませんでした（まだ応答しています）");
  process.exitCode = 1;
}

main();
