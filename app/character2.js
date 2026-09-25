// キャラクター2のイベント入口と冒険者モジュールを接続する
window.App = window.App || {};

App.Chara2 = {
    adventurer: null,

    // CONFIG から設定を読み込み冒険者の各ループを開始する
    init: function () {
        var config = window.CONFIG || {};
        var characterConfig = config.CHARACTERS && config.CHARACTERS[character.name];
        var settings = (characterConfig && characterConfig.settings) || {};
        if (!App.Adventurer || typeof App.Adventurer.create !== "function") {
            App.Common.log("冒険者モジュールが loader.js から読み込まれていません", "red");
            return;
        }
        this.adventurer = App.Adventurer.create(settings);
        this.adventurer.start();
        App.Common.log("冒険者ロジックを開始します", "cyan");
    },

    // チャットコマンドを共通コマンド処理へ渡す
    handleCommand: function (command) {
        App.Common.handleCommand(command);
    },

    // キャラクター2の冒険者ループを停止する
    stop: function () {
        if (this.adventurer) this.adventurer.stop();
    }
};

// ゲーム本体のコマンドイベントをキャラクター2の処理へ渡す
function handle_command(command, args) { App.Chara2.handleCommand(command, args); }

if (typeof parent !== "undefined") parent.handle_command = handle_command;

App.Chara2.init();
