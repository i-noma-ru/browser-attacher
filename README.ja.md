# browser-attacher

Claude Code のセッションへファイルを渡すための、小さなローカルの Web ページです。ページにファイルをドロップして GO を押すと、サーバーがプロジェクトの `inbox/` に保存し、`inbox/.ready` に 1 行の依頼文を書きます。Claude Code の側で動かしておくリスナーが `inbox/.ready` を読み、Claude が渡されたファイルの作業を始めます。
ターミナルの多くはファイルのドロップや画像の貼り付けを受け付けないので、代わりにこのページが受け取り、保存先を Claude に伝えます。

English: [README.md](README.md)

## 使いどころ

- ターミナルにドラッグ＆ドロップや画像の貼り付けができないとき。
- 写真・PDF・PPTX など複数のファイルを、1 つの指示と一緒に Claude へ渡したいとき。
- Claude への依頼文を書く手間を省きたいとき。「内容を要約する」のようなモードを選ぶと、決まった依頼文が `.ready` に書かれるので、ドロップして GO を押すだけで済みます。

向かないとき: 別のマシンからページを開きたい場合（bind は `127.0.0.1` だけで、認証はありません）や、テストで確かめられた Windows 対応が必要な場合（`start.js` と `stop.js` の Windows 用の処理は、このリポジトリのテストでは確かめていません）。

## 動くとこう見える

`p1.jpg` と `p2.jpg` をドロップし、既定のモードのまま **GO** を押します。ページには結果と、書かれた依頼文が表示されます。

```
保存 2 件 / .ready を書きました。

【添付】 画像: inbox/images/ (p1.jpg, p2.jpg) / 上記のファイルを受け取りました。…
```

Claude Code のセッションのリスナーが同じ依頼文を出力し、Claude が `inbox/images/` のファイルの作業を始めます。

## 必要なもの

- Node.js 18 以降。サーバーは 1 ファイルで、Node.js の組み込みモジュールだけを使います。npm パッケージも外部のアセットも要りません。
- macOS で開発し、使っています。`start.js` と `stop.js` には Windows 用の処理がありますが、このリポジトリのテストでは確かめていません。
- bind は `127.0.0.1` だけです。認証はありません。ポートを外へ公開しないでください。

## 導入

Node.js 以外に入れるものはありません。Claude Code が作業しているプロジェクトのフォルダで実行します。

```sh
node /path/to/browser-attacher/start.js
```

`start.js` は、サーバーが動いているかを確かめ、動いていなければ切り離して起動し、ブラウザで `http://127.0.0.1:8931` を開きます。サーバーはターミナルを閉じても動き続けます。止めるときは次を実行します。

```sh
node /path/to/browser-attacher/stop.js
```

オプション（そのまま `server.js` へ渡します）:

| オプション | 意味 |
|---|---|
| `--port 9000` | ポート（既定 8931）。`stop.js` にも同じ値を渡します。 |
| `--root <フォルダ>` | プロジェクトのフォルダ。ファイルは `<フォルダ>/inbox/` に入ります。既定は実行した場所です。 |
| `--modes <file.json>` | 自分用のモード定義（下記）。 |

サーバーを前面で動かすときは `node server.js`（Ctrl+C で終了）。

## リスナー

サーバーはファイルを書くだけです。`inbox/.ready` に気づく役が、Claude Code のセッションの側に要ります。プロジェクトのフォルダで、次のループを背景で動かし続けるよう Claude に頼みます（Monitor ツールなど）。

```sh
while true; do if [ -f inbox/.ready ]; then cat inbox/.ready; echo ""; rm inbox/.ready; fi; sleep 1; done
```

`echo ""` は必要です。`.ready` は末尾に改行が無く、行単位の監視は改行が無いと反応しません。

## 使い方

1. ページの上部でモードを選びます。
2. ドロップゾーンにファイルをドロップします（クリックで選択、⌘V / Ctrl+V で画像の貼り付けもできます）。この時点ではブラウザの中に並ぶだけで、送信されません。
3. 要らない行を「削除」します。
4. **GO** を押します。最初に `inbox/images/` と `inbox/files/` を空にし、全件をアップロードし、`inbox/.ready` を書いて、結果を表示します。リセットに失敗したら 1 件もアップロードしません。

## 保存先

| 種別 | 拡張子 | 保存先 |
|---|---|---|
| image | png / jpg / jpeg / webp / gif / heic / bmp | `inbox/images/<名前>` |
| pptx | pptx | `inbox/input.pptx`（固定名・1 件だけ） |
| pdf | pdf | `inbox/<名前>` |
| file | 上記以外で、拒否対象でないもの | `inbox/files/<名前>` |

- 実行できる種類（`sh`・`py`・`bat`・`ps1`・`exe`・`js`）は 400 で断ります。
- パス区切りや `..` を含む名前は 400 で断ります。
- 200MB を超えるファイルは 413 で断ります。
- `inbox/` 直下の PDF と `input.pptx` は、リセットでは消しません。

プロジェクトの `.gitignore` に `inbox/` を足しておいてください。

## モード

モードは、`.ready` に書く依頼文を決めます。

```
<header> <ファイルの一覧> / <tail>
```

既定のモードの例:

```
【添付】 画像: inbox/images/ (p1.jpg, p2.jpg) / 上記のファイルを受け取りました。…
```

自分用のモードを作るには、`modes.example.json` を写して書き換え、`--modes` で渡します。各項目には `id`（英数字・`_`・`-`）、`label`（ページに出る名前）、`header`、`tail` が要ります。先頭のモードが既定で選ばれます。

## API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/` | 受付ページ |
| GET | `/health` | `{"ok": true, "version": "..."}` |
| POST | `/upload?kind=<image\|pptx\|pdf\|file>&name=<ファイル名>` | ボディはファイルの生バイナリ（multipart ではありません）。`{"ok": true, "saved": "<相対パス>"}` を返します |
| POST | `/reset` | ボディなし。`inbox/images/` と `inbox/files/` を空にします。どちらかがシンボリックリンクなら断ります |
| POST | `/go` | `mode`・`pptx`・`pdfs`・`images`・`files` をキーに持つ JSON。`inbox/.ready` を書き、`{"ok": true, "prompt": "..."}` を返します |

## テスト

```sh
node --test test_server.js test_stop.js
```

一時フォルダを作業フォルダにして、空いているローカルのポートで実際にサーバーを起動して確かめます。`test_stop.js` はサーバーを 2 つ起動し、`stop.js` が指定したポートの 1 つだけを止めること、別のプロセスが使っているポートには手を出さないことを確かめます（Windows では飛ばします）。

## 補足

- 同じ作者の VS Code 拡張として始まり、ブラウザ版として書き直したものです。
- AI のコーディング支援（Claude Code・Gemini）を受けて書いています。

## ライセンス

MIT です。[LICENSE](LICENSE) を参照してください。
