// ゲーム画面に表示する共通インターフェースを初期化する
(function (root) {
    "use strict";
    root.App = root.App || {};

    // 現在のキャラクターのホーム移動ボタンを画面上部に追加する
    function addHomeButton() {
        if (typeof add_top_button !== "function") {
            root.App.Common.log("ゲーム画面のボタンAPIを利用できません", "red");
            return;
        }
        // ボタン押下時に共通のホーム移動処理を呼び出す
        add_top_button("home", "H", function () {
            root.App.Common.moveHome();
        });
        set_button_color("home", "#4bb543");
    }

    // アイテム整理ループの状態を示すIボタンを登録する
    function addItemButton() {
        if (typeof add_top_button !== "function") {
            root.App.Common.log("ゲーム画面のボタンAPIを利用できません", "red");
            return;
        }
        add_top_button("goitem", "I", function () {
            var settings = root.App.Common.getSettings();
            root.App.Items.toggleConfiguredRoutine(settings);
            updateItemButton();
        });
        updateItemButton();
    }

    // ループ中は青、停止中は標準のグレー枠にボタンを切り替える
    function updateItemButton() {
        if (typeof set_button_color !== "function") return;
        if (root.App.Items && root.App.Items.isConfiguredRoutineRunning()) {
            set_button_color("goitem", "#2583e9");
        } else {
            set_button_color("goitem", "gray");
        }
    }

    // 共通インターフェースを初期化し、ホーム移動ボタンを登録する
    function init() {
        addHomeButton();
        addItemButton();
    }

    root.App.Interface = {
        // 共通インターフェースの初期化処理を公開する
        init: init,
        // 外部コマンドからもIボタンの表示状態を更新できるよう公開する
        updateItemButton: updateItemButton
    };

    init();
})(window);
