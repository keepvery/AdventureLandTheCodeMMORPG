// 商人モジュールの処理を専用スコープに定義する
(function (root) {
    "use strict";
    root.App = root.App || {};

    // 設定を保持する商人処理インスタンスを作成する
    function Merchant(options) {
        this.options = options || {};
        this.busy = false;
    }

    // 共通アイテム機能に設定済みアイテムの売却を依頼する
    Merchant.prototype.sellWhitelistedItems = function () {
        return root.App.Items.sellWhitelist(this.options.sellItems);
    };

    // 開いている露店を閉じる
    Merchant.prototype.closeStand = function () {
        if (character.stand) close_stand();
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
                    typeof listing.price !== "number" || listing.price <= 0) {
                    root.App.Common.log("露店出品設定が不正です（設定番号: " + j + "）", "red");
                    continue;
                }

                var tradeSlot = "trade" + listing.slot;
                if (character.slots && character.slots[tradeSlot]) continue;

                var itemSlot = -1;
                for (var i = 0; i < character.items.length; i++) {
                    var item = character.items[i];
                    if (!item || usedInventorySlots.indexOf(i) >= 0) continue;
                    if (item.name === "stand0" || item.name === self.options.compoundScroll) continue;
                    itemSlot = i;
                    break;
                }

                if (itemSlot < 0) {
                    root.App.Common.log("出品できるアイテムがなくなりました", "orange");
                    break;
                }

                var itemName = character.items[itemSlot].name;
                trade(itemSlot, listing.slot, listing.price, 1);
                usedInventorySlots.push(itemSlot);
                root.App.Common.log(itemName + " を露店枠 " + listing.slot +
                    " に " + listing.price + " gold で出品しました", "gold");
                listed++;
            }

            if (!listed && !listings.length) {
                root.App.Common.log("config.js に露店出品設定がありません", "orange");
            }
            if (done) done(true);
        }, 600);
    };

    // 指定キャラクターからの回収依頼を検証し、商人作業を順番に実行する
    Merchant.prototype.onCM = function (name, data) {
        var self = this;
        var allowedSenders = root.App.Common.getAllowedSenders();
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

                // 町への帰還後に露店、売却、強化、合成を順に実行する
                smart_move(home, function () {
                    // 露店の初期化が終わってから売却・強化・合成を始める
                    self.openStandAndStock(function () {
                        self.sellWhitelistedItems();
                        // 強化完了後に合成処理へ進む
                        root.App.Items.upgradeWhitelist(self.options.upgradeItems, function (upgradeOk) {
                            if (!upgradeOk) root.App.Common.log("装備強化を中断しました", "orange");
                            root.App.Items.compoundAll({
                                maxLevel: self.options.maxCombineLevel,
                                scrollName: self.options.compoundScroll
                                // 合成完了後に待機状態へ戻す
                            }, function () {
                                set_message("Open Stand (Idle)");
                                root.App.Common.log("露店を開いて次回要請まで待機します", "green");
                                finish();
                            });
                        });
                    });
                });
            }, self.options.pickupDelay);
        });
    };

    // 設定を使って商人処理インスタンスを生成する
    root.App.Merchant = {
        // 商人処理インスタンスを生成する
        create: function (options) {
            return new Merchant(options);
        }
    };
})(window);
