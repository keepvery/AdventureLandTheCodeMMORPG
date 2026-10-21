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
            if (root.App.MonsterHunt && root.App.MonsterHunt.isRunning()) root.App.MonsterHunt.stop();
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

    // Monster Huntの開始・停止を切り替えるQボタンを登録する
    function addQuestButton() {
        if (typeof add_top_button !== "function") return;
        // 押すたびに討伐クエストの自動ループを切り替える
        add_top_button("monsterhunt", "Q", function () {
            if (root.App.MonsterHunt) root.App.MonsterHunt.toggle();
            else root.App.Common.log("Monster Huntモジュールが読み込まれていません", "red");
            updateQuestButton();
        });
        updateQuestButton();
    }

    // 討伐クエストの実行中は青、停止中はグレーの枠を表示する
    function updateQuestButton() {
        if (typeof set_button_color !== "function") return;
        set_button_color("monsterhunt", root.App.MonsterHunt && root.App.MonsterHunt.isRunning()
            ? "#2583e9" : "gray");
    }

    // /xynコマンドと同じ交換処理を実行するyボタンを登録する
    function addExchangeButton() {
        if (typeof add_top_button !== "function") return;
        // 現在キャラクターの交換設定と既存の重複実行防止処理を使う
        add_top_button("xyn", "y", function () {
            root.App.Common.handleCommand("xyn");
        });
        if (typeof set_button_color === "function") set_button_color("xyn", "gray");
    }

    // スタック預け入れとアクセサリ整理を単発実行するBボタンを登録する
    function addBankButton() {
        if (typeof add_top_button !== "function") return;
        // 現在の商人インスタンスへ銀行整理を委譲する
        add_top_button("bank-organize", "B", function () {
            var merchant = root.App.Merchant && root.App.Merchant.current;
            if (character.ctype !== "merchant" || !merchant) {
                root.App.Common.log("銀行整理は商人キャラクターで実行してください", "orange");
                return;
            }
            merchant.organizeBank();
        });
        if (typeof set_button_color === "function") set_button_color("bank-organize", "gray");
    }

    // 共通インターフェースを初期化し、H・I・Q・y・Bボタンを登録する
    function init() {
        addHomeButton();
        addItemButton();
        addQuestButton();
        addExchangeButton();
        addBankButton();
    }

    root.App.Interface = {
        // 共通インターフェースの初期化処理を公開する
        init: init,
        // 外部コマンドからもIボタンの表示状態を更新できるよう公開する
        updateItemButton: updateItemButton,
        // Monster Hunt側からもQボタンの表示状態を更新できるよう公開する
        updateQuestButton: updateQuestButton
    };

    init();
})(window);
