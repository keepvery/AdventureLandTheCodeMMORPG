# Adventure Land ローカル CODE サーバー

Adventure Land のゲーム内 CODE から、Windows 上の JavaScript ファイルを読み込むためのローカルサーバーです。
VirtualBox 上の Webサーバー が `app/` を読み取り専用で配信します。
ゲーム用コードは Windows 側で編集し、再読み込みすると変更を取得できます。

## 特徴

- **完全サンドボックス**: Alpine Linux 内で安全に動作。Windowsを汚さない。
- **リソース**: 1 vCPU / 256MB RAM / Nginx常駐。
- CORS 許可とキャッシュ無効化により、ゲーム画面から取得し、ファイル変更を反映する
- `loader.js` から共通モジュール、キャラクター専用モジュール、キャラクターコードを順番に読み込む
- `config.js` でキャラクター名、読み込むスクリプト、各キャラクターの設定を管理する

## 必要なもの

- Windows
- [Oracle VirtualBox](https://www.virtualbox.org/)
- [Vagrant](https://developer.hashicorp.com/vagrant/install)
- Adventure Land のゲーム内 CODE 画面

## 初回セットアップ

### 1. `config.js` を作成する

プロジェクトのルートで PowerShell を開き、サンプル設定をコピーします。

既に `app\config.js` がある場合は上書きしないでください。このファイルは `.gitignore` に登録されており、キャラクター名や個人用設定をGitへ登録しないためのローカル設定です。

### 2. `config.js` を編集する

最低限、次の項目を実際のゲーム内キャラクターに合わせます。

- `CHARACTERS` のキーを実際のキャラクター名に変更する（大文字・小文字を含め完全一致）
- 冒険者設定の `test1` を実際の商人キャラクター名に変更する
- 各キャラクターの `homePosition` を移動先の `{ map, x, y }` に変更する
- 売却・強化・露店・受け渡しなどのアイテム設定を確認する
- 全キャラクターに共通する値は `COMMON_SETTINGS` に置き、`CHARACTERS.<キャラクター名>.settings` に同じキーがあれば個別値で上書きする（オブジェクトは再帰的に合成、配列は個別値で置換）
- 冒険者から補充を頼む商品は `requestItems` に `{ itemName, threshold, quantity }` の配列で設定する（複数可。閾値以下で商人へ依頼し、未補充なら `merchantTimeout` 後に再依頼）
- 自動戦闘を使う場合は `combat.enabled` を `true` にし、クラスに合った `mode` と対象条件を設定する

## サーバーの起動

プロジェクトのルート（`\AdventureLandTheCodeMMORPG`）で PowerShell を開きます。

```powershell
vagrant up
```

初回はAlpine Linuxのイメージ取得とNginxのセットアップが行われるため、時間がかかることがあります。
起動後、ブラウザーで [http://localhost:58080/](http://localhost:58080/) を開き、「サーバーは正常に稼働しています。」と表示されることを確認します。

よく使う操作：

```powershell
vagrant status   # VMの状態を確認
vagrant halt     # VMを停止
vagrant up       # 停止中のVMを再起動
```

## Adventure Land から使う

1. サーバーが起動していることを確認します。
2. Adventure Land の対象キャラクターで CODE 画面を開き、次のブートストラップ用コードを貼り付けます。

```js
var loadSnippet = '$.getScript("http://localhost:58080/loader.js?t=" + Date.now())' +
    '.done(function () { game_log("ローカルコードを再読込しました！", "#4bb543"); })' +
    '.fail(function (xhr, settings, err) { game_log("読込失敗: " + err, "#ff3333"); });';

// キー5にローカルローダーの再読み込みを登録する
map_key("5", "snippet", loadSnippet);

// 初回はキーを押さずにローダーを実行する
eval(loadSnippet);
```

3. 初回実行後、キー **5** を押すとローカルローダーを再読み込みできます。ゲーム内 CODE を再実行したときも、同じコードが起動します。
4. CODE のログに対象キャラクターのコードがロードされた表示が出ることを確認します。読み込みエラーがあれば、失敗した設定・モジュール・ファイル名がログに出ます。
5. `homePosition` が設定されていれば、ゲーム画面上部の **H** ボタンからホーム位置へ移動できます。

このブートストラップは、キャッシュ対策の時刻情報を付けて `http://localhost:58080/loader.js` を取得します。取得した `loader.js` は実行中のキャラクター名を `config.js` の `CHARACTERS` から探し、`MODULES`、キャラクター専用の `modules`、指定された `script` の順で読み込みます。未登録のキャラクター名では読み込みを開始しません。

## 設定・コマンドの例

- `items`: インベントリ内容を表示
- `upitem`: `upgradeItems` に登録したアイテムを強化
- `meritem`: `accessoryTypes` のアイテムを合成
- `/goitem`: 設定されたアイテム売却、強化、合成を順に実行
- `/xyn`: `COMMON_SETTINGS.exchangeItems` に登録したアイテムをXynで交換
- `open` / `close`: 商人キャラクターの露店を操作
- 露店商品は `standListings` の `itemName`、`slot`、`price`、`quantity` で個別に指定できます。`quantity` は省略時1個で、指定数が所持数を超える出品はスキップします
- 商人の補充商品は `restockItems` に複数設定できます。所持数が `threshold` 以下になると `quantity` 個を購入し、必要な場合は商品ごとの `position` へ移動してから元の位置へ戻ります。確認はモジュール内で1分ごとに行います
- `/xyn` の交換対象は全キャラクター共通の `COMMON_SETTINGS.exchangeItems` にアイテム名を登録します。登録した種類だけを交換し、同じ種類を所持している間は順に処理します
- 冒険者の自動戦闘モードは `combat.mode` で選択
- ホーム移動ボタンは各キャラクターの `homePosition` を参照

ゲームコードは `app/` 内で編集します。Vagrant の共有フォルダーは読み取り専用なので、VM内ではなくWindows上のファイルを変更してください。Nginxはキャッシュを無効にして配信するため、通常はゲーム内 CODE を再読み込みすれば変更が反映されます。

## ディレクトリ構成

```text
AdventureLandTheCodeMMORPG/
├── .gitignore
├── README.md
├── Vagrantfile
└── app/
    ├── config.example.js       # 初回設定用テンプレート
    ├── config.js               # ローカル設定（Git管理対象外）
    ├── index.html              # サーバー稼働確認ページ
    ├── loader.js               # ゲームからモジュールとキャラクターコードを読み込む
    ├── character1.js           # 商人キャラクターの入口
    ├── character2.js           # 冒険者キャラクターの入口
    ├── character3.js           # 冒険者キャラクターの入口
    ├── character4.js           # 冒険者キャラクターの入口
    └── module/
        ├── common.js           # 共通処理、定期実行、ホーム移動
        ├── items.js            # アイテム操作
        ├── interface.js        # ゲーム画面の共通インターフェース
        ├── merchant.js         # 商人の露店・回収・在庫補充処理
        ├── adventurer.js       # 冒険者の回復・回収・商人連携
        └── combat.js           # 戦闘対象選択と位置戦略
```
