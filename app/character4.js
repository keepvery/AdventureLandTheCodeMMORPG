// キャラクター4のイベント入口から共通冒険者モジュールを起動する
window.App = window.App || {};

App.Chara4 = {
    adventurer: null,

    // CONFIG から設定を読み込みキャラクター4の冒険者処理を開始する
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
        App.Common.log("キャラクター4の冒険者ロジックを開始します", "cyan");
    },

    // 共通チャットコマンドを処理する
    handleCommand: function (command) {
        App.Common.handleCommand(command);
    },

    // キャラクター4の冒険者ループを停止する
    stop: function () {
        if (this.adventurer) this.adventurer.stop();
    }
};

// ゲーム本体のコマンドイベントをキャラクター4の処理へ渡す
function handle_command(command, args) { App.Chara4.handleCommand(command, args); }

if (typeof parent !== "undefined") parent.handle_command = handle_command;

App.Chara4.init();
