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

    // 共通インターフェースを初期化し、ホーム移動ボタンを登録する
    function init() {
        addHomeButton();
    }

    root.App.Interface = {
        // 共通インターフェースの初期化処理を公開する
        init: init
    };

    init();
})(window);
