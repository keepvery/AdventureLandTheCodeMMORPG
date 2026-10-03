// キャラクターの戦闘対象選択と位置戦略を専用スコープに定義する
(function (root) {
    "use strict";
    root.App = root.App || {};
    var RARE_MONSTER_CALL_INTERVAL = 10 * 1000;
    var RARE_MONSTER_TIMEOUT = 60 * 1000;
    // コード再読み込み後も次の巡回予定時刻を保持する
    root.__APP_RARE_PATROL_TIMES = root.__APP_RARE_PATROL_TIMES || {};

    // 戦闘条件と巡回位置を保持する戦闘コントローラーを作成する
    function Combat(options) {
        this.settings = options || {};
        this.positionIndex = 0;
        this.positionArrivalIndex = -1;
        this.positionStayUntil = 0;
        this.shieldSlamLastUsed = {};
        this.shieldSlamCleanupAt = 0;
        this.shieldSlamInFlight = false;
        this.rareEncounter = null;
        this.lastRareCallTime = 0;
        this.rareMoveInFlight = false;
        this.rareMoveRetryAt = 0;
        this.rarePatrolPhase = "home";
        this.rarePatrolIndex = 0;
        this.rarePatrolStayUntil = 0;
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
        if (this.settings.mode === "tank" && character.ctype === "paladin" &&
            target.target !== character.name) {
            var tankSettings = this.settings.tank || {};
            var shieldSlam = this.findSkillName("Shield Slam");
            var tankSkills = tankSettings.tankSkills || {};
            var now = Date.now();
            var targetKey = target.id || target.name || "unknown";
            var slamInterval = typeof tankSettings.shieldSlamInterval === "number"
                ? tankSettings.shieldSlamInterval : 10000;
            if (now - this.shieldSlamCleanupAt >= 60000) {
                for (var previousTarget in this.shieldSlamLastUsed) {
                    if (now - this.shieldSlamLastUsed[previousTarget] >= 60000) {
                        delete this.shieldSlamLastUsed[previousTarget];
                    }
                }
                this.shieldSlamCleanupAt = now;
            }
            var lastSlam = this.shieldSlamLastUsed[targetKey] || 0;
            var skills = typeof G !== "undefined" && G.skills ? G.skills : {};
            var skillData = shieldSlam && skills[shieldSlam];
            var skillMp = skillData && typeof skillData.mp === "number" ? skillData.mp : 0;
            var mpReserve = typeof tankSettings.shieldSlamMpReserve === "number"
                ? tankSettings.shieldSlamMpReserve : 1000;
            var hasMpReserve = character.mp >= skillMp + mpReserve;
            if (shieldSlam && tankSkills[shieldSlam] === true &&
                !this.shieldSlamInFlight && now - lastSlam >= slamInterval &&
                hasMpReserve && this.canUseSkill(shieldSlam)) {
                this.shieldSlamLastUsed[targetKey] = now;
                this.shieldSlamInFlight = true;
                set_message("Shield Slam");
                var self = this;
                var result = use_skill(shieldSlam, target);
                if (result && typeof result.then === "function") {
                    return result.then(function (value) {
                        self.shieldSlamInFlight = false;
                        return value;
                    }, function (error) {
                        self.shieldSlamInFlight = false;
                        throw error;
                    });
                }
                this.shieldSlamInFlight = false;
                return result;
            }
        }
        if (!can_attack(target)) return;
        set_message("Attacking");
        return attack(target);
    };

    // ゲームデータから表示名に一致するスキルIDを探す
    Combat.prototype.findSkillName = function (displayName) {
        var skills = typeof G !== "undefined" && G.skills ? G.skills : {};
        var expectedKey = displayName.toLowerCase().replace(/\s+/g, "_");
        if (skills[expectedKey]) return expectedKey;
        for (var skillName in skills) {
            if (skills[skillName] && skills[skillName].name === displayName) return skillName;
        }
        return null;
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

    // パーティメンバーを狙っている敵を優先し、いなければ未交戦の敵を探す
    Combat.prototype.findTankTarget = function () {
        var party = get_party() || {};
        var entities = parent.entities || {};
        var chosen = null;
        var chosenPriority = Infinity;
        var chosenDistance = Infinity;
        for (var id in entities) {
            var candidate = entities[id];
            if (!this.isEligible(candidate)) continue;
            var targetName = candidate.target;
            var priority = 2;
            if (targetName === character.name) priority = 1;
            else if (targetName && party[targetName]) priority = 0;
            else if (targetName) continue;
            var distance = parent.distance(character, candidate);
            if (priority < chosenPriority ||
                (priority === chosenPriority && distance < chosenDistance)) {
                chosen = candidate;
                chosenPriority = priority;
                chosenDistance = distance;
            }
        }
        return chosen;
    };

    // スキルの習得レベルを確認してから使用可能状態を調べる
    Combat.prototype.canUseSkill = function (skillName) {
        var skills = typeof G !== "undefined" && G.skills ? G.skills : null;
        var skill = skills && skills[skillName];
        if (skill && typeof skill.level === "number" && character.level < skill.level) return false;
        return can_use(skillName);
    };

    // パラディンの自己防御と瀕死回復を必要な場合だけ行う
    Combat.prototype.useTankDefense = function () {
        if (character.ctype !== "paladin") return;
        var conditions = character.s || {};
        var hpRatio = character.max_hp > 0 ? character.hp / character.max_hp : 1;
        var settings = this.settings.tank || {};
        var healThreshold = typeof settings.selfHealThreshold === "number"
            ? settings.selfHealThreshold : 0.45;
        if (hpRatio <= healThreshold && this.canUseSkill("selfheal")) return use_skill("selfheal");
        if (!conditions.mshield && !conditions.aether_shield && this.canUseSkill("mshield")) {
            return use_skill("mshield");
        }
        var hasAura = conditions.paladin_aura_bulwark || conditions.paladin_aura_sanctuary ||
            conditions.paladin_aura_zeal || conditions.paladin_aura_warding;
        if (!hasAura && this.canUseSkill("paladin_aura")) return use_skill("paladin_aura");

        var party = get_party() || {};
        var allies = Object.keys(party);
        var entities = parent.entities || {};
        for (var i = 0; i < allies.length; i++) {
            var allyName = allies[i];
            var ally = party[allyName];
            if (!ally || allyName === character.name || ally.rip || ally.map !== character.map ||
                (ally.s && ally.s.guardians_oath)) continue;
            var allyThreatened = false;
            for (var id in entities) {
                var monster = entities[id];
                if (this.isEligible(monster) && monster.target === allyName) {
                    allyThreatened = true;
                    break;
                }
            }
            if (allyThreatened && parent.distance(character, ally) <= 240 && this.canUseSkill("guardians_oath")) {
                return use_skill("guardians_oath", allyName);
            }
        }
        if (!conditions.beacon_of_resolve && this.canUseSkill("beacon_of_resolve")) {
            var allyNearby = allies.some(function (name) {
                var ally = party[name];
                return ally && !ally.rip && ally.map === character.map &&
                    parent.distance(character, ally) <= 480;
            });
            if (allyNearby) return use_skill("beacon_of_resolve");
        }
    };

    // パーティへの脅威を引き受け、脅威がない間はリーダーを追従する
    Combat.prototype.runTank = function () {
        var defense = this.useTankDefense();
        if (defense) return defense;
        var party = get_party() || {};
        var members = Object.keys(party);
        var hasParty = members.some(function (name) { return name !== character.name; });
        var target = this.findTankTarget();

        // パーティ中は味方を狙う敵か自分を狙う敵を優先して迎撃する
        if (hasParty && target && target.target) {
            if (is_in_range(target)) return this.attackTarget(target);
            var nextX = character.x + (target.x - character.x) / 2;
            var nextY = character.y + (target.y - character.y) / 2;
            set_message("Protecting Party");
            return move(nextX, nextY);
        }

        // パーティ付近に未交戦の敵がいれば先に攻撃してヘイトを取る
        if (hasParty && target && !target.target) {
            var tankSettings = this.settings.tank || {};
            var engageDistance = typeof tankSettings.engageDistance === "number"
                ? tankSettings.engageDistance : 400;
            var nearestPartyDistance = parent.distance(character, target);
            for (var i = 0; i < members.length; i++) {
                var ally = party[members[i]];
                if (!ally || ally.rip || ally.map !== target.map) continue;
                var allyDistance = parent.distance(ally, target);
                if (allyDistance < nearestPartyDistance) nearestPartyDistance = allyDistance;
            }
            if (nearestPartyDistance <= engageDistance) {
                if (is_in_range(target)) return this.attackTarget(target);
                var engageX = character.x + (target.x - character.x) / 2;
                var engageY = character.y + (target.y - character.y) / 2;
                set_message("Engaging Nearby Target");
                return move(engageX, engageY);
            }
        }

        // パーティ外では従来どおり近くの敵を探して戦闘する
        if (!hasParty && target) {
            if (is_in_range(target)) return this.attackTarget(target);
            var soloX = character.x + (target.x - character.x) / 2;
            var soloY = character.y + (target.y - character.y) / 2;
            set_message("Moving to Target");
            return move(soloX, soloY);
        }

        if (hasParty && this.settings.followLeader !== false) {
            var leaderName = this.settings.leaderCharacter || members[0];
            // 自分がリーダーなら追従先がないため、敵が来るまで現在地で待機する
            if (leaderName === character.name) {
                set_message("Waiting for Party Targets");
                return;
            }
            var leader = party[leaderName];
            if (!leader || leaderName === character.name || leader.rip) {
                set_message("Waiting for Party Leader");
                return;
            }
            var followDistance = typeof this.settings.followDistance === "number"
                ? this.settings.followDistance : 120;
            var distance = leader.map === character.map
                ? parent.distance(character, leader) : Infinity;
            if (distance <= followDistance) {
                set_message("Following " + leaderName);
                return;
            }
            var now = Date.now();
            var moveInterval = typeof this.settings.followMoveInterval === "number"
                ? this.settings.followMoveInterval : 3000;
            if (now - (this.lastFollowMoveTime || 0) < moveInterval) return;
            this.lastFollowMoveTime = now;
            set_message("Following " + leaderName);
            return smart_move({ map: leader.map, x: leader.x, y: leader.y });
        }

        set_message("No Party Targets");
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

    // レアモンスター探索の設定を取得する
    Combat.prototype.getRareMonsterSettings = function () {
        var settings = this.settings.rareMonster;
        return settings && settings.enabled === true ? settings : null;
    };

    // 実際のPTに所属している場合だけゲーム側のリーダー名を返す
    Combat.prototype.getPartyLeader = function () {
        var party = get_party() || {};
        return typeof character.party === "string" && party[character.party] && party[character.name]
            ? character.party : null;
    };

    // PTリーダーが対象マップの視界内から未交戦またはPTと交戦中のレアモンスターを探す
    Combat.prototype.searchRareMonster = function () {
        var settings = this.getRareMonsterSettings();
        if (!settings || this.settings.enabled === false || character.rip ||
            character.map !== settings.map || this.getPartyLeader() !== character.name ||
            this.rareEncounter) return;
        var party = get_party() || {};
        var entities = parent.entities || {};
        var nearest = null;
        var nearestDistance = Infinity;
        for (var id in entities) {
            var monster = entities[id];
            if (!monster || monster.type !== "monster" || monster.mtype !== settings.monsterType ||
                monster.dead || !monster.visible ||
                (monster.map && monster.map !== character.map) ||
                (monster.target && !party[monster.target])) continue;
            var distance = parent.distance(character, monster);
            if (distance < nearestDistance) {
                nearest = monster;
                nearestDistance = distance;
            }
        }
        if (!nearest || !Number.isFinite(nearest.x) || !Number.isFinite(nearest.y)) return;
        this.rareEncounter = {
            id: nearest.id,
            leaderName: character.name,
            map: character.map,
            x: nearest.x,
            y: nearest.y,
            expiresAt: Date.now() + RARE_MONSTER_TIMEOUT,
            engaged: !!nearest.target
        };
        this.lastRareCallTime = 0;
        // 巡回中に見つけた場合は巡回移動を中断して接近・攻撃へ切り替える
        if (this.rareMoveInFlight) stop("move");
        root.App.Common.log(settings.monsterType + " を発見しました。優先して攻撃します", "yellow");
    };

    // 登録済みで受信を許可したPTメンバーにレアモンスターの集合・終了通知を送る
    Combat.prototype.notifyRareMonster = function (finished) {
        var encounter = this.rareEncounter;
        var settings = this.getRareMonsterSettings();
        if (!settings || !encounter || encounter.leaderName !== character.name) return;
        var now = Date.now();
        if (!finished && (!encounter.engaged || now - this.lastRareCallTime < RARE_MONSTER_CALL_INTERVAL)) return;
        var party = get_party() || {};
        var allowed = root.App.Common.getAllowedSenders();
        var members = Object.keys(party).filter(function (name) { return allowed.indexOf(name) >= 0; });
        if (!members.length) return;
        this.lastRareCallTime = now;
        var message = {
            task: finished ? "rare_monster_end" : "rare_monster_found",
            monsterId: encounter.id,
            monsterType: settings.monsterType,
            map: encounter.map,
            x: encounter.x,
            y: encounter.y,
            serverRegion: parent.server_region,
            serverId: parent.server_identifier
        };
        return Promise.resolve().then(function () { return send_cm(members, message); })
            .then(null, function (error) {
                root.App.Common.log("レアモンスター通知に失敗しました: " +
                    root.App.Common.formatError(error), "orange");
            });
    };

    // 同じサーバーの実際のPTリーダーから届いたレアモンスター通知だけを受け取る
    Combat.prototype.onCM = function (name, data) {
        var settings = this.getRareMonsterSettings();
        if (!settings || this.settings.enabled === false || character.rip || !data ||
            name === character.name || name !== this.getPartyLeader() ||
            root.App.Common.getAllowedSenders().indexOf(name) < 0 ||
            data.serverRegion !== parent.server_region || data.serverId !== parent.server_identifier ||
            data.monsterType !== settings.monsterType || data.map !== settings.map) return;
        if (data.task === "rare_monster_end") {
            if (this.rareEncounter && this.rareEncounter.id === data.monsterId) this.clearRareEncounter();
            return;
        }
        if (data.task !== "rare_monster_found" ||
            (typeof data.monsterId !== "string" && typeof data.monsterId !== "number") ||
            !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
        var isNew = !this.rareEncounter || this.rareEncounter.id !== data.monsterId;
        this.rareEncounter = {
            id: data.monsterId,
            leaderName: name,
            map: data.map,
            x: data.x,
            y: data.y,
            expiresAt: Date.now() + RARE_MONSTER_TIMEOUT,
            engaged: true
        };
        if (isNew && this.rareMoveInFlight) stop("move");
        if (isNew) root.App.Common.log(name + " の " + settings.monsterType + " 戦へ集合します", "cyan");
    };

    // レアモンスターの優先戦闘を解除し、この処理が開始した移動だけを停止する
    Combat.prototype.clearRareEncounter = function () {
        if (this.rareEncounter) {
            this.rarePatrolPhase = "returning";
            this.rarePatrolIndex = 0;
            this.rarePatrolStayUntil = 0;
        }
        this.rareEncounter = null;
        if (this.rareMoveInFlight) stop("move");
    };

    // レアモンスターへの接近・巡回・帰還の移動を実行し、重複と中断エラーを抑える
    Combat.prototype.moveToRareMonster = function (position) {
        var self = this;
        if (Date.now() < this.rareMoveRetryAt) return;
        this.rareMoveInFlight = true;
        return Promise.resolve().then(function () { return smart_move(position); })
            .then(function (result) {
                if (result && (result.failed || result.success === false)) {
                    self.rareMoveInFlight = false;
                    self.rareMoveRetryAt = Date.now() + 5000;
                    throw result;
                }
                self.rareMoveInFlight = false;
                return result;
            }, function (error) {
                self.rareMoveInFlight = false;
                if (error && error.reason === "interrupted") return;
                self.rareMoveRetryAt = Date.now() + 5000;
                throw error;
            });
    };

    // 通常戦闘よりレアモンスターを優先し、リーダーの攻撃成功後に仲間を呼ぶ
    Combat.prototype.runRareEncounter = function () {
        var self = this;
        var encounter = this.rareEncounter;
        var settings = this.getRareMonsterSettings();
        if (!settings || this.getPartyLeader() !== encounter.leaderName ||
            Date.now() >= encounter.expiresAt ||
            (encounter.leaderName === character.name && character.map !== encounter.map)) {
            this.notifyRareMonster(true);
            this.clearRareEncounter();
            return;
        }
        var target = (parent.entities || {})[encounter.id];
        if (target && (target.dead || target.hp === 0)) {
            this.notifyRareMonster(true);
            this.clearRareEncounter();
            return;
        }
        var visible = character.map === encounter.map && target && target.visible &&
            target.type === "monster" && target.mtype === settings.monsterType;
        if (visible) {
            encounter.x = target.x;
            encounter.y = target.y;
            encounter.expiresAt = Date.now() + RARE_MONSTER_TIMEOUT;
            if (target.target && (get_party() || {})[target.target]) encounter.engaged = true;
            this.notifyRareMonster(false);
        }
        if (this.rareMoveInFlight || (typeof smart !== "undefined" && smart.moving) || is_moving(character)) return;
        if (this.settings.mode === "tank") {
            var defense = this.useTankDefense();
            if (defense) return defense;
        }
        if (visible && is_in_range(target)) {
            var result = this.attackTarget(target);
            if (!result) return;
            return Promise.resolve(result).then(function (value) {
                if (value && (value.failed || value.success === false)) throw value;
                if (self.rareEncounter !== encounter) return value;
                encounter.engaged = true;
                self.notifyRareMonster(false);
                return value;
            });
        }
        var destination = { map: encounter.map, x: encounter.x, y: encounter.y };
        if (visible) {
            // 近接職も射程内へ入れるよう、直線で歩ける場合は少しずつ敵に近づく
            var nextX = character.x + (target.x - character.x) / 2;
            var nextY = character.y + (target.y - character.y) / 2;
            if (can_move_to(nextX, nextY)) {
                set_message("Approaching " + settings.monsterType);
                return move(nextX, nextY);
            }
        }
        if (visible || character.map !== destination.map || parent.distance(character, destination) > 40) {
            set_message("Moving to " + settings.monsterType);
            return this.moveToRareMonster(destination);
        }
        set_message("Waiting for " + settings.monsterType);
    };

    // 有効な巡回設定と対象マップ内のホーム位置を取得する
    Combat.prototype.getRarePatrolSettings = function () {
        var settings = this.getRareMonsterSettings();
        var home = settings && settings.homePosition;
        if (!settings || !settings.patrol || settings.patrol.enabled !== true ||
            !home || home.map !== settings.map || !Number.isFinite(home.x) || !Number.isFinite(home.y)) return null;
        return settings;
    };

    // ホーム到着後に次の巡回時刻を設定し、巡回状態を初期化する
    Combat.prototype.finishRarePatrol = function (settings) {
        var interval = settings.patrol.interval;
        if (!Number.isFinite(interval) || interval <= 0) interval = 10 * 60 * 1000;
        root.__APP_RARE_PATROL_TIMES[this.routineId + "-" + settings.map] = Date.now() + interval;
        this.rarePatrolPhase = "home";
        this.rarePatrolIndex = 0;
        this.rarePatrolStayUntil = 0;
    };

    // 洞窟のホームで待機し、リーダーだけが設定間隔で巡回してホームへ戻る
    Combat.prototype.runRarePatrol = function (settings) {
        if (this.rareMoveInFlight || (typeof smart !== "undefined" && smart.moving) || is_moving(character)) return;
        var leaderName = this.getPartyLeader();
        var home = settings.homePosition;
        var patrol = settings.patrol;
        var key = this.routineId + "-" + settings.map;
        var positions = Array.isArray(patrol.positions) ? patrol.positions : [];
        var now = Date.now();
        if (!Number.isFinite(root.__APP_RARE_PATROL_TIMES[key])) this.finishRarePatrol(settings);

        // 巡回中にリーダーが変わった場合は巡回を終了してホームへ戻る
        if (this.rarePatrolPhase === "patrolling" && leaderName !== character.name) {
            this.rarePatrolPhase = "returning";
        }

        if (this.rarePatrolPhase === "patrolling") {
            if (this.rarePatrolIndex >= positions.length) {
                this.rarePatrolPhase = "returning";
            } else {
                var position = positions[this.rarePatrolIndex];
                if (!position || position.map !== settings.map ||
                    !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
                    root.App.Common.log("レアモンスターの巡回地点を確認してください（設定番号: " +
                        this.rarePatrolIndex + "）", "orange");
                    this.rarePatrolIndex++;
                    this.rarePatrolStayUntil = 0;
                    return;
                }
                if (parent.distance(character, position) > 40) {
                    set_message("Rare Patrol " + (this.rarePatrolIndex + 1));
                    return this.moveToRareMonster(position);
                }
                if (!this.rarePatrolStayUntil) {
                    var stayMs = patrol.stayMs;
                    this.rarePatrolStayUntil = now +
                        (Number.isFinite(stayMs) && stayMs > 0 ? stayMs : 5000);
                    // 各地点の到着時にも探索し、定期チェックの直前に通過した敵を見逃しにくくする
                    this.searchRareMonster();
                    if (this.rareEncounter) return;
                }
                if (now >= this.rarePatrolStayUntil) {
                    this.rarePatrolIndex++;
                    this.rarePatrolStayUntil = 0;
                }
                return this.runRareHomeCombat();
            }
        }

        if (parent.distance(character, home) > 40) {
            this.rarePatrolPhase = "returning";
            set_message("Returning to Cave Home");
            return this.moveToRareMonster(home);
        }
        if (this.rarePatrolPhase === "returning") {
            this.finishRarePatrol(settings);
            root.App.Common.log("洞窟ホームに戻りました。次の巡回まで待機します", "cyan");
        }
        if (leaderName === character.name && positions.length && now >= root.__APP_RARE_PATROL_TIMES[key]) {
            this.rarePatrolPhase = "patrolling";
            this.rarePatrolIndex = 0;
            this.rarePatrolStayUntil = 0;
            root.App.Common.log("レアモンスターを探す巡回を開始します", "cyan");
            return;
        }
        return this.runRareHomeCombat();
    };

    // ホーム待機中と巡回地点の確認中は防御と射程内の通常攻撃だけを行う
    Combat.prototype.runRareHomeCombat = function () {
        if (this.settings.mode === "tank") {
            var defense = this.useTankDefense();
            if (defense) return defense;
        }
        return this.runStationary();
    };

    // 有効な戦闘戦略を選び、レアモンスターとの戦闘中は通常の位置戦略より優先する
    Combat.prototype.tick = function () {
        if (this.settings.enabled === false || character.rip) return;
        if (this.rareEncounter) {
            var rareAction = this.runRareEncounter();
            if (this.rareEncounter || rareAction) return rareAction;
        }
        var patrolSettings = this.getRarePatrolSettings();
        if (patrolSettings && character.map === patrolSettings.map && this.getPartyLeader()) {
            return this.runRarePatrol(patrolSettings);
        }
        if (is_moving(character)) return;
        var mode = this.settings.mode || "stationary";
        if (mode === "stationary") return this.runStationary();
        if (mode === "approach") return this.runApproach();
        if (mode === "tank") return this.runTank();
        if (mode === "rotate") return this.runRotation();
        set_message("Unknown Combat Mode");
    };

    // 設定された頻度で戦闘判断を実行する
    Combat.prototype.start = function () {
        var self = this;
        if (this.settings.enabled === false) return;
        root.App.Common.stopRoutine(this.routineId + "-rare-monster");
        var rareSettings = this.getRareMonsterSettings();
        if (rareSettings) {
            var checkInterval = rareSettings.checkInterval;
            root.App.Common.startRoutine({
                id: this.routineId + "-rare-monster",
                interval: Number.isFinite(checkInterval) && checkInterval > 0 ? checkInterval : 5000,
                tasks: [{
                    name: "レアモンスター探索",
                    // PTリーダーが対象マップでレアモンスターを確認する
                    run: function () { return self.searchRareMonster(); }
                }]
            });
        }
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
        root.App.Common.stopRoutine(this.routineId + "-rare-monster");
        this.clearRareEncounter();
    };

    // キャラクターごとの設定から戦闘コントローラーを生成する
    root.App.Combat = {
        // 戦闘コントローラーのインスタンスを生成する
        create: function (options) {
            return new Combat(options);
        }
    };
})(window);
