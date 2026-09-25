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

    // ホーム帰還後に露店準備、売却、強化、合成を共通の順序で実行する
    Merchant.prototype.processAtHome = function (done) {
        var self = this;
        // 露店の初期化後に売却、強化、合成を続ける
        this.openStandAndStock(function () {
            self.sellWhitelistedItems();
            // 強化が完了したら設定済みアイテムの合成を始める
            root.App.Items.upgradeWhitelist(self.options.upgradeItems, function (upgradeOk) {
                if (!upgradeOk) root.App.Common.log("装備強化を中断しました", "orange");
                root.App.Items.compoundAll({
                    maxLevel: self.options.maxCombineLevel,
                    scrollName: self.options.compoundScroll
                // 合成終了後にホーム待機状態を通知し、呼び出し元へ完了を返す
                }, function () {
                    set_message("Open Stand (Idle)");
                    root.App.Common.log("ホームでのアイテム整理が完了し、露店で待機します", "green");
                    if (done) done();
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
        if (!deliveries.length) return;

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
        if (allowedSenders.indexOf(name) >= 0 && data && data.task === "deliver_items") {
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
            return new Merchant(options);
        }
    };
})(window);
