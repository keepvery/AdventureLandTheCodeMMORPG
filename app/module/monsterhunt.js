// Monster Huntの受注・討伐・報告と専用の移動状態を管理する
(function (root) {
    "use strict";
    root.App = root.App || {};
    // 再読み込み後もON/OFFと進行中の通信・移動を保持する
    var state = root.__APP_MONSTER_HUNT_STATE = root.__APP_MONSTER_HUNT_STATE || {
        enabled: false, moving: false, interacting: false, retryAt: 0,
        questKey: null, spawnIndex: 0, searchAt: 0, arrivedKey: null,
        waitingFor: null, waitUntil: 0, moveId: 0,
        remainingCount: null, lastProgressAt: 0, lastQuestMs: null, abandoned: false,
        lastTimeLogAt: 0, homeArrived: false
    };
    var combat = null;
    var merchantLink = null;
    var settings = {};
    var homePosition = null;
    var cachedType = null;
    var cachedPositions = [];
    var CHECK_INTERVAL = 1000;
    var RETRY_INTERVAL = 10 * 1000;
    var SEARCH_WAIT = 5 * 1000;
    var STALL_TIMEOUT = 10 * 60 * 1000;
    var TIME_LOG_INTERVAL = 60 * 1000;

    // Qボタンを現在のループ状態に合わせて更新する
    function updateButton() {
        if (root.App.Interface && root.App.Interface.updateQuestButton) root.App.Interface.updateQuestButton();
    }

    // 現在のサーバーで有効な討伐クエストかを確認する
    function isCurrentServer(hunt) {
        return !hunt.sn || hunt.sn === parent.server_region + " " + parent.server_identifier;
    }

    // 商人へ現在地を送信した後は、その場所で補給や受け渡しを待つ
    function isWaitingForMerchant() {
        return merchantLink && (merchantLink.callingMerchant || merchantLink.deliveryInProgress);
    }

    // この機能が開始した移動だけを停止し、古い移動応答を無効化する
    function cancelMovement() {
        var destination = state.destination;
        var ownsSmartMove = state.moving && destination && typeof smart !== "undefined" &&
            smart.moving && smart.map === destination.map &&
            smart.x === destination.x && smart.y === destination.y;
        var step = state.stepDestination;
        var ownsStep = step && is_moving(character) &&
            character.going_x === step.x && character.going_y === step.y;
        if (ownsSmartMove || ownsStep) stop("move");
        state.moveId++;
        state.moving = false;
        state.destination = null;
        state.stepDestination = null;
        state.approachTargetId = null;
    }

    // ループを停止し、ゲーム内で受注済みのクエストは保持する
    function stopLoop() {
        state.enabled = false;
        cancelMovement();
        updateButton();
        root.App.Common.log("Monster Huntの自動ループを停止しました", "gray");
    }

    // 冒険者の通常移動を解除して、現在のクエストから自動ループを開始する
    function startLoop() {
        if (!combat || character.ctype === "merchant") {
            root.App.Common.log("Monster Huntは冒険者キャラクターで開始してください", "orange");
            return false;
        }
        if (state.enabled) return true;
        if (combat.rareEncounter) combat.notifyRareMonster(true);
        combat.clearRareEncounter();
        if ((typeof smart !== "undefined" && smart.moving) || is_moving(character)) stop("move");
        state.enabled = true;
        state.retryAt = 0;
        state.searchAt = 0;
        updateButton();
        root.App.Common.log("Monster Huntの自動ループを開始しました", "cyan");
        return true;
    }

    // Qボタンから自動ループの開始・停止を切り替える
    function toggle() {
        if (state.enabled) stopLoop();
        else startLoop();
    }

    // 失敗の連打を避け、一定時間待ってから再試行する
    function handleError(error) {
        if (error && error.reason === "interrupted") {
            state.retryAt = Date.now() + CHECK_INTERVAL;
            return;
        }
        state.retryAt = Date.now() + RETRY_INTERVAL;
        root.App.Common.log("Monster Huntでエラーが発生しました: " +
            root.App.Common.formatError(error), "orange");
    }

    // 他の移動がない場合だけ指定地点へ移動し、応答待ち中の重複を防ぐ
    function moveTo(destination) {
        if (!state.enabled || state.moving || Date.now() < state.retryAt ||
            (typeof smart !== "undefined" && smart.moving) || is_moving(character)) return;
        var id = ++state.moveId;
        state.moving = true;
        state.destination = destination;
        // 移動開始前にOFFへ切り替えられた場合はリクエストを送らない
        return Promise.resolve().then(function () {
            if (!state.enabled || id !== state.moveId) return;
            return smart_move(destination);
        }).then(function (result) {
            if (id !== state.moveId) return;
            state.moving = false;
            state.destination = null;
            if (result && (result.failed || result.success === false)) handleError(result);
        }, function (error) {
            if (id !== state.moveId) return;
            state.moving = false;
            state.destination = null;
            handleError(error);
        });
    }

    // メインマップのゲームデータからMonster Hunterの座標を取得する
    function getHunterPosition() {
        var main = G.maps && G.maps.main;
        var npcs = main && main.npcs || [];
        for (var i = 0; i < npcs.length; i++) {
            var npc = npcs[i];
            if (npc.id === "monsterhunter" && Array.isArray(npc.position)) {
                return { map: "main", x: npc.position[0], y: npc.position[1] };
            }
        }
        return null;
    }

    // 設定またはゲーム内の出現領域から、対象モンスターの巡回地点を作成する
    function getHuntPositions(monsterType) {
        if (monsterType === cachedType) return cachedPositions;
        var configured = settings.positions && settings.positions[monsterType];
        var locations = [];
        if (Array.isArray(configured) && configured.length) {
            locations = configured.filter(function (position) {
                return position && G.maps[position.map] &&
                    Number.isFinite(position.x) && Number.isFinite(position.y);
            });
        } else {
            Object.keys(G.maps || {}).forEach(function (mapName) {
                var map = G.maps[mapName];
                if (map.ignore || map.instance) return;
                (map.monsters || []).forEach(function (pack) {
                    if (pack.type !== monsterType || pack.count === 0) return;
                    var boundaries = pack.boundaries || (pack.boundary ? [
                        [mapName].concat(pack.boundary)
                    ] : []);
                    boundaries.forEach(function (boundary) {
                        if (boundary.length < 5 || !G.maps[boundary[0]] ||
                            G.maps[boundary[0]].ignore || G.maps[boundary[0]].instance) return;
                        var x = (boundary[1] + boundary[3]) / 2;
                        var y = (boundary[2] + boundary[4]) / 2;
                        if (Number.isFinite(x) && Number.isFinite(y)) {
                            locations.push({ map: boundary[0], x: x, y: y });
                        }
                    });
                });
            });
        }
        // 出現領域の全走査は対象変更時だけ行い、現在のマップの近い地点から回る
        locations.sort(function (a, b) {
            var aHere = a.map === character.map;
            var bHere = b.map === character.map;
            if (aHere !== bHere) return aHere ? -1 : 1;
            return aHere ? parent.distance(character, a) - parent.distance(character, b) : 0;
        });
        cachedType = monsterType;
        cachedPositions = locations;
        return locations;
    }

    // ゲーム画面と同じ判定で「難しい」（2以上）の敵を討伐候補から除外する
    function canHuntMonster(monster) {
        if (Array.isArray(settings.blacklist) && settings.blacklist.indexOf(monster.mtype) >= 0) return false;
        return parent.calculate_difficulty(monster) < 2;
    }

    // 視界内の難しくないクエスト対象を探し、現在の対象を維持しつつ最寄りを優先する
    function findTarget(monsterType) {
        var entities = parent.entities || {};
        var current = get_targeted_monster();
        var nearest = null;
        var nearestDistance = Infinity;
        var party = get_party() || {};
        for (var id in entities) {
            var monster = entities[id];
            if (!monster || monster.type !== "monster" || monster.mtype !== monsterType ||
                !monster.visible || monster.dead || monster.hp === 0 ||
                (monster.map && monster.map !== character.map) ||
                !Number.isFinite(monster.x) || !Number.isFinite(monster.y) ||
                (monster.target && monster.target !== character.name && !party[monster.target])) continue;
            if (!canHuntMonster(monster)) continue;
            if (monster === current) return monster;
            var distance = parent.distance(character, monster);
            if (distance < nearestDistance) {
                nearest = monster;
                nearestDistance = distance;
            }
        }
        return nearest;
    }

    // 受注または報告を一度だけ送信し、キャラクター状態の反映を待つ
    function interactWithHunter(hunt) {
        state.interacting = true;
        var completing = !!hunt;
        // OFFに切り替わった場合は、新しい受注・報告のリクエストを送らない
        return Promise.resolve().then(function () {
            if (!state.enabled) return;
            return interact("monsterhunt");
        }).then(function (result) {
            state.interacting = false;
            if (!result) return;
            if (result.failed || result.success === false) return handleError(result);
            state.waitingFor = completing ? "completed" : "started";
            state.waitUntil = Date.now() + SEARCH_WAIT;
            root.App.Common.log(completing ? "Monster Huntを報告しました。次のクエストを受注します" :
                "Monster Huntを受注しました", "green");
        }, function (error) {
            state.interacting = false;
            handleError(error);
        });
    }

    // 今回の討伐を中断し、移動を止めてホームでの期限切れ待ちへ切り替える
    function abandonQuest(hunt, reason) {
        state.abandoned = true;
        state.homeArrived = false;
        cancelMovement();
        root.App.Common.log(hunt.id + " は" + reason + "ため討伐を中断しました。" +
            "クエストの期限切れまでホームで狩りを行います", "orange");
    }

    // ブラックリストと残数の停滞を確認し、討伐不可のクエストを期限切れ待ちに切り替える
    function checkProgress(hunt, now) {
        if (!hunt || hunt.c <= 0) return;
        // 同じ種類を続けて受注した場合も、残数や残り時間の増加で別クエストと判定する
        var replaced = (Number.isFinite(state.remainingCount) && hunt.c > state.remainingCount) ||
            (Number.isFinite(hunt.ms) && Number.isFinite(state.lastQuestMs) &&
                hunt.ms > state.lastQuestMs + CHECK_INTERVAL);
        if (!Number.isFinite(state.remainingCount) || !state.lastProgressAt || replaced) {
            state.remainingCount = hunt.c;
            state.lastProgressAt = now;
            state.abandoned = false;
            state.homeArrived = false;
        } else if (hunt.c < state.remainingCount) {
            state.lastProgressAt = now;
        }
        state.remainingCount = hunt.c;
        state.lastQuestMs = hunt.ms;
        if (state.abandoned) return;
        if (Array.isArray(settings.blacklist) && settings.blacklist.indexOf(hunt.id) >= 0) {
            abandonQuest(hunt, "討伐ブラックリストに登録されている");
            return;
        }
        if (now - state.lastProgressAt >= STALL_TIMEOUT) {
            abandonQuest(hunt, "10分間討伐残数が減らない");
        }
    }

    // 討伐中断後は一度ホームへ戻り、帰還済みなら接近戦の移動を妨げない
    function returnHome() {
        if (!homePosition || typeof homePosition.map !== "string" ||
            !Number.isFinite(homePosition.x) || !Number.isFinite(homePosition.y)) {
            if (Date.now() >= state.retryAt) handleError("config.js にhomePosition（map、x、y）を設定してください");
            return;
        }
        if (state.homeArrived && character.map === homePosition.map) return;
        state.homeArrived = false;
        if (character.map !== homePosition.map || parent.distance(character, homePosition) > 40) {
            set_message("Hunt: Returning Home");
            moveTo(homePosition);
        } else {
            state.homeArrived = true;
        }
    }

    // クエストの残り時間を分・秒に変換して約1分ごとにログへ表示する
    function logRemainingTime(hunt, now) {
        if (!hunt || !Number.isFinite(hunt.ms)) return;
        if (state.lastTimeLogAt && now - state.lastTimeLogAt < TIME_LOG_INTERVAL) return;
        state.lastTimeLogAt = now;
        var seconds = Math.max(0, Math.ceil(hunt.ms / 1000));
        root.App.Common.log("Monster Hunt: " + hunt.id + " / 残り時間 " +
            Math.floor(seconds / 60) + "分" + (seconds % 60) + "秒 / 残り " + hunt.c + "体" +
            (state.abandoned ? "（ホームで期限切れ待ち）" : ""), "cyan");
    }

    // 討伐数と停滞を監視して受注・討伐・ホーム待機・報告を繰り返す
    function tick() {
        if (!state.enabled || !combat || character.rip) return;
        var hunt = character.s && character.s.monsterhunt;
        if (hunt && !isCurrentServer(hunt)) {
            root.App.Common.log("受注時のサーバーと異なるためMonster Huntを停止します", "orange");
            stopLoop();
            return;
        }
        var key = hunt && hunt.c > 0 ? hunt.id + ":" + hunt.sn : null;
        if (key !== state.questKey) {
            cancelMovement();
            state.questKey = key;
            state.spawnIndex = 0;
            state.arrivedKey = null;
            state.searchAt = 0;
            state.remainingCount = null;
            state.lastProgressAt = 0;
            state.lastQuestMs = null;
            state.abandoned = false;
            state.homeArrived = false;
            state.lastTimeLogAt = 0;
            if (key) root.App.Common.log("討伐対象: " + hunt.id + " / 残り " + hunt.c + "体", "cyan");
        }
        // 移動中や商人待ちでも残数だけは毎秒確認する
        var now = Date.now();
        checkProgress(hunt, now);
        logRemainingTime(hunt, now);
        if (state.waitingFor) {
            var updated = state.waitingFor === "completed" ? !hunt : hunt && hunt.c > 0;
            if (!updated && Date.now() < state.waitUntil) return;
            state.waitingFor = null;
        }
        if (isWaitingForMerchant()) {
            if (state.moving || state.stepDestination) cancelMovement();
            return;
        }
        if (state.abandoned) {
            returnHome();
            return;
        }
        // 接近中の敵がHP減少などで「難しい」に変わったら接近だけを中止する
        var approaching = state.approachTargetId && (parent.entities || {})[state.approachTargetId];
        if (approaching && !canHuntMonster(approaching)) cancelMovement();
        if (state.interacting || state.moving || Date.now() < state.retryAt ||
            (typeof smart !== "undefined" && smart.moving) || is_moving(character)) return;
        if (!hunt || hunt.c <= 0) {
            var hunter = getHunterPosition();
            if (!hunter) {
                handleError("Monster Hunterの座標が見つかりません");
                return;
            }
            set_message(hunt ? "Hunt: Reporting" : "Hunt: Accepting");
            // 移動中も毎秒討伐数を監視できるよう、移動の完了をこのタスクでは待たない
            if (character.map !== hunter.map || parent.distance(character, hunter) > 60) moveTo(hunter);
            else interactWithHunter(hunt);
            return;
        }
        if (findTarget(hunt.id) || Date.now() < state.searchAt) return;
        var positions = getHuntPositions(hunt.id);
        if (!positions.length) {
            root.App.Common.log(hunt.id + " の出現地点が見つかりません。monsterHunt.positionsに指定してください", "orange");
            stopLoop();
            return;
        }
        var position = positions[state.spawnIndex % positions.length];
        var positionKey = position.map + ":" + position.x + ":" + position.y;
        if (character.map === position.map && parent.distance(character, position) <= 40) {
            if (state.arrivedKey !== positionKey) {
                state.arrivedKey = positionKey;
                state.searchAt = Date.now() + SEARCH_WAIT;
                return;
            }
            state.spawnIndex++;
            state.arrivedKey = null;
            state.searchAt = Date.now() + CHECK_INTERVAL;
            return;
        }
        set_message("Hunt: Moving to " + hunt.id);
        moveTo(position);
    }

    // 通常の戦闘モードを一時的に置き換え、クエスト対象へ接近して攻撃する
    function runCombat(controller) {
        if (controller !== combat || character.rip || state.interacting || state.moving ||
            Date.now() < state.retryAt || (typeof smart !== "undefined" && smart.moving) ||
            is_moving(character)) return;
        var hunt = character.s && character.s.monsterhunt;
        if (!hunt || hunt.c <= 0 || !isCurrentServer(hunt)) return;
        // 帰還後の期限切れ待ちではapproachで狩り、商人待ちの間は接近しない
        if (state.abandoned) {
            if (!homePosition || !state.homeArrived || character.map !== homePosition.map) return;
            if (isWaitingForMerchant()) return controller.runRareHomeCombat();
            if (controller.settings.mode === "tank") {
                var homeDefense = controller.useTankDefense();
                if (homeDefense) return homeDefense;
            }
            var action = controller.runApproach();
            // 接近移動を記録し、期限切れや商人の到着待ちに切り替わった際に停止できるようにする
            if (is_moving(character)) {
                state.stepDestination = { x: character.going_x, y: character.going_y };
            }
            return action;
        }
        var target = findTarget(hunt.id);
        if (!target) {
            set_message("Hunt: Searching " + hunt.id + " (" + hunt.c + ")");
            return;
        }
        if (controller.settings.mode === "tank") {
            var defense = controller.useTankDefense();
            if (defense) return defense;
        }
        if (is_in_range(target)) {
            state.approachTargetId = null;
            return controller.attackTarget(target);
        }
        // 商人の到着待ち中は射程内への攻撃だけを続け、位置を変えない
        if (isWaitingForMerchant()) return;
        state.approachTargetId = target.id;
        var next = {
            x: character.x + (target.x - character.x) / 2,
            y: character.y + (target.y - character.y) / 2
        };
        if (can_move_to(next.x, next.y)) {
            state.stepDestination = next;
            return move(next.x, next.y);
        }
        return moveTo({ map: character.map, x: target.x, y: target.y });
    }

    // 冒険者の戦闘コントローラーを接続し、重複しないクエスト監視を開始する
    function attach(controller, options, adventurer) {
        combat = controller;
        merchantLink = adventurer || null;
        settings = options || {};
        homePosition = root.App.Common.getSettings().homePosition;
        cachedType = null;
        cachedPositions = [];
        root.App.Common.startRoutine({
            id: "monsterhunt-" + character.name,
            interval: CHECK_INTERVAL,
            tasks: [{
                name: "Monster Hunt",
                // ONの間だけ討伐クエストの進行を確認する
                run: tick
            }]
        });
        updateButton();
    }

    // 冒険者の停止時にクエスト監視と所有する移動を終了する
    function detach() {
        stopLoop();
        root.App.Common.stopRoutine("monsterhunt-" + character.name);
        combat = null;
        merchantLink = null;
    }

    root.App.MonsterHunt = {
        attach: attach,
        detach: detach,
        start: startLoop,
        stop: stopLoop,
        toggle: toggle,
        runCombat: runCombat,
        // ボタン表示と通常戦闘の切り替えに使用する実行状態を返す
        isRunning: function () { return state.enabled; }
    };
})(window);
