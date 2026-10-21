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

    // 設定された種別に合う同種同レベルの合成対象3個を返す
    Items.findCompoundableSet = function (maxLevel, allowedTypes, skippedSets) {
        var groups = {};
        for (var i = 0; i < character.items.length; i++) {
            var item = character.items[i];
            if (!item) continue;
            var def = G.items[item.name];
            var level = item.level || 0;
            if (!def || !def.compound || level > maxLevel) continue;
            if (Array.isArray(allowedTypes) && allowedTypes.length &&
                allowedTypes.indexOf(def.type) < 0) continue;
            var key = item.name + "_lv" + level;
            if (skippedSets && skippedSets[key]) continue;
            (groups[key] = groups[key] || []).push(i);
            if (groups[key].length === 3) return { name: item.name, level: level, slots: groups[key] };
        }
        return null;
    };

    // 低い等級から所持スクロールを選び、合成できない組を飛ばして順に処理する
    Items.compoundAll = function (options, done) {
        var settings = options || {};
        // 完了通知がない場合に使う何もしない代替関数
        var callback = done || function () {};
        var skippedSets = {};
        var pending = false;
        var configuredGrade = /^cscroll([0-2])$/.exec(settings.scrollName || "cscroll0");
        var minimumGrade = configuredGrade ? Number(configuredGrade[1]) : 0;

        // 今回処理できない同種同レベルの組を除外し、次の対象へ進める
        function skipSet(set, reason) {
            skippedSets[set.name + "_lv" + set.level] = true;
            pending = false;
            root.App.Common.log(set.name + " (Lv." + set.level + ") は" + reason +
                "ため次へ進みます", "orange");
        }

        // スクロール不足・等級不適合だけは次の等級を試し、他のエラーは対象を除外する
        function handleError(set, grade, error) {
            var reason = error && (error.reason || error.response) || error;
            if (reason === "scroll" || reason === "no_scroll" ||
                reason === "compound_incompatible_scroll" || reason === "compound_no_scroll") {
                tryScroll(set, grade + 1);
                return;
            }
            if (reason === "in_progress" || reason === "compound_in_progress") {
                pending = false;
                return;
            }
            skipSet(set, "合成を実行できない（" + root.App.Common.formatError(error) + "）");
        }

        // 対象が変化していないことを確認し、通常の合成スクロールを低い等級から試す
        function tryScroll(set, grade) {
            for (var i = 0; i < set.slots.length; i++) {
                var item = character.items[set.slots[i]];
                if (!item || item.name !== set.name || (item.level || 0) !== set.level) {
                    pending = false;
                    return;
                }
            }
            if (grade > 2) {
                skipSet(set, "手持ちのスクロールで合成できない");
                return;
            }
            var scrollName = "cscroll" + grade;
            var scrollSlot = Items.findSlot(scrollName);
            if (scrollSlot < 0) {
                tryScroll(set, grade + 1);
                return;
            }
            var result;
            try {
                set_message("Compounding");
                root.App.Common.log(set.name + " (Lv." + set.level + ") を " +
                    scrollName + " で合成します", "yellow");
                result = compound(set.slots[0], set.slots[1], set.slots[2], scrollSlot);
            } catch (error) {
                handleError(set, grade, error);
                return;
            }
            // 成功・確率的な失敗のどちらも操作完了として扱い、次回は所持品を再確認する
            Promise.resolve(result).then(function (outcome) {
                if (outcome && (outcome.reason || outcome.response || outcome.failed) &&
                    typeof outcome.success !== "boolean") {
                    handleError(set, grade, outcome);
                    return;
                }
                pending = false;
            // ゲーム側が拒否した理由を確認して、再試行または対象のスキップを行う
            }, function (error) {
                handleError(set, grade, error);
            });
        }

        // 一定間隔でアイテム状態を確認し、必要な操作を行う
        var timer = setInterval(function () {
            if (character.rip || pending || (character.q && character.q.compound)) return;
            var set = Items.findCompoundableSet(settings.maxLevel, settings.types, skippedSets);
            if (!set) {
                clearInterval(timer);
                root.App.Common.log(Object.keys(skippedSets).length
                    ? "合成処理が完了しました（合成できない対象はスキップしました）"
                    : "すべての合成が完了しました", "green");
                callback(true);
                return;
            }
            pending = true;
            tryScroll(set, Math.max(minimumGrade, Items.getUpgradeScrollGrade(set.name, set.level)));
        }, settings.interval || 600);
    };

    // 強化・合成レベルに必要なスクロールのグレードをアイテム定義から求める
    Items.getUpgradeScrollGrade = function (itemName, level) {
        var definition = G.items && G.items[itemName];
        var grades = definition && definition.grades;
        if (!Array.isArray(grades) || !grades.length) return 0;
        if (level < grades[0]) return 0;
        if (grades.length > 1 && level < grades[1]) return 1;
        return Math.min(grades.length, 2);
    };

    // 指定スロットのアイテムを低グレードのスクロールから目標レベルまで強化する
    Items.upgradeOne = function (slot, targetLevel, done) {
        var callback = typeof done === "function" ? done : function () {};
        var original = character.items[slot];
        if (!original) {
            root.App.Common.log("指定スロットにアイテムがありません", "red");
            callback(false, 0, false);
            return;
        }
        var itemName = original.name;
        var completed = false;
        var upgrading = false;
        root.App.Common.log(itemName + " を Lv." + targetLevel + " まで強化します", "cyan");

        // 強化処理を終了し、待機タイマーと呼び出し元へ一度だけ結果を返す
        function finish(success, level, skipped) {
            if (completed) return;
            completed = true;
            clearInterval(timer);
            callback(success, level, skipped);
        }

        // 現在の強化段階に必要なグレードから所持スクロールを順に試す
        function tryScroll(grade, level) {
            if (grade > 2) {
                upgrading = false;
                root.App.Common.log(itemName + " は所持スクロールで強化できないため次へ進みます", "orange");
                finish(false, level, true);
                return;
            }
            var scrollSlot = Items.findSlot("scroll" + grade);
            if (scrollSlot < 0) {
                tryScroll(grade + 1, level);
                return;
            }
            var result;
            try {
                result = upgrade(slot, scrollSlot);
            } catch (error) {
                tryScroll(grade + 1, level);
                return;
            }
            Promise.resolve(result).then(function (response) {
                if (response && (response.failed || response.success === false)) {
                    tryScroll(grade + 1, level);
                    return;
                }
                upgrading = false;
            }, function () {
                tryScroll(grade + 1, level);
            });
        }

        // アイテム状態を確認し、現在のレベルに必要な最も低いスクロールで強化する
        function checkUpgrade() {
            if (character.rip || (character.q && character.q.upgrade) || upgrading || completed) return;
            var item = character.items[slot];
            if (!item || item.name !== itemName) {
                root.App.Common.log(itemName + " は強化に失敗し破壊されました", "red");
                finish(false, 0, false);
                return;
            }
            var level = item.level || 0;
            if (level >= targetLevel) {
                root.App.Common.log(itemName + " が目標の Lv." + level + " に到達しました", "green");
                finish(true, level, false);
                return;
            }
            upgrading = true;
            set_message("Upgrading Lv." + level);
            tryScroll(Items.getUpgradeScrollGrade(itemName, level), level);
        }

        var timer = setInterval(checkUpgrade, 600);
        checkUpgrade();
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
            if (typeof target !== "number") {
                root.App.Common.log(name + " の強化設定が不正です", "red");
                callback(false);
                return;
            }
            nextItem(name, target);
        }

        // 対象名の未達アイテムを探して強化し、同種の次のアイテムへ進む
        function nextItem(name, target) {
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
            Items.upgradeOne(slot, target, function (success, finalLevel, skipped) {
                if (skipped) {
                    index++;
                    setTimeout(nextType, 250);
                    return;
                }
                var current = character.items[slot];
                var destroyed = !current || current.name !== name;
                if (!success && !destroyed && finalLevel < target) {
                    callback(false);
                    return;
                }
                // 待ち時間の後に次の処理を続ける
                setTimeout(function () { nextItem(name, target); }, 200);
            });
        }

        nextType();
    };

    // 指定の銀行欄に既存スタックと重ねられる所持品を全スロット確認して順に預ける
    Items.storeMatchingBankStacks = function (pack) {
        var npc = G.npcs && G.npcs[pack];
        var bankLabel = (npc && npc.name || pack) + "（" + pack + "）";
        if (!character.bank || !Array.isArray(character.bank[pack])) {
            return Promise.reject(new Error("銀行の預かり欄を読み込めません: " + pack));
        }
        if (typeof can_stack !== "function") {
            return Promise.reject(new Error("ゲームのスタック判定APIを利用できません"));
        }
        var stored = 0;
        var ok = true;
        // 預け入れごとに銀行の現在状態を読み直し、空き枠ができても残りの対象を処理する
        function storeNext(slot) {
            if (character.rip || !character.bank || !Array.isArray(character.bank[pack])) {
                throw new Error("銀行での預け入れを継続できません");
            }
            if (slot >= character.items.length) {
                root.App.Common.log(bankLabel + "への預け入れが完了しました（" + stored + "枠）", "green");
                return Promise.resolve(ok);
            }
            var item = character.items[slot];
            var matches = false;
            var bankItems = character.bank[pack];
            if (item && !item.b) {
                for (var i = 0; i < bankItems.length; i++) {
                    if (bankItems[i] && can_stack(bankItems[i], item, null, { ignore_pvp: true })) {
                        matches = true;
                        break;
                    }
                }
            }
            if (!matches) return storeNext(slot + 1);
            var label = item.name + " x" + (item.q || 1);
            // 自動格納指定を使い、銀行の既存アイテムとの入れ替えを行わず全数を預ける
            return Promise.resolve().then(function () {
                return bank_store(slot, pack);
            // ゲーム側の完了応答を確認して預け入れ数を記録する
            }).then(function (result) {
                if (result && (result.failed || result.success === false)) throw result;
                stored++;
                root.App.Common.log(label + " を" + bankLabel + "へ預けました", "green");
            // 個別の預け入れに失敗しても、他の対象の処理を続ける
            }).catch(function (error) {
                ok = false;
                root.App.Common.log(label + " を預けられませんでした: " +
                    root.App.Common.formatError(error), "orange");
            // インベントリの次のスロットへ進む
            }).then(function () { return storeNext(slot + 1); });
        }
        // 同期エラーも呼び出し元で捕捉できるようPromiseから預け入れを開始する
        return Promise.resolve().then(function () { return storeNext(0); });
    };

    // 複数の完成・未完成倉庫をまとめて整理し、所持品へ合成用の3個組を確保する
    Items.organizeBankAccessories = function (settings, visitPack) {
        var unfinished = normalizePacks(settings.accessoryUnfinishedBankPack);
        var finished = normalizePacks(settings.accessoryFinishedBankPack);
        var unfinishedPacks = [];
        var finishedPacks = [];
        var snapshots = Object.create(null);
        var maxLevel = settings.maxCombineLevel;
        var types = settings.compoundTypes || settings.accessoryTypes ||
            ["ring", "earring", "amulet", "belt", "orb"];
        var ok = true;

        // 旧形式の文字列も受け取り、重複しない預かり欄IDの配列へ変換する
        function normalizePacks(value) {
            if (value === undefined) return [];
            var values = typeof value === "string" ? [value] : value;
            if (!Array.isArray(values)) return null;
            var packs = [];
            for (var i = 0; i < values.length; i++) {
                if (typeof values[i] !== "string" || !/^items\d+$/.test(values[i])) return null;
                if (packs.indexOf(values[i]) < 0) packs.push(values[i]);
            }
            return packs;
        }

        // 所在フロアでデータを読み込み、別フロアとの比較にも使えるスナップショットを保持する
        function loadPack(pack) {
            return visitPack(pack).then(function () {
                if (!character.bank || !Array.isArray(character.bank[pack])) {
                    throw new Error("預かり欄を読み込めません: " + pack);
                }
                snapshots[pack] = character.bank[pack].slice(0, 42);
            });
        }

        // 全ての指定倉庫を先に読み込み、利用できない欄は除外して残りをまとめて扱う
        function loadPacks(packs, available, index) {
            if (index >= packs.length) return Promise.resolve();
            var pack = packs[index];
            // 正常に取得できた欄だけを保管・集計対象に加える
            return loadPack(pack).then(function () { available.push(pack); },
            // 未解放や移動失敗は記録し、他の欄の読み込みを続ける
            function (error) {
                ok = false;
                root.App.Common.log(pack + " の整理をスキップしました: " +
                    root.App.Common.formatError(error), "orange");
            // 次の欄の読み込みへ進む
            }).then(function () { return loadPacks(packs, available, index + 1); });
        }

        // 既存の合成種別設定に合うアイテムかを判定する
        function isTarget(item) {
            var definition = item && G.items && G.items[item.name];
            return !!(definition && definition.compound && Array.isArray(types) &&
                (!types.length || types.indexOf(definition.type) >= 0));
        }

        // 実際に使えるインベントリの空き枠を数える
        function freeSlots() {
            var size = Number.isInteger(character.isize) ? character.isize : character.items.length;
            var count = 0;
            for (var i = 0; i < size; i++) if (!character.items[i]) count++;
            return count;
        }

        // 読み込み済みの銀行欄を取得し、複数フロアの在庫を同時に比較できるようにする
        function bankItems(pack) {
            if (character.rip || !Array.isArray(snapshots[pack])) {
                throw new Error("預かり欄を操作できません: " + pack);
            }
            return snapshots[pack];
        }

        // 非スタックのアクセサリを預けられる空きがあるか調べる
        function hasBankSpace(pack) {
            var bank = bankItems(pack);
            for (var i = 0; i < 42; i++) if (!bank[i]) return true;
            return false;
        }

        // 銀行に空きがある場合だけ全数を預け、満杯や個別エラーはスキップする
        function storeSlot(pack, slot) {
            var item = character.items[slot];
            if (!item || item.b) return Promise.resolve(false);
            if (!hasBankSpace(pack)) return Promise.resolve(false);
            var label = item.name + " Lv." + (item.level || 0);
            // 格納先は自動選択にして既存の銀行アイテムとの入れ替えを防ぐ
            return loadPack(pack).then(function () {
                if (!hasBankSpace(pack)) return false;
                return bank_store(slot, pack);
            })
                // 預け入れの完了応答を確認する
                .then(function (result) {
                    if (result === false) return false;
                    if (result && (result.failed || result.success === false)) throw result;
                    snapshots[pack] = character.bank[pack].slice(0, 42);
                    root.App.Common.log(label + " を " + pack + " へ預けました", "green");
                    return true;
                // 個別の失敗を記録し、他のアイテムの整理を続ける
                }).catch(function (error) {
                    ok = false;
                    root.App.Common.log(label + " を預けられませんでした: " +
                        root.App.Common.formatError(error), "orange");
                    return false;
                });
        }

        // 指定順に空きのある倉庫を試し、全倉庫で預けられない品は所持品へ残す
        function storeAny(packs, slot, index) {
            if (!character.items[slot]) return Promise.resolve(true);
            if (index >= packs.length) {
                ok = false;
                root.App.Common.log("指定倉庫へ預けられないため " + character.items[slot].name + " を手元に残します", "orange");
                return Promise.resolve(false);
            }
            if (!hasBankSpace(packs[index])) return storeAny(packs, slot, index + 1);
            // 満杯または個別エラーの場合は次の指定倉庫を試す
            return storeSlot(packs[index], slot).then(function (stored) {
                return stored ? true : storeAny(packs, slot, index + 1);
            });
        }

        // 指定したインベントリスロットを、空きのある指定倉庫へ一つずつ預ける
        function storeSlots(packs, slots, index) {
            if (index >= slots.length) return Promise.resolve();
            // 完了後に次のスロットへ進む
            return storeAny(packs, slots[index], 0).then(function () { return storeSlots(packs, slots, index + 1); });
        }

        // 合成可能な未完成品を同じ名前・レベルの組にまとめる
        function matchesGroup(item, group) {
            return isTarget(item) && !item.l && !item.b && item.name === group.name &&
                (item.level || 0) === group.level;
        }

        // 現時点で同じ組に属するインベントリスロットを返す
        function heldSlots(group) {
            var slots = [];
            for (var i = 0; i < character.items.length; i++) {
                if (matchesGroup(character.items[i], group)) slots.push(i);
            }
            return slots;
        }

        // 倉庫と所持品の合計から、最低1枠空けて持ち帰る3個組を決める
        function planGroups() {
            var groups = Object.create(null);
            var order = [];
            var movable = 0;
            // 未完成かつ合成できるアイテムを組ごとに登録する
            function add(item, slot, held) {
                if (!isTarget(item) || item.l || item.b || (item.level || 0) > maxLevel) return;
                var key = JSON.stringify([item.name, item.level || 0]);
                var group = groups[key];
                if (!group) {
                    group = groups[key] = { name: item.name, level: item.level || 0, held: [], bankCount: 0, wanted: 0 };
                    order.push(group);
                }
                if (held) { group.held.push(slot); movable++; }
                else group.bankCount++;
            }
            for (var i = 0; i < character.items.length; i++) add(character.items[i], i, true);
            for (var p = 0; p < unfinishedPacks.length; p++) {
                var bank = bankItems(unfinishedPacks[p]);
                for (var j = 0; j < Math.min(bank.length, 42); j++) add(bank[j], j, false);
            }
            // 所持品を多く使える組を優先して、不要な預け入れと取り出しを減らす
            order.sort(function (a, b) { return b.held.length - a.held.length; });
            var capacity = Math.max(0, freeSlots() + movable - 1);
            for (var k = 0; k < order.length; k++) {
                var group = order[k];
                group.wanted = Math.min(Math.floor((group.held.length + group.bankCount) / 3) * 3,
                    Math.floor(capacity / 3) * 3);
                capacity -= group.wanted;
            }
            return order;
        }

        // 1組分の不足品を取り出し、途中失敗時は今回取り出した品を倉庫へ戻す
        function retrieveGroup(group) {
            var held = heldSlots(group).length;
            var slots = [];
            for (var p = 0; p < unfinishedPacks.length; p++) {
                var pack = unfinishedPacks[p];
                var bank = bankItems(pack);
                for (var i = 0; i < Math.min(bank.length, 42); i++) {
                    if (matchesGroup(bank[i], group)) slots.push({ pack: pack, slot: i });
                }
            }
            var desired = Math.min(Math.max(group.wanted, Math.ceil(held / 3) * 3),
                Math.floor((held + slots.length) / 3) * 3,
                Math.floor((held + Math.max(0, freeSlots() - 1)) / 3) * 3);
            var needed = desired - held;
            if (needed <= 0) return Promise.resolve();
            var retrieved = [];
            // 必要な全スロットを確保できる組だけを順に取り出す
            function take(index) {
                if (index >= needed) return Promise.resolve();
                var source = slots[index];
                var before;
                // 別フロアの倉庫も、操作直前に移動と最新の在庫確認を行う
                return loadPack(source.pack).then(function () {
                    if (freeSlots() <= 1 || !matchesGroup(bankItems(source.pack)[source.slot], group)) {
                        throw new Error("取り出し対象またはインベントリの空き枠が変わりました");
                    }
                    before = character.items.slice();
                    return bank_retrieve(source.pack, source.slot);
                })
                    // 実際に追加されたスロットを記録してから次の品を取り出す
                    .then(function (result) {
                        if (result && (result.failed || result.success === false)) throw result;
                        snapshots[source.pack] = character.bank[source.pack].slice(0, 42);
                        for (var i = 0; i < character.items.length; i++) {
                            if (!before[i] && matchesGroup(character.items[i], group)) {
                                retrieved.push({ slot: i, pack: source.pack });
                            }
                        }
                        if (retrieved.length !== index + 1) throw new Error("取り出したアイテムの反映を確認できません");
                        return take(index + 1);
                    });
            }
            // 同期エラーも捕捉し、合成できない半端な取り出しをできるだけ残さない
            return Promise.resolve().then(function () { return take(0); })
                // 必要数の取り出しが終わったことをログへ表示する
                .then(function () {
                    root.App.Common.log(group.name + " Lv." + group.level + " を合成用に " + desired + "個確保しました", "green");
                // 途中失敗では取り出し元を優先し、空いている未完成倉庫へ今回の取り出し品を戻す
                }).catch(function (error) {
                    ok = false;
                    root.App.Common.log("合成用アイテムの取り出しを中断しました: " +
                        root.App.Common.formatError(error), "orange");
                    // 取り出し元ごとに戻し先の優先順位を作り、順に預け直す
                    function rollback(index) {
                        if (index >= retrieved.length) return Promise.resolve();
                        var entry = retrieved[index];
                        var destinations = [entry.pack];
                        for (var i = 0; i < unfinishedPacks.length; i++) {
                            if (unfinishedPacks[i] !== entry.pack) destinations.push(unfinishedPacks[i]);
                        }
                        // 今回取り出したスロットだけを預け、元から持っていた品は維持する
                        return storeAny(destinations, entry.slot, 0).then(function () { return rollback(index + 1); });
                    }
                    return rollback(0);
                });
        }

        // 不要な端数を預けた後、空き枠の現在値を見ながら各3個組を取り出す
        function organizeUnfinished() {
            var groups = planGroups();
            var excess = [];
            for (var i = 0; i < groups.length; i++) {
                excess = excess.concat(groups[i].held.slice(groups[i].wanted));
            }
            // 全ての預け入れを先に終えてから、取り出し用の空き枠を使う
            return storeSlots(unfinishedPacks, excess, 0).then(function () {
                // 失敗した預け入れで所持数が変わらなかった場合も最新状態で判断する
                function next(index) {
                    if (index >= groups.length) return Promise.resolve();
                    // 今回の組が終わってから次の組へ進む
                    return retrieveGroup(groups[index]).then(function () { return next(index + 1); });
                }
                return next(0);
            });
        }

        var hasAccessory = false;
        var completedSlots = [];
        for (var i = 0; i < character.items.length; i++) {
            if (!isTarget(character.items[i])) continue;
            hasAccessory = true;
            if ((character.items[i].level || 0) > maxLevel) completedSlots.push(i);
        }
        if (!hasAccessory || (unfinished && finished && !unfinished.length && !finished.length)) return Promise.resolve(true);
        if (!Number.isInteger(maxLevel) || maxLevel < 0 || !unfinished || !finished ||
            !unfinished.length || !finished.length) {
            root.App.Common.log("アクセサリ完成・未完成倉庫とmaxCombineLevelの設定を確認してください", "orange");
            return Promise.resolve(false);
        }
        for (var p = 0; p < unfinished.length; p++) {
            if (finished.indexOf(unfinished[p]) >= 0) {
                root.App.Common.log("同じ欄を完成倉庫と未完成倉庫の両方に指定できません: " + unfinished[p], "orange");
                return Promise.resolve(false);
            }
        }
        // 完成品の倉庫が利用できなくても未完成品の整理は続ける
        return Promise.resolve().then(function () {
            if (!completedSlots.length) return;
            // 利用できる全完成倉庫を取得し、指定順に空きのある倉庫へ完成品を預ける
            return loadPacks(finished, finishedPacks, 0).then(function () {
                return storeSlots(finishedPacks, completedSlots, 0);
            });
        // 完成品を預けられない場合は手元に残して次へ進む
        }).catch(function (error) {
            ok = false;
            root.App.Common.log("完成倉庫の整理をスキップしました: " + root.App.Common.formatError(error), "orange");
        // 指定した全未完成倉庫の在庫を集めて、所持品と合わせた3個組の整理を行う
        }).then(function () { return loadPacks(unfinished, unfinishedPacks, 0); })
            // 一つも利用できない場合は、取り出し計画を作らず所持品をそのまま保持する
            .then(function () {
                if (!unfinishedPacks.length) { ok = false; return; }
                return organizeUnfinished();
            })
            // 全処理後も1枠の空きがあることを確認し、確保できない場合は通知する
            .then(function () {
                if (freeSlots() < 1) {
                    ok = false;
                    root.App.Common.log("倉庫に預けられない品が残り、所持品の空き1枠を確保できませんでした", "orange");
                }
                return ok;
            });
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
                types: settings.compoundTypes || settings.accessoryTypes
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

    // 整理ループ用に設定したアイテムを現在地で順に購入し、失敗しても次へ進む
    Items.buyRoutineItems = function (entries) {
        var purchases = Array.isArray(entries) ? entries : [];
        // 購入結果を待ってから次の商品を処理し、購入リクエストの重複を防ぐ
        function purchaseNext(index) {
            if (index >= purchases.length || character.rip) return Promise.resolve();
            var entry = purchases[index];
            var definition = entry && G.items && G.items[entry.itemName];
            var quantity = entry && entry.quantity;
            if (!definition || !Number.isSafeInteger(quantity) || quantity < 1) {
                root.App.Common.log("アイテム整理の購入設定（itemName、quantity）を確認してください", "orange");
                return purchaseNext(index + 1);
            }
            if ((!definition.s && character.esize < quantity) ||
                (typeof definition.g === "number" && character.gold < definition.g * quantity)) {
                root.App.Common.log(entry.itemName + " は空き枠またはgoldが不足しているため購入をスキップします", "orange");
                return purchaseNext(index + 1);
            }
            // 購入APIの同期エラーもPromiseで受け取り、整理処理を止めずに通知する
            return Promise.resolve().then(function () {
                return buy(entry.itemName, quantity);
            // 購入完了を確認し、設定した商品と個数をログへ表示する
            }).then(function (result) {
                if (result && (result.failed || result.success === false)) throw result;
                root.App.Common.log(entry.itemName + " x" + quantity + " を購入しました", "green");
            // 販売場所からの距離などで購入できない場合は理由を表示する
            }).catch(function (error) {
                root.App.Common.log(entry.itemName + " の購入をスキップしました: " +
                    root.App.Common.formatError(error), "orange");
            // 成否にかかわらず次の商品へ進み、全件終了後に整理処理へ戻る
            }).then(function () {
                return purchaseNext(index + 1);
            });
        }
        return purchaseNext(0);
    };

    // 購入・売却・強化・合成を即時実行し、その後は設定した間隔で繰り返す
    Items.startConfiguredRoutine = function (settings) {
        settings = settings || {};
        var interval = Number.isFinite(settings.itemRoutineInterval) && settings.itemRoutineInterval > 0
            ? settings.itemRoutineInterval : CONFIGURED_ROUTINE_INTERVAL;
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
            var merchant = character.ctype === "merchant" && root.App.Merchant && root.App.Merchant.current;
            if (merchant && merchant.busy) return Promise.resolve(false);
            state.inProgress = true;
            if (merchant) merchant.busy = true;
            // 設定分を購入してから整理を実行し、購入品も今回の強化対象に含める
            return Promise.resolve().then(function () {
                return Items.buyRoutineItems(settings.itemRoutinePurchases);
            // 購入の完了後に既存の売却・強化・合成処理へ進む
            }).then(function () {
                return Items.runConfiguredOperations(settings);
            // 商人の整理後は満杯の場合だけ銀行へ往復し、その間も作業中状態を維持する
            }).then(function (ok) {
                if (!merchant) return ok;
                // 銀行処理と通常の整理処理の結果をまとめる
                return merchant.storeMaterialsIfFull().then(function (bankOk) { return ok && bankOk; });
            }).then(function (ok) {
                state.inProgress = false;
                if (merchant) merchant.busy = false;
                root.App.Common.log(ok ? "アイテム処理が完了しました" : "アイテム処理が一部中断しました",
                    ok ? "green" : "orange");
                return ok;
            }, function (error) {
                state.inProgress = false;
                if (merchant) merchant.busy = false;
                throw error;
            });
        }
        root.App.Common.startRoutine({
            id: id,
            interval: interval,
            tasks: [{ name: "アイテム処理", run: run }]
        });
        root.App.Common.log("アイテム整理ループを開始しました（" + interval / 1000 + "秒間隔）", "cyan");
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
