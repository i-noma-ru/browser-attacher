"use strict";
// 稼働確認 → 無ければサーバーを切り離して起動 → ブラウザで開く。止めるのは stop.js。
// 使い方: node start.js [--port 8931] [--root <作業フォルダ>] [--modes <モード定義の JSON>]
// 引数はそのまま server.js へ渡す。--root を省くと、実行した場所が作業フォルダになる。

const { spawn } = require("child_process");
const path = require("path");

const SERVER = path.join(__dirname, "server.js");
const portIndex = process.argv.indexOf("--port");
const port = portIndex === -1 ? 8931 : parseInt(process.argv[portIndex + 1], 10);
const url = `http://127.0.0.1:${port}`;

async function healthy() {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.status === 200 && (await response.json()).ok === true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBrowser() {
  let command;
  let args;
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      console.log(code === 0
        ? `ブラウザで開きました: ${url}`
        : `ブラウザを開けませんでした（終了コード ${code}）: ${url}`);
      resolve();
    };
    try {
      const child = spawn(command, args);
      child.on("error", () => finish(1));
      child.on("close", (code) => finish(code));
    } catch {
      finish(1);
    }
  });
}

async function main() {
  if (await healthy()) {
    console.log("既に稼働中です。");
    await openBrowser();
    return;
  }

  try {
    const child = spawn(process.execPath, [SERVER, ...process.argv.slice(2)], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    console.log("サーバーの起動に失敗しました。");
    process.exit(1);
  }

  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    if (await healthy()) {
      console.log("サーバーを起動しました。");
      await openBrowser();
      return;
    }
  }

  console.log("サーバーの起動に失敗しました。");
  process.exit(1);
}

main();
