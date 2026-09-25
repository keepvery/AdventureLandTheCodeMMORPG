// キャラクターの戦闘対象選択と位置戦略を専用スコープに定義する
(function (root) {
    "use strict";
    root.App = root.App || {};

    // 戦闘条件と巡回位置を保持する戦闘コントローラーを作成する
    function Combat(options) {
        this.settings = options || {};
        this.positionIndex = 0;
        this.positionArrivalIndex = -1;
        this.positionStayUntil = 0;
        this.routineId = this.settings.routineId ||
            "combat-" + ((typeof character !== "undefined" && character.name) || "unknown");
    }

    // 対象が生存中で設定した経験値・攻撃力条件を満たすか調べる
    Combat.prototype.isEligible = function (target) {
        var settings = this.settings;
        if (!target || target.type !== "monster" || target.dead || !target.visible) return false;
        if (typeof settings.minMonsterXp === "number" && target.xp < settings.minMonsterXp) return false;
        if (typeof settings.maxMonsterAttack === "number" && target.attack > settings.maxMonsterAttack) return false;
        return true;
    };

    // 条件に合う現在の対象か最寄りのモンスターを取得する
    Combat.prototype.findTarget = function (requireRange) {
        var current = get_targeted_monster();
        if (this.isEligible(current) && (!requireRange || is_in_range(current))) return current;
        var entities = parent.entities || {};
        var nearest = null;
        var nearestDistance = Infinity;
        for (var id in entities) {
            var candidate = entities[id];
            if (!this.isEligible(candidate)) continue;
            if (requireRange && !is_in_range(candidate)) continue;
            var distance = parent.distance(character, candidate);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearest = candidate;
            }
        }
        return nearest;
    };

    // 選択したモンスターを攻撃可能な場合に攻撃する
    Combat.prototype.attackTarget = function (target) {
        if (!target) {
            set_message("No Monsters");
            return;
        }
        if (get_targeted_monster() !== target) change_target(target);
        if (!can_attack(target)) return;
        set_message("Attacking");
        return attack(target);
    };

    // 定位置を維持し、現在射程内にいるモンスターだけを攻撃する
    Combat.prototype.runStationary = function () {
        return this.attackTarget(this.findTarget(true));
    };

    // 射程外の対象へ少しずつ近づき、射程内に入ったら攻撃する
    Combat.prototype.runApproach = function () {
        var target = this.findTarget(false);
        if (!target) {
            set_message("No Monsters");
            return;
        }
        if (is_in_range(target)) return this.attackTarget(target);
        var nextX = character.x + (target.x - character.x) / 2;
        var nextY = character.y + (target.y - character.y) / 2;
        set_message("Moving to Target");
        return move(nextX, nextY);
    };

    // 設定した複数の定位置を順番に巡回し、各位置で敵を攻撃する
    Combat.prototype.runRotation = function () {
        var settings = this.settings;
        var positions = settings.positions || [];
        if (!positions.length) {
            set_message("No Combat Positions");
            return;
        }
        var position = positions[this.positionIndex % positions.length];
        if (!position || typeof position.x !== "number" || typeof position.y !== "number" ||
            typeof position.map !== "string") {
            set_message("Invalid Combat Position");
            return;
        }
        var distance = position.map === character.map
            ? parent.distance(character, position) : Infinity;
        var arrivalDistance = typeof settings.arrivalDistance === "number"
            ? settings.arrivalDistance : 40;
        if (distance > arrivalDistance) {
            this.positionArrivalIndex = -1;
            set_message("Moving to Position " + (this.positionIndex + 1));
            return smart_move(position);
        }
        if (this.positionArrivalIndex !== this.positionIndex) {
            this.positionArrivalIndex = this.positionIndex;
            this.positionStayUntil = Date.now() + (settings.stayMs || 30000);
        }
        var target = this.findTarget(true);
        if (target) return this.attackTarget(target);
        if (Date.now() >= this.positionStayUntil) {
            this.positionIndex = (this.positionIndex + 1) % positions.length;
            this.positionArrivalIndex = -1;
        }
        set_message("Patrolling");
    };

    // 有効な戦闘戦略を選び、該当する行動を実行する
    Combat.prototype.tick = function () {
        if (this.settings.enabled === false || character.rip || is_moving(character)) return;
        var mode = this.settings.mode || "stationary";
        if (mode === "stationary") return this.runStationary();
        if (mode === "approach") return this.runApproach();
        if (mode === "rotate") return this.runRotation();
        set_message("Unknown Combat Mode");
    };

    // 設定された頻度で戦闘判断を実行する
    Combat.prototype.start = function () {
        var self = this;
        if (this.settings.enabled === false) return;
        root.App.Common.startRoutine({
            id: this.routineId,
            interval: this.settings.interval || 250,
            tasks: [{
                name: "戦闘",
                // 戦闘コントローラーの1回分の判断を実行する
                run: function () { return self.tick(); }
            }]
        });
    };

    // 戦闘用の定期実行を停止する
    Combat.prototype.stop = function () {
        root.App.Common.stopRoutine(this.routineId);
    };

    // キャラクターごとの設定から戦闘コントローラーを生成する
    root.App.Combat = {
        // 戦闘コントローラーのインスタンスを生成する
        create: function (options) {
            return new Combat(options);
        }
    };
})(window);
