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
- AUTO_PTを使う場合はCONFIG直下にAUTO_PT: true、PT_LEADERにリーダー名、PT_MEMBERSに参加キャラクター名の配列を設定する（アカウント共通設定のため、キャラクター別settingsでは上書きされません。リーダーが5分ごとに未参加メンバーを招待し、メンバーは招待を自動承認）
- 全キャラクターに共通する値は `COMMON_SETTINGS` に置き、`CHARACTERS.<キャラクター名>.settings` に同じキーがあれば個別値で上書きする（オブジェクトは再帰的に合成、配列は個別値で置換）
- 合成対象は `compoundTypes` に `G.items.type` を指定します（例: アクセサリ種別に `source` を追加すると書物系も対象になります）。
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
- `meritem`: `compoundTypes` に登録した種別の合成可能アイテムを合成
- `/goitem`: 設定されたアイテム売却、強化、合成を順に実行
- `/xyn`: `COMMON_SETTINGS.exchangeItems` に登録したアイテムをXynで交換
- `open` / `close`: 商人キャラクターの露店を操作
- 露店商品は `standListings` の `itemName`、`slot`、`price`、`quantity` で個別に指定できます。`quantity` は省略時1個で、指定数が所持数を超える出品はスキップします
- 商人の補充商品は `restockItems` に複数設定できます。所持数が `threshold` 以下になると `quantity` 個を購入し、必要な場合は商品ごとの `position` へ移動してから元の位置へ戻ります。確認はモジュール内で1分ごとに行います
- Pontyからの購入は商人の `pontyBuyItems` に `{ itemName, maxQuantity }` を設定します。`pontyCheckInterval` で指定した間隔（ミリ秒、初期値は `1 * 60 * 1000` で1分）で販売一覧を確認し、現在の所持数を含めて `maxQuantity` を超えない品だけ購入します。間隔が未設定、または0以下などの無効な値の場合は1分を使用します。`pontyMinGold` は購入後も残す最低goldです。商人が作業中、別マップ、またはPontyから500を超える距離にいる場合はその回をスキップします。Ponty購入処理による移動は行いません
- `/xyn` の交換対象は全キャラクター共通の `COMMON_SETTINGS.exchangeItems` にアイテム名を登録します。登録した種類だけを交換し、同じ種類を所持している間は順に処理します
- 冒険者の自動戦闘モードは `combat.mode` で選択
- `COMMON_SETTINGS.combat.rareMonster` はレアモンスターのPT連携設定です。初期設定では実際のPTリーダー（`character.party`）が `cave` で5秒ごとに視界内の `goldenbat` を探します。発見時は通常の経験値・攻撃力フィルターより優先して接近・攻撃し、攻撃成功またはPTへのヘイトを確認したら、登録済みで受信を許可したPTメンバーへ集合通知を送ります。メンバーは通常の戦闘モードにかかわらず集合して同じ敵を攻撃します。通知は最短10秒間隔で、対象が見えず通知も途絶えて60秒経過した場合、対象の死亡を確認した場合、またはPTが変わった場合は優先戦闘を解除します。全冒険者でコードを再読み込みしてください
- `rareMonster.patrol.enabled: true` の場合、PTに所属する冒険者は洞窟内で `rareMonster.homePosition` を拠点に射程内の敵と戦い、リーダーだけがホーム到着から10分後に `patrol.positions` を順番に巡回してホームへ戻ります。仲間はリーダーの巡回を追従しません。間隔は `patrol.interval`、各地点の確認時間は `patrol.stayMs`（どちらもミリ秒）で変更できます。巡回中にgoldenbatを見つけたら巡回を中断して戦闘に切り替え、戦闘終了後は全員が洞窟ホームへ戻ります。次の巡回は帰還完了から10分後で、再読み込み後も予定時刻を保持します。洞窟への入場は手動で行い、別マップでは既存の戦闘モードを使います
- 洞窟ホームの初期候補は `{ map: "cave", x: 1160, y: 45 }`、巡回地点は5つのbat出現領域の中心付近です。[公式の出現処理](https://github.com/kaansoral/adventureland_mongodb/blob/main/node/server_functions.js#L2047)は5領域から1つをランダムに選ぶため、右下の近接する2領域を確認しやすい位置を選んでいます。出現後は移動するので最多出現位置の保証はありません。この付近は[公式マップ定義](https://github.com/kaansoral/adventureland_mongodb/blob/main/design/maps.js#L419)でmvampireの出現領域にも含まれます。`rareMonster.homePosition` は洞窟巡回用で、Hボタンの移動先は既存の各キャラクターの `homePosition` です
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
