// モジュールの処理を独立したスコープに定義する
(function (root) {
    "use strict";
    root.App = root.App || {};

    var Items = {};

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

    root.App.Items = Items;
})(window);
