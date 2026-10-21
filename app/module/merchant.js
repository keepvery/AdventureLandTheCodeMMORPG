// 商人モジュールの処理を専用スコープに定義する
(function (root) {
    "use strict";
    root.App = root.App || {};
    var DEFAULT_PONTY_CHECK_INTERVAL = 60 * 1000;

    // 設定を保持する商人処理インスタンスを作成する
    function Merchant(options) {
        this.options = options || {};
        this.busy = false;
        this.referenceLuckAt = 0;
        this.referenceLuckInitialized = false;
    }

    // 共通アイテム機能に設定済みアイテムの売却を依頼する
    Merchant.prototype.sellWhitelistedItems = function () {
        return root.App.Items.sellWhitelist(this.options.sellItems);
    };

    // 開いている露店を閉じる
    Merchant.prototype.closeStand = function () {
        if (character.stand) return close_stand();
    };

    // 定期的な在庫確認を開始する
    Merchant.prototype.startRestockRoutine = function () {
        if (!Array.isArray(this.options.restockItems) || !this.options.restockItems.length) return;
        var self = this;
        root.App.Common.startRestockRoutine({
            id: "merchant-restock-" + character.name,
            items: this.options.restockItems,
            // 商人の他作業中は補充を待ち、補充中はbusy状態にする
            canRun: function () { return !self.busy && character.ctype === "merchant"; },
            onStart: function () {
                self.busy = true;
                root.App.Common.log("商人の在庫補充を開始します", "cyan");
            },
            onFinish: function () { self.busy = false; },
            beforeMove: function () { return self.closeStand(); },
            afterReturn: function () {
                return new Promise(function (resolve) { self.openStandAndStock(resolve); });
            }
        });
    };

    // Pontyの販売一覧を定期確認し、設定した条件を満たす品だけ購入する
    Merchant.prototype.startPontyPurchaseRoutine = function () {
        if (!Array.isArray(this.options.pontyBuyItems) || !this.options.pontyBuyItems.length) return;
        var self = this;
        var interval = this.options.pontyCheckInterval;
        if (!Number.isFinite(interval) || interval <= 0) interval = DEFAULT_PONTY_CHECK_INTERVAL;
        root.App.Common.startRoutine({
            id: "merchant-ponty-" + character.name,
            interval: interval,
            tasks: [{
                name: "Ponty購入",
                // 商人が待機中のときだけPontyの販売品を確認する
                run: function () { return self.purchaseFromPonty(); }
            }]
        });
    };

    // Ponty購入用のホワイトリストをアイテム名ごとの購入上限に変換する
    Merchant.prototype.getPontyBuyLimits = function () {
        var limits = {};
        var entries = this.options.pontyBuyItems || [];
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (!entry || typeof entry.itemName !== "string" || !entry.itemName ||
                !Number.isInteger(entry.maxQuantity) || entry.maxQuantity < 1) {
                root.App.Common.log("Ponty購入設定の itemName と maxQuantity を確認してください（設定番号: " + i + "）", "red");
                continue;
            }
            limits[entry.itemName] = entry.maxQuantity;
        }
        return limits;
    };

    // Pontyの応答から販売アイテム配列を取り出す
    Merchant.prototype.getPontyListings = function (response) {
        if (Array.isArray(response)) return response;
        if (!response || typeof response !== "object") return [];
        if (Array.isArray(response.items)) return response.items;
        if (Array.isArray(response.secondhands)) return response.secondhands;
        if (Array.isArray(response.list)) return response.list;
        return [];
    };

    // Pontyの位置をゲームデータから取得し、未取得時はmainの標準座標を使う
    Merchant.prototype.getPontyPosition = function () {
        var reference = typeof G !== "undefined" && G.maps && G.maps.main && G.maps.main.ref &&
            G.maps.main.ref.secondhands;
        if (Array.isArray(reference) && typeof reference[0] === "number" &&
            typeof reference[1] === "number") {
            return { map: "main", x: reference[0], y: reference[1] };
        }
        if (reference && typeof reference.x === "number" && typeof reference.y === "number") {
            return { map: "main", x: reference.x, y: reference.y };
        }
        return { map: "main", x: 106, y: -47 };
    };

    // 現在地がPontyの販売一覧を取得できる範囲にあるか確認する
    Merchant.prototype.isNearPonty = function (position) {
        if (character.map !== position.map) return false;
        var distanceX = character.x - position.x;
        var distanceY = character.y - position.y;
        return Math.sqrt(distanceX * distanceX + distanceY * distanceY) <= 500;
    };

    // Pontyの販売品についてスタック数を含む購入額をゲーム側と同じ倍率で計算する
    Merchant.prototype.getPontyPurchaseCost = function (item, quantity) {
        if (!item || typeof item.name !== "string" || typeof item_value !== "function") return null;
        var itemData = typeof G !== "undefined" && G.items && G.items[item.name];
        if (!itemData) return null;
        var singleItem = {};
        Object.keys(item).forEach(function (key) {
            if (key !== "q") singleItem[key] = item[key];
        });
        var unitValue = item_value(singleItem);
        if (!Number.isFinite(unitValue) || unitValue < 0) return null;
        return unitValue * (itemData.cash ? 3 : 2) * quantity;
    };

    // Pontyの販売一覧から、所持数上限と最低所持金を守って対象品を順番に購入する
    Merchant.prototype.purchaseFromPonty = function () {
        var self = this;
        var limits = this.getPontyBuyLimits();
        var itemNames = Object.keys(limits);
        var minGold = this.options.pontyMinGold;
        var pontyPosition = this.getPontyPosition();
        if (!itemNames.length || this.busy || character.ctype !== "merchant") return;
        // 配送や回収の移動と競合しないよう、Pontyの範囲外では通信せず次回の確認を待つ
        if (!this.isNearPonty(pontyPosition)) return;
        if (!Number.isInteger(minGold) || minGold < 0) {
            root.App.Common.log("Ponty購入設定の pontyMinGold を0以上の整数で設定してください", "red");
            return;
        }
        if (character.gold <= minGold) return;
        if (typeof get_secondhands !== "function" || typeof buy_secondhand !== "function" ||
            typeof item_value !== "function") {
            root.App.Common.log("Ponty購入に必要なゲームAPIを利用できません", "red");
            return;
        }

        this.busy = true;

        // 販売一覧を取得し、購入後の所持数とgoldを仮計算しながら購入する
        function buyListings() {
            return Promise.resolve(get_secondhands()).then(function (response) {
                if (response && (response.failed || response.success === false)) throw response;
                var listings = self.getPontyListings(response);
                var held = {};
                var remainingGold = character.gold;
                for (var i = 0; i < itemNames.length; i++) {
                    held[itemNames[i]] = root.App.Common.getItemQuantity(itemNames[i]);
                }

                // 販売品を一件ずつ処理し、同じ実行内でも購入上限と所持金を超えないようにする
                function purchaseNext(index) {
                    if (index >= listings.length || !self.isNearPonty(pontyPosition)) return Promise.resolve();
                    var listing = listings[index] || {};
                    var item = listing.item || listing;
                    var itemName = item.name || listing.name;
                    var quantity = item.q || listing.q || listing.quantity || 1;
                    var cost = self.getPontyPurchaseCost(item, quantity);
                    if (!limits[itemName] || listing.rid === undefined || listing.rid === null ||
                        !Number.isFinite(cost) || !Number.isInteger(quantity) || quantity < 1 ||
                        held[itemName] + quantity > limits[itemName] ||
                        remainingGold - cost < minGold) {
                        return purchaseNext(index + 1);
                    }
                    return Promise.resolve(buy_secondhand(listing.rid)).then(function (result) {
                        if (result && (result.failed || result.success === false)) throw result;
                        held[itemName] += quantity;
                        remainingGold -= result && typeof result.cost === "number" ? result.cost : cost;
                        root.App.Common.log("Pontyから " + itemName + " を購入しました", "green");
                    }, function (error) {
                        root.App.Common.log("Pontyから " + itemName + " を購入できませんでした: " +
                            root.App.Common.formatError(error), "orange");
                    }).then(function () {
                        return purchaseNext(index + 1);
                    });
                }
                return purchaseNext(0);
            });
        }

        return Promise.resolve().then(buyListings).then(function () {
            self.busy = false;
        }, function (error) {
            self.busy = false;
            root.App.Common.log("Ponty購入でエラーが発生しました: " +
                root.App.Common.formatError(error), "red");
        });
    };


    // 露店を開き、設定された各出品枠に商品と価格を登録する
    Merchant.prototype.openStandAndStock = function (done) {
        var self = this;
        var standSlot = root.App.Items.findSlot("stand0");
        if (standSlot < 0) {
            root.App.Common.log("stand0 がありません", "red");
            if (done) done(false);
            return;
        }
        if (!character.stand) open_stand(standSlot);

        // 露店の状態が反映されてから、空き枠へ設定商品を順番に出品する
        setTimeout(function () {
            var listings = self.options.standListings || [];
            var usedInventorySlots = [];
            var listed = 0;

            for (var j = 0; j < listings.length; j++) {
                var listing = listings[j];
                if (!listing || typeof listing.slot !== "number" ||
                    listing.slot < 1 || listing.slot > 16 ||
                    typeof listing.itemName !== "string" || !listing.itemName ||
                    typeof listing.price !== "number" || listing.price <= 0 ||
                    (listing.quantity !== undefined && (!Number.isInteger(listing.quantity) || listing.quantity < 1))) {
                    root.App.Common.log("露店出品設定の slot、itemName、price、quantity（省略可）を確認してください（設定番号: " + j + "）", "red");
                    continue;
                }

                var quantity = listing.quantity || 1;
                var tradeSlot = "trade" + listing.slot;
                var existingListing = character.slots && character.slots[tradeSlot];
                if (existingListing) {
                    if (existingListing.name !== listing.itemName) {
                        root.App.Common.log("露店枠 " + listing.slot + " には " + existingListing.name +
                            " が残っています。設定商品 " + listing.itemName + " に変更するには、ゲーム内で既存出品を取り下げてください", "orange");
                    }
                    continue;
                }

                var itemSlot = -1;
                for (var i = 0; i < character.items.length; i++) {
                    var item = character.items[i];
                    if (!item || usedInventorySlots.indexOf(i) >= 0) continue;
                    if (item.name !== listing.itemName) continue;
                    if (item.name === "stand0" || item.name === self.options.compoundScroll) continue;
                    itemSlot = i;
                    break;
                }

                if (itemSlot < 0) {
                    root.App.Common.log("出品アイテム " + listing.itemName + " がありません（露店枠 " + listing.slot + "）", "orange");
                    continue;
                }

                var availableQuantity = character.items[itemSlot].q || 1;
                if (quantity > availableQuantity) {
                    root.App.Common.log("出品アイテム " + listing.itemName + " の所持数が不足しています（指定: " + quantity + "、所持: " + availableQuantity + "）", "orange");
                    continue;
                }

                var itemName = character.items[itemSlot].name;
                trade(itemSlot, listing.slot, listing.price, quantity);
                usedInventorySlots.push(itemSlot);
                root.App.Common.log(itemName + " x" + quantity + " を露店枠 " + listing.slot +
                    " に " + listing.price + " gold で出品しました", "gold");
                listed++;
            }

            if (!listed && !listings.length) {
                root.App.Common.log("config.js に露店出品設定がありません", "orange");
            }
            if (done) done(true);
        }, 600);
    };

    // Merchant's Luck の習得レベルと現在の使用可否を確認する
    Merchant.prototype.canUseLuck = function () {
        var skill = typeof G !== "undefined" && G.skills && G.skills.mluck;
        if (character.ctype !== "merchant" || !skill) return false;
        if (Array.isArray(skill.class) && skill.class.indexOf(character.ctype) < 0) return false;
        if (typeof skill.level === "number" && character.level < skill.level) return false;
        return can_use("mluck");
    };

    // 依頼者の場所へ移動して幸運を付与し、共通の帰還処理を行う
    Merchant.prototype.deliverLuckRequest = function (name, data) {
        var self = this;
        var home = this.options.homePosition;
        if (!data || typeof data.map !== "string" || typeof data.x !== "number" ||
            typeof data.y !== "number" || !home || typeof home.map !== "string" ||
            typeof home.x !== "number" || typeof home.y !== "number") {
            root.App.Common.log("幸運更新依頼またはホームポジションの設定が不正です", "red");
            return;
        }
        if (this.busy) {
            root.App.Common.log("作業中のため幸運更新依頼を保留しました。依頼側の再送を待ちます", "gray");
            return;
        }
        if (!this.canUseLuck()) {
            root.App.Common.log("Merchant's Luck が未習得、または現在使用できません", "orange");
            return;
        }

        this.busy = true;
        var destination = { map: data.map, x: data.x, y: data.y };

        // ゲームのコールバック式・Promise式どちらの移動完了も待つ
        function moveTo(position) {
            return new Promise(function (resolve, reject) {
                var settled = false;
                // 移動結果を一度だけ確定する
                function finish(error) {
                    if (settled) return;
                    settled = true;
                    if (error) reject(error);
                    else resolve();
                }
                try {
                    var movement = smart_move(position, function () { finish(); });
                    if (movement && typeof movement.then === "function") {
                        movement.then(function () { finish(); }, finish);
                    }
                } catch (error) {
                    finish(error);
                }
            });
        }

        // ホームで共通アイテム処理を行い商人を受付状態に戻す
        function returnHome() {
            return moveTo(home).then(function () {
                return new Promise(function (resolve) {
                    self.processAtHome(function () {
                        self.busy = false;
                        resolve();
                    });
                });
            }).then(null, function (error) {
                root.App.Common.log("幸運付与後にホームへ戻れませんでした: " +
                    root.App.Common.formatError(error), "red");
                self.busy = false;
            });
        }

        root.App.Common.log(name + " から幸運更新依頼を受信しました", "cyan");
        Promise.resolve(this.closeStand())
            .then(function () { return moveTo(destination); })
            .then(function () {
                var target = get_player(name);
                var skill = G.skills.mluck;
                var range = Math.max(0, (skill.range || 320) - 20);
                if (!target || target.rip || target.map !== character.map ||
                    parent.distance(character, target) > range) {
                    throw new Error(name + " が付与可能な範囲にいません");
                }
                if (!self.canUseLuck()) throw new Error("Merchant's Luck を現在使用できません");
                return Promise.resolve(use_skill("mluck", name)).then(function (result) {
                    if (result && result.failed) throw result;
                    root.App.Common.log(name + " に Merchant's Luck を付与しました", "green");
                });
            })
            .then(returnHome, function (error) {
                root.App.Common.log("幸運配布でエラーが発生しました: " +
                    root.App.Common.formatError(error), "red");
                return returnHome();
            });
    };
    // 満杯時または手動実行時に銀行でスタック・アクセサリを整理し、ホームで露店を再開する
    Merchant.prototype.storeMaterialsIfFull = function (force) {
        if (character.ctype !== "merchant" || (!force && character.esize !== 0)) return Promise.resolve(true);
        var self = this;
        var home = this.options.homePosition;
        var configuredPacks = this.options.bankDepositPacks;
        if (configuredPacks === undefined) configuredPacks = ["items3"];
        if (!Array.isArray(configuredPacks)) {
            root.App.Common.log("bankDepositPacks は預かり欄IDの配列で設定してください", "red");
            return Promise.resolve(false);
        }
        // 同じ欄への二重訪問を避け、指定順を維持する
        var packs = configuredPacks.filter(function (pack, index, all) {
            return all.indexOf(pack) === index;
        });
        var accessoryPacks = this.options.accessoryUnfinishedBankPack;
        var hasAccessoryPacks = typeof accessoryPacks === "string" ? !!accessoryPacks :
            Array.isArray(accessoryPacks) && accessoryPacks.length > 0;
        if (!packs.length && !force && !hasAccessoryPacks) return Promise.resolve(true);
        if (!home || typeof home.map !== "string" || !Number.isFinite(home.x) ||
            !Number.isFinite(home.y)) {
            root.App.Common.log("homePositionを確認してください", "red");
            return Promise.resolve(false);
        }
        var ok = true;
        var preparedBankMap = null;

        // ゲームデータから預かり欄を操作できる銀行フロアだけを探す
        function getBankMap(pack) {
            if (typeof pack !== "string" || !/^items\d+$/.test(pack)) return null;
            var maps = G.maps || {};
            var mapNames = Object.keys(maps);
            for (var i = 0; i < mapNames.length; i++) {
                var mapName = mapNames[i];
                if (maps[mapName].ignore) continue;
                var npcs = maps[mapName].npcs || [];
                for (var j = 0; j < npcs.length; j++) {
                    var npc = npcs[j];
                    if (npc.id === pack) return mapName;
                }
            }
            return null;
        }

        // マップまたは座標への到着を確認し、長時間終わらない移動は中断する
        function moveTo(position) {
            // タイムアウトも含めて移動結果を一度だけ確定する
            return new Promise(function (resolve, reject) {
                var settled = false;
                // 遅れて届いた移動応答を無視し、待機タイマーを解除する
                function finish(error) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (error) reject(error);
                    else resolve();
                }
                // 移動が永久待機した場合でも銀行処理から帰還処理へ進める
                var timer = setTimeout(function () {
                    if (settled) return;
                    try { stop("move"); } catch (error) { /* 停止できなくても待機は終了する */ }
                    finish(new Error(position.map + " への移動が90秒以内に完了しませんでした"));
                }, 90 * 1000);
                // Promiseを返すゲームの移動APIへ処理を委譲する
                Promise.resolve().then(function () {
                    if (character.rip) throw new Error("死亡中のため銀行への往復を中断しました");
                    return smart_move(position);
                // マップのみの指定ではNPC座標へ向かわず、銀行入場だけを確認する
                }).then(function (result) {
                    if (result && (result.failed || result.success === false)) throw result;
                    var hasPosition = Number.isFinite(position.x) && Number.isFinite(position.y);
                    if (character.map !== position.map ||
                        (hasPosition && parent.distance(character, position) > 80)) {
                        throw new Error(position.map + " の目的地へ到着できませんでした");
                    }
                    finish();
                // 同期例外と移動失敗の両方を呼び出し元へ伝える
                }).catch(finish);
            });
        }

        // 銀行へ入ったら一度だけ少し上へ進み、入口付近で立ち止まらないようにする
        function stepAside(mapName) {
            var distances = [50, 30, 15];
            for (var i = 0; i < distances.length; i++) {
                var x = character.x;
                var y = character.y - distances[i];
                if (can_move_to(x, y)) return moveTo({ map: mapName, x: x, y: y });
            }
            // 上に壁がある場合は無理に経路探索せず、現在位置で整理する
            return Promise.resolve();
        }

        // 銀行入場後のデータ反映を最大10秒待ち、未解放の欄は自動購入しない
        function waitForBank(pack, mapName) {
            var deadline = Date.now() + 10000;
            // 指定の欄を読み取れるまで短い間隔で確認する
            return new Promise(function (resolve, reject) {
                // データ取得後は待機を終え、取得できないままの永久待機を防ぐ
                function check() {
                    if (character.rip || character.map !== mapName) {
                        reject(new Error("銀行から離れたため預け入れを中断しました"));
                    } else if (character.bank && Array.isArray(character.bank[pack])) {
                        resolve();
                    } else if (Date.now() >= deadline) {
                        reject(new Error("預かり欄（" + pack + "）が未解放、または取得できません"));
                    } else {
                        setTimeout(check, 250);
                    }
                }
                check();
            });
        }

        // 同じ銀行フロアの欄はその場で操作し、別フロアの場合だけ入場し直す
        function visitPack(pack) {
            var mapName = getBankMap(pack);
            if (!mapName) return Promise.reject(new Error("預かり欄の銀行フロアが見つかりません: " + pack));
            if (character.map === mapName && preparedBankMap === mapName) return waitForBank(pack, mapName);
            // 既に銀行内にいる場合は入口や預かり係へ移動せず、その場から少しだけ上へ進む
            return Promise.resolve().then(function () {
                if (character.map !== mapName) return moveTo({ map: mapName });
            // 入場地点から歩ける範囲で入口を避ける
            }).then(function () { return stepAside(mapName); })
                // 同じフロアでは二度目以降の欄切り替えで移動しない
                .then(function () {
                    preparedBankMap = mapName;
                    return waitForBank(pack, mapName);
                });
        }

        // 空き枠ができても指定された残りの欄を回り、各欄に重ねられる品をすべて確認する
        function processPack(index) {
            if (index >= packs.length) return Promise.resolve();
            var pack = packs[index];
            // 対象の銀行フロアで、その欄の読み込みを待つ
            return visitPack(pack)
                // この欄の既存スタックと重ねられる所持品だけを預ける
                .then(function () { return root.App.Items.storeMatchingBankStacks(pack); })
                // 個別の欄の失敗を記録して、他の欄の処理は継続する
                .then(function (result) { if (!result) ok = false; }, function (error) {
                    ok = false;
                    root.App.Common.log(pack + " への預け入れを中断しました: " +
                        root.App.Common.formatError(error), "orange");
                })
                // 預け入れ後のインベントリで次の預かり欄を確認する
                .then(function () { return processPack(index + 1); });
        }

        root.App.Common.log(force ? "銀行のアイテム整理を開始します" :
            "持ち物が満杯のため、銀行へアイテムを整理しに行きます", "cyan");
        // 露店を閉じてから指定順に銀行の預かり欄を操作する
        return Promise.resolve().then(function () { return self.closeStand(); })
            // 全預かり欄の確認を開始する
            .then(function () { return processPack(0); })
            // スタックの預け入れ後に完成品・未完成品を整理して合成用の組を取り出す
            .then(function () { return root.App.Items.organizeBankAccessories(self.options, visitPack); })
            // アクセサリ整理の結果も全体の成否に反映する
            .then(function (result) { if (!result) ok = false; })
            // 銀行処理に失敗した場合は理由を表示して帰還へ進む
            .catch(function (error) {
                ok = false;
                root.App.Common.log("銀行への預け入れを中断しました: " +
                    root.App.Common.formatError(error), "orange");
            })
            // 預けられる品がない場合や預け入れ失敗時もホームへ帰還する
            .then(function () { return moveTo(home); })
            // 帰還できた場合だけ露店を開き、設定商品を再出品する
            .then(function () {
                // 出品処理の完了通知をPromiseへ変換して待つ
                return new Promise(function (resolve) { self.openStandAndStock(resolve); });
            })
            // 露店準備の失敗も含めた結果を呼び出し元へ返す
            .then(function (standOk) { return ok && standOk !== false; });
    };

    // Bボタンから銀行整理を単発実行し、商人の他作業との競合と連打を防ぐ
    Merchant.prototype.organizeBank = function () {
        var self = this;
        if (this.busy || character.rip) {
            root.App.Common.log("作業中または死亡中のため銀行整理を開始できません", "orange");
            return Promise.resolve(false);
        }
        this.busy = true;
        // 手動実行は持ち物の空き枠にかかわらず銀行へ向かう
        return Promise.resolve().then(function () { return self.storeMaterialsIfFull(true); })
            // 帰還と露店再開が終わったら受付状態へ戻す
            .then(function (ok) {
                self.busy = false;
                root.App.Common.log(ok ? "銀行整理が完了しました" : "銀行整理が一部中断しました",
                    ok ? "green" : "orange");
                return ok;
            // 移動失敗時にもbusyを解放してエラーを通知する
            }, function (error) {
                self.busy = false;
                root.App.Common.log("銀行整理に失敗しました: " + root.App.Common.formatError(error), "red");
                return false;
            });
    };

    // ホーム帰還後に露店準備、売却、強化、合成、必要時の銀行往復を実行する
    Merchant.prototype.processAtHome = function (done) {
        var self = this;
        var wasBusy = this.busy;
        this.busy = true;
        // 全処理の完了後に作業中状態を戻し、呼び出し元へ一度だけ通知する
        function finish(ok) {
            self.busy = wasBusy;
            if (done) done(ok);
        }
        // 露店の初期化後に共通アイテム処理を開始する
        this.openStandAndStock(function () {
            // 売却・強化・合成の完了後に銀行への預け入れを確認する
            root.App.Items.runConfiguredOperations(self.options, function () {
                // 整理完了後も満杯であれば銀行往復を待ってから受付状態へ戻す
                self.storeMaterialsIfFull().then(function (ok) {
                    set_message("Open Stand (Idle)");
                    root.App.Common.log(ok ? "ホームでのアイテム整理が完了し、露店で待機します" :
                        "ホームでのアイテム整理が一部中断しました", ok ? "green" : "orange");
                    finish(ok);
                // 帰還に失敗した場合もbusyを解放し、次回の依頼を受け付けられるようにする
                }, function (error) {
                    root.App.Common.log("銀行からホームへ戻れませんでした: " +
                        root.App.Common.formatError(error), "red");
                    finish(false);
                });
            });
        });
    };

    // 要求された品の所持数を確認し、依頼者へ届けてからホームへ戻る
    Merchant.prototype.deliverRequestedItems = function (name, data) {
        var self = this;
        var home = this.options.homePosition;
        if (typeof data.map !== "string" || typeof data.x !== "number" ||
            typeof data.y !== "number" || !Array.isArray(data.items) ||
            !home || typeof home.map !== "string" ||
            typeof home.x !== "number" || typeof home.y !== "number") {
            root.App.Common.log("アイテム受け渡し依頼またはホームポジションの設定が不正です", "red");
            return;
        }
        if (this.busy) {
            root.App.Common.log("作業中のためアイテム受け渡し依頼をスキップしました", "gray");
            return;
        }

        // 商人の所持品から要求数を満たす商品だけを配送対象にする
        var deliveries = data.items.filter(function (entry) {
            if (!entry || typeof entry.itemName !== "string" ||
                !Number.isInteger(entry.quantity) || entry.quantity < 1) return false;
            var held = root.App.Common.getItemQuantity(entry.itemName);
            if (held < entry.quantity) {
                root.App.Common.log(entry.itemName + " が不足しています（必要: " +
                    entry.quantity + "、所持: " + held + "）", "orange");
                return false;
            }
            return true;
        });
        if (!deliveries.length) {
            root.App.Common.log(name + " への依頼品を必要数所持していないため配送できません", "orange");
            return;
        }

        this.busy = true;

        // 依頼者の場所へ移動して、指定された商品を順番に送る
        function sendDeliveries(index) {
            if (index >= deliveries.length) return Promise.resolve();
            var delivery = deliveries[index];
            var remaining = delivery.quantity;
            var usedSlots = [];

            // 複数スタックに分かれた場合も要求数を満たすまで順番に送る
            function sendStack() {
                if (remaining <= 0) {
                    root.App.Common.log(name + " に " + delivery.itemName +
                        " x" + delivery.quantity + " を渡しました", "green");
                    return sendDeliveries(index + 1);
                }
                var slot = -1;
                for (var i = 0; i < character.items.length; i++) {
                    if (character.items[i] && character.items[i].name === delivery.itemName &&
                        usedSlots.indexOf(i) < 0) {
                        slot = i;
                        break;
                    }
                }
                if (slot < 0) throw new Error(delivery.itemName + " の配送中に所持数が不足しました");
                var stackQuantity = character.items[slot].q || 1;
                var sendQuantity = Math.min(remaining, stackQuantity);
                usedSlots.push(slot);
                remaining -= sendQuantity;
                return Promise.resolve(send_item(name, slot, sendQuantity)).then(function (result) {
                    if (result && result.failed) throw result;
                    return sendStack();
                });
            }
            return sendStack();
        }

        // ゲームのコールバック式またはPromise式の移動完了を待つ
        function moveTo(position) {
            return new Promise(function (resolve, reject) {
                var settled = false;

                // 移動結果を一度だけ確定する
                function finish(error) {
                    if (settled) return;
                    settled = true;
                    if (error) reject(error);
                    else resolve();
                }

                try {
                    // ゲームの移動完了コールバックは成功値を渡す場合があるため引数をエラー扱いしない
                    var movement = smart_move(position, function () { finish(); });
                    if (movement && typeof movement.then === "function") {
                        movement.then(function () { finish(); }, finish);
                    }
                } catch (error) {
                    finish(error);
                }
            });
        }

        // 配送後はホームへ帰り、露店を元の待機状態へ戻す
        function returnHome(error) {
            if (error) root.App.Common.log("アイテム配送に失敗しました: " +
                root.App.Common.formatError(error), "red");
            return moveTo(home).then(function () {
                return new Promise(function (resolve) {
                    self.processAtHome(function () {
                        self.busy = false;
                        resolve();
                    });
                });
            }, function (moveError) {
                root.App.Common.log("配送後にホームへ戻れませんでした: " +
                    root.App.Common.formatError(moveError), "red");
                self.busy = false;
            }).then(function () {
                if (self.busy) self.busy = false;
            });
        }

        root.App.Common.log(name + " へアイテムを届けます", "cyan");
        Promise.resolve(this.closeStand()).then(function () {
            return moveTo({ map: data.map, x: data.x, y: data.y });
        }).then(function () { return sendDeliveries(0); })
            .then(function () { return returnHome(); }, returnHome);
    };

    // 指定キャラクターからの回収依頼を検証し、商人作業を順番に実行する
    Merchant.prototype.onCM = function (name, data) {
        var self = this;
        var allowedSenders = root.App.Common.getAllowedSenders();
        if (data && data.task === "deliver_items" && allowedSenders.indexOf(name) < 0) {
            root.App.Common.log("許可されていないキャラクターからの補充依頼を無視しました: " + name, "orange");
            return;
        }
        if (allowedSenders.indexOf(name) >= 0 && data && data.task === "request_luck") {
            this.deliverLuckRequest(name, data);
            return;
        }
        if (allowedSenders.indexOf(name) >= 0 && data && data.task === "deliver_items") {
            root.App.Common.log(name + " から不足アイテム依頼を受信しました", "cyan");
            this.deliverRequestedItems(name, data);
            return;
        }
        if (allowedSenders.indexOf(name) < 0 || !data || data.task !== "loot_me") return;
        if (this.busy) {
            root.App.Common.log("作業中のため要請をスキップしました", "gray");
            return;
        }
        if (typeof data.map !== "string" || typeof data.x !== "number" || typeof data.y !== "number") {
            root.App.Common.log("回収位置が不正です", "red");
            return;
        }
        // config.js のホーム位置がない場合は移動処理を始めない
        var home = this.options.homePosition;
        if (!home || typeof home.map !== "string" || typeof home.x !== "number" || typeof home.y !== "number") {
            root.App.Common.log("config.js にホームポジション（map、x、y）を設定してください", "red");
            return;
        }
        this.busy = true;

        // 一連の回収処理が終わったときに受付状態へ戻す
        function finish() {
            self.busy = false;
        }

        this.closeStand();
        set_message("Moving to " + name);

        // 依頼者の位置へ移動し、受け取り待機後に町へ帰る
        smart_move({ map: data.map, x: data.x, y: data.y }, function () {
            set_message("Collecting...");

            // アイテム受け取り時間を確保してから帰還する
            setTimeout(function () {
                set_message("Returning...");

                // ホーム帰還後の共通アイテム整理処理を実行する
                smart_move(home, function () {
                    self.processAtHome(finish);
                });
            }, self.options.pickupDelay);
        });
    };

    // 設定を使って商人処理インスタンスを生成する
    root.App.Merchant = {
        // 商人処理インスタンスを生成する
        create: function (options) {
            var merchant = new Merchant(options);
            root.App.Merchant.current = merchant;
            return merchant;
        }
    };
})(window);
