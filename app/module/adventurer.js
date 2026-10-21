// 冒険キャラクターの戦闘と商人連携を専用スコープに定義する
(function (root) {
    "use strict";
    root.App = root.App || {};

    // 冒険者の戦闘・商人連携設定と実行状態を保持する
    function Adventurer(settings) {
        this.settings = settings || {};
        this.routinePrefix = this.settings.routineId ||
            "adventurer-" + ((typeof character !== "undefined" && character.name) || "unknown");
        this.combat = root.App.Combat
            ? root.App.Combat.create(this.settings.combat || {}) : null;
        this.callingMerchant = false;
        this.lastMerchantCallTime = 0;
        this.merchantRequestType = null;
        this.deliveryInProgress = false;
        this.deliveryRetryAfter = 0;
        this.lastLuckRequestTime = 0;
    }

    // 手元に確保する最低goldを差し引き、超過分だけを設定された商人へ送る
    Adventurer.prototype.deliverGold = function () {
        var reserve = this.settings.deliveryGoldReserve;
        var merchantName = this.settings.merchantCharacter;
        if (character.ctype === "merchant" || !merchantName || merchantName === character.name) return;
        // 未設定・負数・小数などの不正設定では自動送金を行わない
        if (!Number.isSafeInteger(reserve) || reserve < 0 || !Number.isFinite(character.gold)) return;
        var amount = Math.floor(character.gold - reserve);
        if (amount <= 0) return;

        // goldの送信結果を待ち、失敗はアイテム受け渡しと共通のエラー処理へ渡す
        return send_gold(merchantName, amount).then(function (result) {
            if (result && (result.failed || result.success === false)) throw result;
            root.App.Common.log(amount + " gold を商人に渡しました", "green");
            return result;
        });
    };

    // 超過goldと対象アイテムを商人へ順番に送り、完了状態を更新する
    Adventurer.prototype.deliverItems = function () {
        if (this.deliveryInProgress) return;
        var self = this;
        var blacklist = this.settings.deliveryBlacklist || [];
        var blacklistedSlots = this.settings.deliveryBlacklistSlots || [];
        var slots = [];
        for (var i = 0; i < character.items.length; i++) {
            var item = character.items[i];
            if (item && blacklist.indexOf(item.name) < 0 &&
                blacklistedSlots.indexOf(i + 1) < 0) slots.push(i);
        }

        this.deliveryInProgress = true;
        // 送信結果を待ちながら次の対象アイテムを順番に渡す
        function sendNext(index) {
            if (index >= slots.length) {
                return true;
            }
            var slot = slots[index];
            var item = character.items[slot];
            if (!item || blacklist.indexOf(item.name) >= 0 ||
                blacklistedSlots.indexOf(slot + 1) >= 0) return sendNext(index + 1);
            var itemName = item.name;
            // 現在のアイテムの送信結果を記録して次のアイテムへ進む
            return send_item(self.settings.merchantCharacter, slot, item.q || 1).then(function (result) {
                if (result && result.failed) throw result;
                root.App.Common.log(itemName + " を商人に渡しました", "green");
                return sendNext(index + 1);
            });
        }

        // インベントリの空きに依存しないgoldを先に送り、応答後にアイテム送信へ進む
        return Promise.resolve().then(function () {
            return self.deliverGold();
        }).then(function () {
            return sendNext(0);
        }).then(function (result) {
            // 全送信の完了後に次の受け渡しを受け付けられる状態へ戻す
            self.deliveryInProgress = false;
            self.callingMerchant = false;
            self.merchantRequestType = null;
            return result;
        }, function (error) {
            // 送信失敗後に再試行できるよう連携状態を解除する
            self.deliveryInProgress = false;
            self.callingMerchant = false;
            self.merchantRequestType = null;
            var reason = error && (error.reason || error.response || error.message);
            if (String(reason || error).toLowerCase().indexOf("send_no_space") >= 0) {
                self.deliveryRetryAfter = Date.now() + root.App.Common.DELIVERY_RETRY_INTERVAL;
                root.App.Common.log("商人のインベントリに空きがないため受け渡しを中断しました。" +
                    Math.ceil(root.App.Common.DELIVERY_RETRY_INTERVAL / 60000) + "分後に再試行します", "orange");
                return false;
            }
            throw error;
        });
    };

    // 幸運の残り時間が5分以下なら商人へ更新を依頼し、再送間隔を守る
    Adventurer.prototype.requestLuckIfNeeded = function () {
        var settings = this.settings;
        var merchantName = settings.merchantCharacter;
        if (!settings.requestLuck || !merchantName) return;
        var now = Date.now();
        var retryInterval = root.App.Common.DELIVERY_RETRY_INTERVAL;
        if (now - this.lastLuckRequestTime < retryInterval) return;
        var luck = character.s && character.s.mluck;
        if (luck && typeof luck.ms === "number" && luck.ms > retryInterval) return;

        this.lastLuckRequestTime = now;
        root.App.Common.log("Merchant's Luck の更新を商人へ依頼します: " + merchantName, "yellow");
        // 商人が受付可能になるまで同じ依頼を再送できるよう現在地を伝える
        return send_cm(merchantName, {
            task: "request_luck",
            map: character.map,
            x: character.x,
            y: character.y
        }).then(function (result) {
            var receivers = result && Array.isArray(result.receivers) ? result.receivers : [];
            if (receivers.indexOf(merchantName) < 0) {
                root.App.Common.log("商人への幸運更新依頼が届きませんでした: " + merchantName, "orange");
                return;
            }
            root.App.Common.log("商人へ幸運更新を依頼しました: " + merchantName, "cyan");
        }, function (error) {
            root.App.Common.log("幸運更新依頼の送信に失敗しました: " +
                root.App.Common.formatError(error), "orange");
        });
    };
    // 空き枠を監視して商人を呼び、近くに来たら超過goldと対象アイテムを渡す
    Adventurer.prototype.monitorMerchant = function () {
        var self = this;
        var settings = this.settings;
        var merchantName = settings.merchantCharacter;
        var now = Date.now();
        if (now < this.deliveryRetryAfter) return;
        var requestItems = Array.isArray(settings.requestItems) ? settings.requestItems : [];
        // 設定したアイテムの所持数が受け取り閾値以下か調べる
        var neededItems = requestItems.filter(function (entry) {
            return entry && typeof entry.itemName === "string" &&
                Number.isInteger(entry.threshold) && entry.threshold >= 0 &&
                Number.isInteger(entry.quantity) && entry.quantity > 0 &&
                root.App.Common.getItemQuantity(entry.itemName) <= entry.threshold;
        });
        var timeout = typeof settings.merchantTimeout === "number" && settings.merchantTimeout > 0
            ? settings.merchantTimeout : 5 * 60 * 1000;
        if (this.callingMerchant && now - this.lastMerchantCallTime >= timeout) {
            root.App.Common.log("商人の呼び出しがタイムアウトしたため、再要請できる状態に戻します", "orange");
            this.callingMerchant = false;
            this.lastMerchantCallTime = 0;
            this.merchantRequestType = null;
        }

        if (requestItems.length) {
            if (!neededItems.length) {
                // 補充依頼だけを解除し、別タスクの商人呼び出し状態は保持する
                if (this.merchantRequestType === "deliver_items") {
                    this.callingMerchant = false;
                    this.lastMerchantCallTime = 0;
                    this.merchantRequestType = null;
                    return;
                }
            } else {
                if (this.callingMerchant || this.deliveryInProgress) return;
                this.callingMerchant = true;
                this.lastMerchantCallTime = now;
                this.merchantRequestType = "deliver_items";
                root.App.Common.log("不足アイテムを商人に依頼します", "yellow");
                // 閾値以下の商品名と受け取り数、現在位置を商人へ送信する
                return send_cm(merchantName, {
                    task: "deliver_items",
                    // 必要な設定から商品名と受け取り数だけを依頼データにする
                    items: neededItems.map(function (entry) {
                        return { itemName: entry.itemName, quantity: entry.quantity };
                    }),
                    map: character.map,
                    x: character.x,
                    y: character.y
                }).then(function (result) {
                    var receivers = result && Array.isArray(result.receivers) ? result.receivers : [];
                    if (receivers.indexOf(merchantName) < 0) {
                        self.callingMerchant = false;
                        self.lastMerchantCallTime = 0;
                        self.merchantRequestType = null;
                        root.App.Common.log("商人への不足アイテム依頼が届きませんでした: " + merchantName, "red");
                        return;
                    }
                    root.App.Common.log("商人へ不足アイテムを依頼しました: " + merchantName, "cyan");
                }, function (error) {
                    self.callingMerchant = false;
                    self.lastMerchantCallTime = 0;
                    self.merchantRequestType = null;
                    throw error;
                });
            }
        }

        var merchant = get_player(merchantName);
        if (merchant && merchant.map === character.map &&
            parent.distance(character, merchant) < settings.merchantDistance) {
            if (this.deliveryInProgress) return;
            if (this.merchantRequestType === "deliver_items") return;
            this.callingMerchant = false;
            return this.deliverItems();
        }

        if (character.esize <= settings.merchantCallThreshold && !this.callingMerchant) {
            this.callingMerchant = true;
            this.lastMerchantCallTime = now;
            this.merchantRequestType = "loot_me";
            root.App.Common.log("商人を呼び出します: " + merchantName, "yellow");
            // 呼び出し送信に失敗したら次回監視で再要請できるよう状態を戻す
            return send_cm(merchantName, {
                task: "loot_me",
                map: character.map,
                x: character.x,
                y: character.y
            }).then(null, function (error) {
                self.callingMerchant = false;
                self.lastMerchantCallTime = 0;
                self.merchantRequestType = null;
                throw error;
            });
        }
    };

    // キャラクターメッセージの戦闘連携を戦闘モジュールへ渡す
    Adventurer.prototype.onCM = function (name, data) {
        if (this.combat) this.combat.onCM(name, data);
    };

    // 回復・回収・戦闘・商人連携の共通ループを開始する
    Adventurer.prototype.start = function () {
        var settings = this.settings;
        var self = this;
        root.App.Common.startRoutine({
            id: this.routinePrefix + "-maintenance",
            interval: settings.routineInterval || 250,
            // 基本タスク（回復、アイテム回収）
            tasks: root.App.Common.createMaintenanceTasks()
        });
        if (this.combat) {
            if (root.App.MonsterHunt) root.App.MonsterHunt.attach(this.combat, settings.monsterHunt, this);
            this.combat.start();
        }
        if (settings.merchantCharacter) {
            root.App.Common.startRoutine({
                id: this.routinePrefix + "-merchant",
                interval: settings.merchantCheckInterval || 1000,
                tasks: [{
                    name: "商人連携",
                    // 商人への要請とgold・アイテムの受け渡しを確認する
                    run: function () { return self.monitorMerchant(); }
                }, {
                    name: "幸運更新依頼",
                    // 幸運の残り時間に応じて商人へ更新を依頼する
                    run: function () { return self.requestLuckIfNeeded(); }
                }]
            });
        }
    };

    // 冒険者が開始した各共通ループを停止する
    Adventurer.prototype.stop = function () {
        if (root.App.MonsterHunt) root.App.MonsterHunt.detach();
        root.App.Common.stopRoutine(this.routinePrefix + "-maintenance");
        if (this.combat) this.combat.stop();
        root.App.Common.stopRoutine(this.routinePrefix + "-merchant");
    };

    // 設定から冒険者インスタンスを生成する
    root.App.Adventurer = {
        // 冒険者の実行状態を持つインスタンスを作成する
        create: function (settings) {
            return new Adventurer(settings);
        }
    };
})(window);
