// 商人キャラクター固有のイベント入口
window.App = window.App || {};

App.Chara1 = {
    settings: null,
    merchant: null,

    // CONFIG から現在のキャラクター設定を受け取り商人処理を初期化する
    init: function () {
        this.settings = App.Common.getSettings();
        if (!App.Merchant || typeof App.Merchant.create !== "function") {
            App.Common.log("商人モジュールが loader.js から読み込まれていません", "red");
            return;
        }
        this.merchant = App.Merchant.create(this.settings);
        // 商人モジュールの定期在庫補充を開始する
        this.merchant.startRestockRoutine();
        // 共通ループから回復とアイテム回収を一定間隔で呼び出す
        App.Common.startRoutine({
            id: "character1",
            interval: this.settings.routineInterval || 250,
            // 基本タスク（回復、アイテム改修）
            tasks: App.Common.createMaintenanceTasks()
        });
        App.Common.log("商人ロジックを開始します", "cyan");
    },

    // 共通コマンドを渡し、露店操作だけを商人固有ハンドラーとして登録する
    handleCommand: function (command) {
        var settings = this.settings || {};
        App.Common.handleCommand(command, {
            upgradeItems: settings.upgradeItems || {},
            maxCombineLevel: settings.maxCombineLevel,
            compoundScroll: settings.compoundScroll,
            accessoryTypes: settings.accessoryTypes,
            handlers: {
                open: App.Chara1.openStandCommand,
                close: App.Chara1.closeStandCommand
            }
        });
    },

    // 商人専用の露店オープン・出品処理を実行する
    openStandCommand: function () {
        if (App.Chara1.merchant) App.Chara1.merchant.openStandAndStock();
    },

    // 商人専用の露店クローズ処理を実行する
    closeStandCommand: function () {
        if (App.Chara1.merchant) App.Chara1.merchant.closeStand();
    },

    // 売却対象の処理を共通アイテム機能へ委譲する
    sellWhitelistedItems: function () {
        if (this.merchant) this.merchant.sellWhitelistedItems();
    },

    // ゲームのキャラクターメッセージを商人処理へ渡す
    onCM: function (name, data) {
        if (this.merchant) this.merchant.onCM(name, data);
    }
};

// ゲーム本体のメッセージ受信イベントを商人処理へ渡す
function on_cm(name, data) { App.Chara1.onCM(name, data); }

// 既存のコマンド連携イベントを共通コマンド処理へ渡す
function handle_command(command, args) { App.Chara1.handleCommand(command, args); }

if (typeof parent !== "undefined") {
    parent.handle_command = handle_command;
    // 親ウィンドウから売却処理を呼び出せるようにする
    parent.sell_whitelisted_items = function () { App.Chara1.sellWhitelistedItems(); };
}

App.Chara1.init();
