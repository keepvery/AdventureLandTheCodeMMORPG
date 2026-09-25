// この処理を独立したスコープで実行する
(function () {
    if (window.MAIN_LOOP) clearInterval(window.MAIN_LOOP);
    if (window.SUB_LOOP) clearInterval(window.SUB_LOOP);

    var defaultBaseUrl = "http://localhost:58080";

    // 読み込み失敗の内容をログに表示する
    function loadError(label, xhr, status, err) {
        game_log(label + ": HTTP " + xhr.status + " / " + (err || status), "red");
    }

    // キャラクター用スクリプトを読み込む
    function loadCharacter(baseUrl, file) {
        $.getScript(baseUrl + "/" + file + "?t=" + Date.now())
            // 読み込み成功後に次の処理を行う
            .done(function () {
                game_log(character.name + " (" + file + ") をロードしました", "#4bb543");
            })
            // 読み込み失敗の内容を表示する
            .fail(function (xhr, status, err) {
                loadError("キャラクターコード読み込み失敗", xhr, status, err);
            });
    }

    // 設定順に依存モジュールを読み込む
    function loadModules(baseUrl, files, index, done) {
        if (index >= files.length) { done(); return; }
        var file = files[index];
        if (typeof file !== "string" || !file) {
            game_log("モジュール設定が不正です（index: " + index + "）", "red");
            return;
        }
        $.getScript(baseUrl + "/" + file + "?t=" + Date.now())
            // 読み込み成功後に次の処理を行う
            .done(function () { loadModules(baseUrl, files, index + 1, done); })
            // 読み込み失敗の内容を表示する
            .fail(function (xhr, status, err) {
                loadError("モジュール読み込み失敗 (" + file + ")", xhr, status, err);
            });
    }

    $.getScript(defaultBaseUrl + "/config.js?t=" + Date.now())
        // 読み込み成功後に次の処理を行う
        .done(function () {
            var conf = window.CONFIG || {};
            var baseUrl = (conf.BASE_URL || defaultBaseUrl).replace(/\/+$/, "");
            var characterConfig = conf.CHARACTERS && conf.CHARACTERS[character.name];
            if (!characterConfig || typeof characterConfig.script !== "string") {
                game_log("未登録、または設定不正のキャラクターです: " + character.name, "red");
                return;
            }
            var scriptFile = characterConfig.script;
            var shared = Array.isArray(conf.MODULES) ? conf.MODULES : [];
            var specific = characterConfig.modules;
            if (!Array.isArray(specific)) specific = [];
            // 共通モジュールと専用モジュールの重複を取り除く
            var modules = shared.concat(specific).filter(function (file, index, all) {
                return all.indexOf(file) === index;
            });
            // 全モジュールの読込後にキャラクターコードを読み込む
            loadModules(baseUrl, modules, 0, function () {
                loadCharacter(baseUrl, scriptFile);
            });
        })
        // 読み込み失敗の内容を表示する
        .fail(function (xhr, status, err) {
            loadError("config.js 読み込み失敗", xhr, status, err);
        });
})();
