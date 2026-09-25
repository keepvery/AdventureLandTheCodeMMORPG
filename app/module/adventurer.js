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
        this.deliveryInProgress = false;
    }

    // 設定されたアイテムを商人へ順番に送り、完了状態を更新する
    Adventurer.prototype.deliverItems = function () {
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
                self.deliveryInProgress = false;
                self.callingMerchant = false;
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

        // 送信失敗後に再試行できるよう連携状態を解除する
        return Promise.resolve(sendNext(0)).then(null, function (error) {
            self.deliveryInProgress = false;
            self.callingMerchant = false;
            throw error;
        });
    };

    // 空き枠を監視して商人を呼び、近くに来たら対象アイテムを渡す
    Adventurer.prototype.monitorMerchant = function () {
        var self = this;
        var settings = this.settings;
        var merchantName = settings.merchantCharacter;
        var now = Date.now();
        if (this.callingMerchant && now - this.lastMerchantCallTime > settings.merchantTimeout) {
            root.App.Common.log("商人の呼び出しがタイムアウトしたため、再要請できる状態に戻します", "orange");
            this.callingMerchant = false;
            this.lastMerchantCallTime = 0;
        }

        var merchant = get_player(merchantName);
        if (merchant && merchant.map === character.map &&
            parent.distance(character, merchant) < settings.merchantDistance) {
            if (this.deliveryInProgress) return;
            this.callingMerchant = false;
            return this.deliverItems();
        }

        if (character.esize <= settings.merchantCallThreshold && !this.callingMerchant) {
            this.callingMerchant = true;
            this.lastMerchantCallTime = now;
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
                throw error;
            });
        }
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
        if (this.combat) this.combat.start();
        if (settings.merchantCharacter) {
            root.App.Common.startRoutine({
                id: this.routinePrefix + "-merchant",
                interval: settings.merchantCheckInterval || 1000,
                tasks: [{
                    name: "商人連携",
                    // 商人への要請とアイテム受け渡しを確認する
                    run: function () { return self.monitorMerchant(); }
                }]
            });
        }
    };

    // 冒険者が開始した各共通ループを停止する
    Adventurer.prototype.stop = function () {
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
