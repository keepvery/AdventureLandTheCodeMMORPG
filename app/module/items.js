// モジュールの処理を独立したスコープに定義する
(function (root) {
    "use strict";
    root.App = root.App || {};

    var Items = {};
    var CONFIGURED_ROUTINE_INTERVAL = 3 * 60 * 1000;
    // モジュール再読み込み後も処理中状態を維持する
    window.__APP_GOITEM_STATES = window.__APP_GOITEM_STATES || {};
    // モジュール再読み込み後も交換処理の重複起動を防ぐ
    window.__APP_ITEMS_EXCHANGE_RUNNING = window.__APP_ITEMS_EXCHANGE_RUNNING || false;

    // アイテム名からインベントリ内のスロット番号を探す
    Items.findSlot = function (name) {
        for (var i = 0; i < character.items.length; i++) {
            var item = character.items[i];
            if (item && item.name === name) return i;
        }
        return -1;
    };

    // 指定名の未強化アイテムを売却し、売却数を返す
    Items.sellWhitelist = function (allowedNames) {
        var sold = 0;
        var allowed = allowedNames || [];
        for (var i = 0; i < character.items.length; i++) {
            var item = character.items[i];
            if (item && allowed.indexOf(item.name) >= 0 && (!item.level || item.level === 0)) {
                sell(i, item.q || 1);
                root.App.Common.log(item.name + " を売却しました", "orange");
                sold++;
            }
        }
        if (sold) root.App.Common.log("合計 " + sold + " 個の不要アイテムを売却しました", "green");
        return sold;
    };

    // 設定されたアイテムだけをXynで順番に交換する
    Items.exchangeWhitelist = function (allowedNames, done) {
        var allowed = Array.isArray(allowedNames) ? allowedNames.filter(function (name, index, names) {
            return typeof name === "string" && name && names.indexOf(name) === index;
        }) : [];
        var callback = typeof done === "function" ? done : function () {};
        var exchanged = 0;
        if (!allowed.length) {
            root.App.Common.log("config.js の exchangeItems に交換対象を設定してください", "orange");
            callback(false);
            return Promise.resolve(false);
        }
        if (window.__APP_ITEMS_EXCHANGE_RUNNING) {
            root.App.Common.log("Xyn交換処理はすでに実行中です", "orange");
            callback(false);
            return Promise.resolve(false);
        }
        window.__APP_ITEMS_EXCHANGE_RUNNING = true;

        // 対象名ごとに交換可能な所持品を探し、なくなるまで交換する
        function exchangeNextName(index) {
            if (index >= allowed.length) return Promise.resolve(true);
            var itemName = allowed[index];

            // インベントリ番号が交換後に変わるため、操作ごとにスロットを再取得する
            function exchangeNextItem() {
                var slot = Items.findSlot(itemName);
                if (slot < 0) return exchangeNextName(index + 1);
                return Promise.resolve(exchange(slot)).then(function (result) {
                    if (result && (result.failed || result.success === false)) throw result;
                    exchanged++;
                    root.App.Common.log(itemName + " をXynで交換しました" +
                        (result && result.reward ? "（報酬: " + result.reward + "）" : ""), "green");
                    return exchangeNextItem();
                });
            }
            return exchangeNextItem();
        }

        // 交換処理を終えたら実行状態を解除し、結果を呼び出し元へ通知する
        return exchangeNextName(0).then(function () {
            window.__APP_ITEMS_EXCHANGE_RUNNING = false;
            if (!exchanged) root.App.Common.log("設定された交換対象アイテムはありません", "gray");
            else root.App.Common.log("Xyn交換が完了しました（" + exchanged + "個）", "green");
            callback(true);
            return true;
        }, function (error) {
            window.__APP_ITEMS_EXCHANGE_RUNNING = false;
            root.App.Common.log("Xyn交換に失敗しました: " +
                root.App.Common.formatError(error), "red");
            callback(false);
            return false;
        });
    };

    // 合成可能な同種同レベルのアイテム3個を見つけて返す
    Items.findCompoundableSet = function (maxLevel, allowedTypes) {
        var groups = {};
        for (var i = 0; i < character.items.length; i++) {
            var item = character.items[i];
            if (!item) continue;
            var def = G.items[item.name];
            var level = item.level || 0;
            if (!def || !def.compound || level > maxLevel) continue;
            if (allowedTypes && allowedTypes.length && allowedTypes.indexOf(def.type) < 0) continue;
            var key = item.name + "_lv" + level;
            (groups[key] = groups[key] || []).push(i);
            if (groups[key].length === 3) return { name: item.name, level: level, slots: groups[key] };
        }
        return null;
    };

    // 合成可能なアイテムをスクロールが尽きるか完了するまで順に合成する
    Items.compoundAll = function (options, done) {
        var settings = options || {};
        // 完了通知がない場合に使う何もしない代替関数
        var callback = done || function () {};
        // 一定間隔でアイテム状態を確認し、必要な操作を行う
        var timer = setInterval(function () {
            if (character.rip || character.q.compound) return;
            var set = Items.findCompoundableSet(settings.maxLevel, settings.types);
            if (!set) {
                clearInterval(timer);
                root.App.Common.log("すべての合成が完了しました", "green");
                callback(true);
                return;
            }
            var scrollSlot = Items.findSlot(settings.scrollName);
            if (scrollSlot < 0) {
                clearInterval(timer);
                root.App.Common.log("合成スクロール（" + settings.scrollName + "）が不足しています", "red");
                callback(false);
                return;
            }
            set_message("Compounding");
            root.App.Common.log(set.name + " (Lv." + set.level + ") を合成します", "yellow");
            compound(set.slots[0], set.slots[1], set.slots[2], scrollSlot);
        }, settings.interval || 600);
    };

    // 指定スロットのアイテムを目標レベルまで順に強化する
    Items.upgradeOne = function (slot, targetLevel, scrollName, done) {
        // 完了通知がない場合に使う何もしない代替関数
        var callback = done || function () {};
        var original = character.items[slot];
        if (!original) {
            root.App.Common.log("指定スロットにアイテムがありません", "red");
            callback(false, 0);
            return;
        }
        var itemName = original.name;
        root.App.Common.log(itemName + " を Lv." + targetLevel + " まで強化します", "cyan");
        // 一定間隔でアイテム状態を確認し、必要な操作を行う
        var timer = setInterval(function () {
            if (character.rip || character.q.upgrade) return;
            var item = character.items[slot];
            if (!item || item.name !== itemName) {
                clearInterval(timer);
                root.App.Common.log(itemName + " は強化に失敗し破壊されました", "red");
                callback(false, 0);
                return;
            }
            var level = item.level || 0;
            if (level >= targetLevel) {
                clearInterval(timer);
                root.App.Common.log(itemName + " が目標の Lv." + level + " に到達しました", "green");
                callback(true, level);
                return;
            }
            var scrollSlot = Items.findSlot(scrollName);
            if (scrollSlot < 0) {
                clearInterval(timer);
                root.App.Common.log("強化スクロール（" + scrollName + "）が不足しています", "red");
                callback(false, level);
                return;
            }
            set_message("Upgrading Lv." + level);
            upgrade(slot, scrollSlot);
        }, 600);
    };

    // ホワイトリストのアイテムを種類ごとに順番に強化する
    Items.upgradeWhitelist = function (config, done) {
        // 完了通知がない場合に使う何もしない代替関数
        var callback = done || function () {};
        var names = Object.keys(config || {});
        var index = 0;

        // 次のアイテム種類に進み、すべて終われば結果を返す
        function nextType() {
            if (index >= names.length) {
                root.App.Common.log("ホワイトリスト内の強化が完了しました", "green");
                callback(true);
                return;
            }
            var name = names[index];
            var setting = config[name];
            var target = typeof setting === "object" ? setting.level : setting;
            var scroll = typeof setting === "object" && setting.scroll ? setting.scroll : "scroll0";
            if (typeof target !== "number") {
                root.App.Common.log(name + " の強化設定が不正です", "red");
                callback(false);
                return;
            }
            nextItem(name, target, scroll);
        }

        // 対象名の未達アイテムを探して強化し、同種の次のアイテムへ進む
        function nextItem(name, target, scroll) {
            if (Items.findSlot(scroll) < 0) {
                root.App.Common.log("強化スクロール（" + scroll + "）が不足しています", "red");
                callback(false);
                return;
            }
            var slot = -1;
            for (var i = 0; i < character.items.length; i++) {
                var item = character.items[i];
                if (item && item.name === name && (item.level || 0) < target) {
                    slot = i;
                    break;
                }
            }
            if (slot < 0) {
                index++;
                setTimeout(nextType, 250);
                return;
            }
            // 強化結果に応じて次のアイテムへ進む
            Items.upgradeOne(slot, target, scroll, function (success, finalLevel) {
                var current = character.items[slot];
                var destroyed = !current || current.name !== name;
                if (!success && !destroyed && finalLevel < target) {
                    callback(false);
                    return;
                }
                // 待ち時間の後に次の処理を続ける
                setTimeout(function () { nextItem(name, target, scroll); }, 200);
            });
        }

        nextType();
    };

    // 設定済みの売却、強化、合成処理を既存の順番で実行する
    Items.runConfiguredOperations = function (options, done) {
        var settings = options || {};
        var callback = typeof done === "function" ? done : function () {};
        var resolveRun;
        var runPromise = new Promise(function (resolve) { resolveRun = resolve; });
        var completed = false;
        // 完了通知とPromiseを一度だけ確定する
        function complete(ok) {
            if (completed) return;
            completed = true;
            callback(!!ok);
            resolveRun(!!ok);
        }
        var upgradeItems = settings.upgradeItems && typeof settings.upgradeItems === "object"
            ? settings.upgradeItems : {};
        var shouldUpgrade = Object.keys(upgradeItems).length > 0;
        var shouldCompound = typeof settings.maxCombineLevel === "number" &&
            typeof settings.compoundScroll === "string" && settings.compoundScroll;
        if (Array.isArray(settings.sellItems) && settings.sellItems.length) {
            Items.sellWhitelist(settings.sellItems);
        }

        // 強化後に必要な設定が揃っていれば合成し、最終結果を通知する
        function runCompound(upgradeOk) {
            if (!upgradeOk) root.App.Common.log("装備強化を中断しました", "orange");
            if (!shouldCompound) {
                complete(!!upgradeOk);
                return;
            }
            Items.compoundAll({
                maxLevel: settings.maxCombineLevel,
                scrollName: settings.compoundScroll,
                types: settings.accessoryTypes
            }, function (compoundOk) {
                complete(!!upgradeOk && !!compoundOk);
            });
        }

        if (shouldUpgrade) {
            // 強化設定がある場合だけ強化処理を呼び、完了後に合成へ進む
            Items.upgradeWhitelist(upgradeItems, runCompound);
        } else {
            runCompound(true);
        }
        return runPromise;
    };

    // 現在キャラクターのアイテム整理ループが動作中か返す
    Items.isConfiguredRoutineRunning = function () {
        var name = typeof character !== "undefined" && character.name;
        return !!(name && window.__APP_ROUTINE_TIMERS &&
            window.__APP_ROUTINE_TIMERS["goitem-" + name]);
    };

    // 売却・強化・合成を即時実行し、その後3分ごとに繰り返す
    Items.startConfiguredRoutine = function (settings) {
        var name = typeof character !== "undefined" && character.name;
        if (!name || !root.App.Common || typeof root.App.Common.startRoutine !== "function") {
            root.App.Common.log("アイテム整理ループを開始できません", "red");
            return false;
        }
        var id = "goitem-" + name;
        if (Items.isConfiguredRoutineRunning()) {
            root.App.Common.log("アイテム整理ループはすでに実行中です", "gray");
            return false;
        }
        var states = window.__APP_GOITEM_STATES;
        var state = states[id] || (states[id] = { inProgress: false });
        // 処理中なら重ねず、完了時に次の定期実行を許可する
        function run() {
            if (state.inProgress || character.rip) return Promise.resolve(false);
            state.inProgress = true;
            return Promise.resolve().then(function () {
                return Items.runConfiguredOperations(settings);
            }).then(function (ok) {
                state.inProgress = false;
                root.App.Common.log(ok ? "アイテム処理が完了しました" : "アイテム処理が一部中断しました",
                    ok ? "green" : "orange");
                return ok;
            }, function (error) {
                state.inProgress = false;
                throw error;
            });
        }
        root.App.Common.startRoutine({
            id: id,
            interval: CONFIGURED_ROUTINE_INTERVAL,
            tasks: [{ name: "アイテム処理", run: run }]
        });
        root.App.Common.log("アイテム整理ループを開始しました（3分間隔）", "cyan");
        run().then(null, function (error) {
            root.App.Common.log("アイテム処理でエラーが発生しました: " +
                root.App.Common.formatError(error), "red");
        });
        if (root.App.Interface && typeof root.App.Interface.updateItemButton === "function") {
            root.App.Interface.updateItemButton();
        }
        return true;
    };

    // 現在キャラクターのアイテム整理ループを停止する
    Items.stopConfiguredRoutine = function () {
        var name = typeof character !== "undefined" && character.name;
        var stopped = name && root.App.Common.stopRoutine("goitem-" + name);
        if (stopped) root.App.Common.log("アイテム整理ループを停止しました", "gray");
        if (root.App.Interface && typeof root.App.Interface.updateItemButton === "function") {
            root.App.Interface.updateItemButton();
        }
        return !!stopped;
    };

    // 実行状態に応じてアイテム整理ループを開始または停止する
    Items.toggleConfiguredRoutine = function (settings) {
        return Items.isConfiguredRoutineRunning()
            ? Items.stopConfiguredRoutine()
            : Items.startConfiguredRoutine(settings);
    };

    root.App.Items = Items;
})(window);
