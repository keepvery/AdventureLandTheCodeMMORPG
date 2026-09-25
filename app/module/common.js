// 共通機能を App.Common にまとめる
window.App = window.App || {};
// モジュール再読み込み後も既存タイマーを追跡できるよう共通状態を保持する
window.__APP_ROUTINE_TIMERS = window.__APP_ROUTINE_TIMERS || {};
App.Common = {
    // エラー値からゲームログに表示できる文字列を取り出す
    formatError: function (error) {
        if (error === null || error === undefined) return "詳細なし";
        if (typeof error === "string") return error;
        if (error.reason) return String(error.reason);
        if (error.message) return String(error.message);
        try {
            return JSON.stringify(error);
        } catch (formatError) {
            return String(error);
        }
    },

    // 指定された共通処理を設定間隔で実行し、同じIDの既存ループを置き換える
    startRoutine: function (options) {
        var settings = options || {};
        var id = settings.id || "default";
        var tasks = Array.isArray(settings.tasks) ? settings.tasks : [];
        var interval = typeof settings.interval === "number" && settings.interval > 0
            ? settings.interval : 250;
        var timers = window.__APP_ROUTINE_TIMERS;
        var pendingTasks = [];
        if (!tasks.length) {
            App.Common.log("定期実行する処理が設定されていません", "orange");
            return null;
        }
        if (timers[id]) clearInterval(timers[id]);

        timers[id] = setInterval(function () {
            if (character.rip) return;
            for (var i = 0; i < tasks.length; i++) {
                var task = typeof tasks[i] === "function"
                    ? { run: tasks[i], name: "定期処理" } : tasks[i];
                if (!task || typeof task.run !== "function") continue;
                if (pendingTasks[i]) continue;
                var taskName = task.name || "定期処理";
                pendingTasks[i] = true;
                try {
                    var result = task.run();
                    if (result && typeof result.then === "function") {
                        // 応答完了まで同じ処理を重ねず、失敗時は処理名と内容を記録する
                        (function (index, name, promise) {
                            promise.then(function () {
                                pendingTasks[index] = false;
                            }, function (error) {
                                pendingTasks[index] = false;
                                App.Common.log(name + "でエラーが発生しました: " +
                                    App.Common.formatError(error), "red");
                            });
                        })(i, taskName, result);
                    } else {
                        pendingTasks[i] = false;
                    }
                } catch (error) {
                    pendingTasks[i] = false;
                    App.Common.log(taskName + "でエラーが発生しました: " +
                        App.Common.formatError(error), "red");
                }
            }
        }, interval);
        return timers[id];
    },

    // 指定IDの定期実行を停止し、タイマーを共通状態から削除する
    stopRoutine: function (id) {
        var timers = window.__APP_ROUTINE_TIMERS || {};
        var routineId = id || "default";
        if (!timers[routineId]) return false;
        clearInterval(timers[routineId]);
        delete timers[routineId];
        return true;
    },

    // 現在のキャラクター設定にあるホームポジションへ移動する
    moveHome: function () {
        var config = window.CONFIG || {};
        var characterConfig = config.CHARACTERS && config.CHARACTERS[character.name];
        var settings = characterConfig && characterConfig.settings || {};
        var home = settings.homePosition;
        if (!home || typeof home.map !== "string" ||
            typeof home.x !== "number" || typeof home.y !== "number") {
            App.Common.log("config.js にホームポジション（map、x、y）を設定してください", "red");
            return;
        }
        App.Common.log("ホームポジションへ移動します", "cyan");
        try {
            var navigation = smart_move(home);
            if (navigation && typeof navigation.then === "function") {
                // 移動処理が失敗した理由をゲームログに表示する
                navigation.then(null, function (error) {
                    App.Common.log("ホーム移動に失敗しました: " +
                        App.Common.formatError(error), "red");
                });
            }
        } catch (error) {
            App.Common.log("ホーム移動に失敗しました: " +
                App.Common.formatError(error), "red");
        }
    },

    // HP・MP回復とアイテム回収に使う共通タスク一覧を作成する
    createMaintenanceTasks: function () {
        return [
            {
                name: "HP・MP回復",
                // HPとMPが満タンでなければ回復処理を試みる
                run: function () {
                    if (character.hp >= character.max_hp && character.mp >= character.max_mp) return;
                    return use_hp_or_mp();
                }
            },
            {
                name: "アイテム回収",
                // 周囲にあるチェストのアイテムを回収する
                run: function () { return loot(); }
            }
        ];
    },

    // 設定で除外した相手を除く連携可能なキャラクター名を返す
    getAllowedSenders: function () {
        if (!window.CONFIG || !CONFIG.CHARACTERS) return [];
        var entries = Array.isArray(CONFIG.CHARACTERS) ? CONFIG.CHARACTERS : Object.keys(CONFIG.CHARACTERS);
        var characterConfig = CONFIG.CHARACTERS[character.name];
        var settings = characterConfig && characterConfig.settings || {};
        var excluded = Array.isArray(settings.excludedSenders) ? settings.excludedSenders : [];
        // 自分自身と設定で除外したキャラクターを候補から外す
        return entries.filter(function (name) {
            return name !== character.name && excluded.indexOf(name) < 0;
        });
    },

    // 指定したキャラクターとの距離を返す
    getDistanceToPlayer: function (name) {
        var player = get_player(name);
        if (!player) return null;
        return parent.distance(character, player);
    },

    // ゲーム内ログへメッセージと色を共通形式で出力する
    log: function (message, color) {
        if (typeof game_log === "function") game_log(message, color);
    },

    // 共通コマンドを処理し、キャラクター固有コマンドは登録済みハンドラーへ渡す
    handleCommand: function (command, options) {
        var settings = options || {};
        if (command === "items") {
            show_json(character.items);
            return true;
        }
        if (command === "upitem") {
            if (!App.Items || typeof App.Items.upgradeWhitelist !== "function") {
                App.Common.log("アイテムモジュールが読み込まれていません", "red");
                return true;
            }
            App.Items.upgradeWhitelist(settings.upgradeItems || {}, function (ok) {
                App.Common.log(ok ? "強化処理が完了しました" : "強化処理を中断しました", ok ? "green" : "orange");
            });
            return true;
        }
        if (command === "meritem") {
            if (typeof settings.maxCombineLevel !== "number" || !settings.compoundScroll || !Array.isArray(settings.accessoryTypes)) {
                App.Common.log("maxCombineLevel、compoundScroll、accessoryTypes を設定してください", "red");
                return true;
            }
            if (!App.Items || typeof App.Items.compoundAll !== "function") {
                App.Common.log("アイテムモジュールが読み込まれていません", "red");
                return true;
            }
            // 設定されたアクセサリ種別だけを対象に合成を開始する
            App.Items.compoundAll({
                maxLevel: settings.maxCombineLevel,
                scrollName: settings.compoundScroll,
                types: settings.accessoryTypes
            // 合成完了または中断の結果をゲームログへ通知する
            }, function (ok) {
                App.Common.log(ok ? "アクセサリ合成が完了しました" : "アクセサリ合成を中断しました",
                    ok ? "green" : "orange");
            });
            return true;
        }
        var handler = settings.handlers && settings.handlers[command];
        if (typeof handler === "function") {
            handler();
            return true;
        }
        return false;
    }
};
