// ローカルCODEサーバーのサンプル設定です。config.js にコピーして編集してください。
window.CONFIG = {
    // loader.js がゲーム画面からアクセスするローカルサーバーURL
    BASE_URL: "http://localhost:58080",

    // 全キャラクターに共通で先に読み込むモジュール
    MODULES: ["module/common.js", "module/items.js", "module/interface.js"],

     // ゲーム内キャラクター名をキーにし、実行コードと個別設定を登録する
    CHARACTERS: {
        // キャラクター1 (商人キャラクターの設定例)
        "test1": {
            // 実行スクリプト
            script: "character1.js",
            // 個別モジュール
            modules: ["module/merchant.js"],
            // パラメータ
            settings: {
                maxCombineLevel: 2,
                // meritem で合成するアクセサリの G.items.type
                accessoryTypes: ["ring", "earring", "amulet", "belt", "orb"],
                compoundScroll: "cscroll0",
                // 売却アイテムのホワイトリスト
                sellItems: [
                    "cclaw",     // カニの爪
                    "stinger",   // 短剣
                    "sshield",   // 針盾
                ],
                // 強化アイテムホワイトリスト
                upgradeItems: {
                    wcap: 7,
                    wshoes: 7, // 靴
                    sshield: 4,
                    mushroomstaff: 5 // キノコ杖
                },
                // slot は露店側の出品枠、price は販売価格
                standListings: [
                    { slot: 1, price: 99999999 },
                    // { slot: 2, price: 99999999 }
                ],
                pickupDelay: 5000,
                // ホームポジションの座標
                homePosition: { map: "main", x: -136, y: -45 },
                // メッセージ受信除外キャラクター 例: ["test1"] とすると test1 からのメッセージを除外
                // 設定しない場合はCHARACTERSの設定キャラは全て受け入れる
                excludedSenders: ["test1", "test2", "test3", "test4"], 
            }
        },
        // キャラクター2 (冒険者キャラクターの設定例)
        "test2": {
            // 実行スクリプト
            script: "character2.js",
            // 個別モジュール
            modules: ["module/combat.js", "module/adventurer.js"],
            // パラメータ
            settings: {
                // 商人呼び出しの対象キャラクター
                merchantCharacter: "test1",
                // 空き枠がこの数以下になったら商人を呼び出す
                merchantCallThreshold: 5,
                // 商人の応答を待つ時間（5分）※ループ時間
                merchantTimeout: 5 * 60 * 1000,
                // 商人がこの距離以内に来たらアイテムを渡す
                merchantDistance: 300,
                // 商人の位置とインベントリを確認する間隔
                merchantCheckInterval: 1000,
                // 商人に渡さないアイテム名のブラックリスト（例: ["hpot0", "mpot0"]）
                deliveryBlacklist: [
                    "mpot0",        // MP回復
                    "hpot0",        // HP回復
                    "anniversarygift",      // リボンで結んだ10年
                ],
                // 商人に渡さないインベントリ枠（1始まり。1〜7は1行目）
                deliveryBlacklistSlots: [
                    1, 2, 3, 4, 5, 6, 7,
                    36, 37, 38, 39, 40, 41, 42,
                ],
                // 戦闘戦略: wizard は定位置から射程内の敵だけを攻撃する
                combat: {
                    // 自動戦闘を有効にする
                    enabled: true,

                    // stationary: 定位置、approach: 敵へ接近、rotate: 複数地点を巡回
                    mode: "stationary",
                    // mode: "rotate",
                    // positions: [
                    //     { map: "main", x: -195, y: 91 },
                    //     { map: "main", x: -120, y: 30 },
                    //     { map: "main", x: -80, y: 100 }
                    // ],

                    // 戦闘対象にするモンスターの最低経験値
                    minMonsterXp: 100,
                    // 戦闘対象にするモンスターの最大攻撃力
                    maxMonsterAttack: 150,
                    // 戦闘判断を繰り返す間隔（ミリ秒）
                    interval: 250
                },
                // ホームポジション
                homePosition: { map: "main", x: -195, y: 91 },
                // メッセージ受信除外キャラクター 例: ["test1"] とすると test1 からのメッセージを除外
                // 設定しない場合はCHARACTERSの設定キャラは全て受け入れる
                excludedSenders: ["test1", "test2", "test3", "test4"]
            }
        },
        // キャラクター3
        "test3": {
            // 実行スクリプト
            script: "character3.js",
            // 個別モジュール
            modules: ["module/combat.js", "module/adventurer.js"],
            // パラメータ
            settings: {
                // 戦闘スタイルが決まるまでは自動戦闘を開始しない
                combat: { enabled: false },
                homePosition: { map: "main", x: -195, y: 91 },
                // メッセージ受信除外キャラクター 例: ["test1"] とすると test1 からのメッセージを除外
                // 設定しない場合はCHARACTERSの設定キャラは全て受け入れる
                excludedSenders: ["test1", "test2", "test3", "test4"]
            }
        },
        // キャラクター4
        "test4": {
            // 実行スクリプト
            script: "character4.js",
            // 個別モジュール
            modules: ["module/combat.js", "module/adventurer.js"],
            // パラメータ
            settings: {
                // 戦闘スタイルが決まるまでは自動戦闘を開始しない
                combat: { enabled: false },
                homePosition: { map: "main", x: -195, y: 91 },
                // メッセージ受信除外キャラクター 例: ["test1"] とすると test1 からのメッセージを除外
                // 設定しない場合はCHARACTERSの設定キャラは全て受け入れる
                excludedSenders: ["test1", "test2", "test3", "test4"]
            }
        }
    }
};
