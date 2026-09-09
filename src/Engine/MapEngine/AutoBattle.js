/**
 * Engine/MapEngine/AutoBattle.js
 *
 * Auto-battle engine: automatically attacks nearby monsters, loots items and uses potions.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import DB from 'DB/DBManager.js';
import Session from 'Engine/SessionStorage.js';
import Network from 'Network/NetworkManager.js';
import PACKET from 'Network/PacketStructure.js';
import PACKETVER from 'Network/PacketVerManager.js';
import Renderer from 'Renderer/Renderer.js';
import EntityManager from 'Renderer/EntityManager.js';
import Entity from 'Renderer/Entity/Entity.js';
import Altitude from 'Renderer/Map/Altitude.js';
import PathFinding from 'Utils/PathFinding.js';
import Events from 'Core/Events.js';
import ChatBox from 'UI/Components/ChatBox/ChatBox.js';
import Inventory from 'UI/Components/Inventory/Inventory.js';
import SkillInfo from 'DB/Skills/SkillInfo.js';
import SkillId from 'DB/Skills/SkillConst.js';
import { setAutoSelectWarpTick } from 'Engine/MapEngine/TeleportAutoSelect.js';
import SkillList from 'UI/Components/SkillList/SkillList.js';
import StatusIcons from 'UI/Components/StatusIcons/StatusIcons.js';
import LootRates from 'Engine/MapEngine/LootRates.js';
import { getRecentAttackers, ATTACK_WINDOW_MS } from 'Engine/MapEngine/AttackTracker.js';
import Prefs from 'Preferences/AutoBattle.js';
import glMatrix from 'Utils/gl-matrix.js';

const vec2 = glMatrix.vec2;

let _timer = null;
let _enabled = false;
let _lastAttackTick = 0;
let _lastLootTick = 0;
let _lastRoamTick = 0;
let _lastTargetSeenTick = 0;
let _tickCount = 0;
let _moveActionPkt = null;
let _moveActionTick = 0;
let _moveActionPos = null; // [x, y] floored snapshot at set time
let _retaliateGID = null;
const MOVE_STUCK_MS = 3000;
const MOVE_TIMEOUT_MS = 10000;
let _roamDest = null;
let _killCount = 0;

function isEnabled() {
	return _enabled && Prefs.enabled;
}

function getPlayer() {
	return Session.Entity;
}

function isPlayerValid() {
	const p = getPlayer();
	return p && Session.Playing && p.action !== p.ACTION.DIE && p.life && p.life.hp > 0;
}

function isOverWeight() {
	const p = getPlayer();
	if (!p) {
		return true;
	}
	if (p.isOverWeight) {
		return true;
	}
	if (p.max_weight > 0 && p.weight / p.max_weight >= 0.9) {
		return true;
	}
	return false;
}

function getHpPercent() {
	const p = getPlayer();
	if (!p || !p.life || p.life.hp_max <= 0) {
		return 100;
	}
	return (p.life.hp / p.life.hp_max) * 100;
}

function getSpPercent() {
	const p = getPlayer();
	if (!p || !p.life || p.life.sp_max <= 0) {
		return 100;
	}
	return (p.life.sp / p.life.sp_max) * 100;
}

function getSitRecovery() {
	const def = { enabled: false, sitTarget: 'hp', sitThreshold: 50, standTarget: 'hp', standThreshold: 90 };
	const s = Prefs.sitRecovery;
	if (!s || typeof s !== 'object') {
		return def;
	}
	const sitTarget = s.sitTarget === 'sp' ? 'sp' : 'hp';
	const standTarget = s.standTarget === 'sp' ? 'sp' : 'hp';
	let sitThreshold = typeof s.sitThreshold === 'number' ? s.sitThreshold : def.sitThreshold;
	let standThreshold = typeof s.standThreshold === 'number' ? s.standThreshold : def.standThreshold;
	if (isNaN(sitThreshold)) sitThreshold = def.sitThreshold;
	if (isNaN(standThreshold)) standThreshold = def.standThreshold;
	sitThreshold = Math.max(0, Math.min(100, Math.round(sitThreshold)));
	standThreshold = Math.max(0, Math.min(100, Math.round(standThreshold)));
	return { enabled: !!s.enabled, sitTarget, sitThreshold, standTarget, standThreshold };
}

function getSitPercent(target) {
	return target === 'sp' ? getSpPercent() : getHpPercent();
}

function isSitting() {
	const p = getPlayer();
	return !!(p && p.ACTION && p.action === p.ACTION.SIT);
}

function sendSitDown() {
	const player = getPlayer();
	if (!player || isSitting()) {
		return isSitting();
	}
	if (Session.moveAction) {
		return false;
	}
	if (player.walk && player.walk.total !== 0) {
		return false;
	}
	let pkt;
	if (PACKETVER.value >= 20180307) {
		pkt = new PACKET.CZ.REQUEST_ACT2();
	} else {
		pkt = new PACKET.CZ.REQUEST_ACT();
	}
	pkt.action = 2; // sit down
	Network.sendPacket(pkt);
	return true;
}

function sendStandUp() {
	const player = getPlayer();
	if (!player) {
		return false;
	}
	if (!isSitting()) {
		return true;
	}
	let pkt;
	if (PACKETVER.value >= 20180307) {
		pkt = new PACKET.CZ.REQUEST_ACT2();
	} else {
		pkt = new PACKET.CZ.REQUEST_ACT();
	}
	pkt.action = 3; // stand up
	Network.sendPacket(pkt);
	return true;
}

let _resting = false;

/**
 * Sit-to-recover state machine (independent from recoveryRules).
 * - not resting + sitVal <= sitThreshold -> start resting (sit, block combat)
 * - resting + standVal >= standThreshold -> stop resting (stand, resume)
 * - resting otherwise -> keep sitting, block combat
 * Returns 'resting' when the tick is consumed, 'stood-up' on release, null otherwise.
 */
function handleSitRest() {
	const cfg = getSitRecovery();
	if (!cfg.enabled) {
		_resting = false;
		return null;
	}
	if (_resting) {
		if (getSitPercent(cfg.standTarget) >= cfg.standThreshold) {
			_resting = false;
			sendStandUp();
			return 'stood-up';
		}
		sendSitDown();
		return 'resting';
	}
	if (getSitPercent(cfg.sitTarget) <= cfg.sitThreshold) {
		_resting = true;
		sendSitDown();
		return 'resting';
	}
	return null;
}

function isMobEntity(entity) {
	return entity && (entity.objecttype === Entity.TYPE_MOB ||
		entity.objecttype === Entity.TYPE_NPC_ABR ||
		entity.objecttype === Entity.TYPE_NPC_BIONIC ||
		entity.objecttype === Entity.TYPE_UNIT);
}

function getEntityJob(entity) {
	const job = (typeof entity._job === 'number') ? entity._job : entity.job;
	return (typeof job === 'number') ? job : -1;
}

/**
 * Live mob attackers (distinct, within the attack window).
 */
function getMobAttackers(now) {
	const out = [];
	let recent = [];
	try {
		recent = getRecentAttackers(now, ATTACK_WINDOW_MS);
	} catch (_e) {
		return out;
	}
	recent.forEach(hit => {
		let entity = null;
		try {
			entity = EntityManager.get(hit.gid);
		} catch (_e) {
			entity = null;
		}
		if (!isMobEntity(entity)) {
			return;
		}
		if (entity.action === entity.ACTION.DIE || entity.remove_tick !== 0) {
			return;
		}
		out.push(entity);
	});
	return out;
}

function getActiveTargetFilter() {
	try {
		if (Array.isArray(Prefs.targetFilter) && Prefs.targetFilter.length &&
			typeof Prefs.targetFilterMap === 'string' && Prefs.targetFilterMap !== '' &&
			Prefs.targetFilterMap === LootRates.getMapKey()) {
			return Prefs.targetFilter;
		}
	} catch (_e) {
		// ignore
	}
	return null;
}

/**
 * Under-attack policy. Returns true when the tick is consumed
 * (escape teleport sent).
 */
function handleAttacked(now) {
	const attackers = getMobAttackers(now);

	// Count rule: independent override, escape first.
	const countThreshold = typeof Prefs.attackedTeleportCount === 'number' ? Prefs.attackedTeleportCount : 0;
	if (countThreshold > 0 && attackers.length > countThreshold) {
		if (tryTeleportSlots()) {
			_lastTargetSeenTick = now;
			_retaliateGID = null;
			return true;
		}
	}

	const action = Prefs.attackedAction;
	if (action !== 'retaliate' && action !== 'teleport') {
		_retaliateGID = null;
		return false;
	}
	// Non-targets only make sense with an active filter.
	const filter = getActiveTargetFilter();
	if (!filter) {
		_retaliateGID = null;
		return false;
	}

	const player = getPlayer();
	let best = null;
	let bestDist = Infinity;
	attackers.forEach(entity => {
		if (filter.indexOf(getEntityJob(entity)) !== -1) {
			return;
		}
		const dx = entity.position[0] - player.position[0];
		const dy = entity.position[1] - player.position[1];
		const d = dx * dx + dy * dy;
		if (d < bestDist) {
			best = entity;
			bestDist = d;
		}
	});

	if (action === 'teleport') {
		_retaliateGID = null;
		if (best && tryTeleportSlots()) {
			_lastTargetSeenTick = now;
			return true;
		}
		return false;
	}

	// Retaliate: override target until it dies/leaves (stand up first).
	if (best) {
		sendStandUp();
	}
	_retaliateGID = best ? best.GID : null;
	return false;
}

/**
 * Validate the retaliation override with the same gates as findTarget.
 */
function getRetaliationTarget(px, py) {
	if (_retaliateGID === null) {
		return null;
	}
	let entity = null;
	try {
		entity = EntityManager.get(_retaliateGID);
	} catch (_e) {
		entity = null;
	}
	if (!isMobEntity(entity) || entity.action === entity.ACTION.DIE || entity.remove_tick !== 0) {
		_retaliateGID = null;
		return null;
	}
	if (entity.isVisible && !entity.isVisible()) {
		_retaliateGID = null;
		return null;
	}
	const player = getPlayer();
	const rangeSq = Prefs.range * Prefs.range;
	const dx = entity.position[0] - px;
	const dy = entity.position[1] - py;
	if (dx * dx + dy * dy > rangeSq) {
		_retaliateGID = null;
		return null;
	}
	if (Prefs.lockCenter) {
		const maxDistSq = Prefs.maxDistance * Prefs.maxDistance;
		const cdx = entity.position[0] - Prefs.centerX;
		const cdy = entity.position[1] - Prefs.centerY;
		if (cdx * cdx + cdy * cdy > maxDistSq) {
			_retaliateGID = null;
			return null;
		}
	}
	const out = [];
	const count = PathFinding.search(
		px | 0, py | 0,
		entity.position[0] | 0, entity.position[1] | 0,
		player.attack_range + 1,
		out
	);
	if (!count) {
		_retaliateGID = null;
		return null;
	}
	return entity;
}

function findTarget() {
	const player = getPlayer();
	if (!player) {
		return null;
	}

	// Keep the map-mob cache warm for the target filter UI.
	try {
		LootRates.refreshIfNeeded();
	} catch (_e) {
		// ignore
	}

	const px = player.position[0];
	const py = player.position[1];
	const rangeSq = Prefs.range * Prefs.range;
	const maxDistSq = Prefs.lockCenter ? Prefs.maxDistance * Prefs.maxDistance : Infinity;
	const cx = Prefs.centerX;
	const cy = Prefs.centerY;

	// Target filter: non-empty list valid only for its own map.
	const targetFilter = getActiveTargetFilter();

	let best = null;
	let bestDist = Infinity;

	// Retaliation override wins over normal selection (and the filter).
	const retaliation = getRetaliationTarget(px, py);
	if (retaliation) {
		return retaliation;
	}

	EntityManager.forEach(entity => {
		if (entity.objecttype !== Entity.TYPE_MOB &&
			entity.objecttype !== Entity.TYPE_NPC_ABR &&
			entity.objecttype !== Entity.TYPE_NPC_BIONIC &&
			entity.objecttype !== Entity.TYPE_UNIT) {
			return true;
		}
		if (entity.action === entity.ACTION.DIE || entity.remove_tick !== 0) {
			return true;
		}
		if (entity.isVisible && !entity.isVisible()) {
			return true;
		}
		if (targetFilter) {
			const job = (typeof entity._job === 'number') ? entity._job : entity.job;
			if (targetFilter.indexOf(job) === -1) {
				return true;
			}
		}

		const dx = entity.position[0] - px;
		const dy = entity.position[1] - py;
		const distSq = dx * dx + dy * dy;
		if (distSq > rangeSq) {
			return true;
		}
		if (Prefs.lockCenter) {
			const cdx = entity.position[0] - cx;
			const cdy = entity.position[1] - cy;
			if (cdx * cdx + cdy * cdy > maxDistSq) {
				return true;
			}
		}

		// Prefer closer targets (squared distance pre-filter)
		if (distSq >= bestDist * bestDist) {
			return true;
		}

		// Validate path exists with attack_range +1
		const out = [];
		const count = PathFinding.search(
			px | 0, py | 0,
			entity.position[0] | 0, entity.position[1] | 0,
			player.attack_range + 1,
			out
		);
		if (!count) {
			return true;
		}

		const pathDist = count;
		if (pathDist < bestDist) {
			best = entity;
			bestDist = pathDist;
		}
		return true;
	});

	return best;
}

function findLoot() {
	const player = getPlayer();
	if (!player || !Prefs.loot) {
		return null;
	}

	LootRates.refreshIfNeeded();

	const px = player.position[0];
	const py = player.position[1];
	let best = null;
	let bestDist = Infinity;

	EntityManager.forEach(entity => {
		if (entity.objecttype !== Entity.TYPE_ITEM || entity.remove_tick !== 0) {
			return true;
		}
		if (!passesLootFilter(entity)) {
			return true;
		}
		const dx = entity.position[0] - px;
		const dy = entity.position[1] - py;
		const d = Math.sqrt(dx * dx + dy * dy);
		if (d > 14) {
			return true;
		}
		if (d < bestDist) {
			best = entity;
			bestDist = d;
		}
		return true;
	});

	return best;
}

// ItemType ints -> loot category (see Loot tab).
const LOOT_TYPE_CATEGORY = {
	5: 'equip', 4: 'equip', 12: 'equip', 8: 'equip', // WEAPON/ARMOR/SHADOWGEAR/PETARMOR
	6: 'card', // CARD
	0: 'consumable', 2: 'consumable', 18: 'consumable', 10: 'consumable', 11: 'consumable', 7: 'consumable', // HEALING/USABLE/CASH/AMMO/DELAYCONSUME/PETEGG
	3: 'etc', 1: 'etc', 99: 'etc' // ETC/UNKNOWN/SEARCH
};

function getLootTypes() {
	const t = Prefs.lootTypes;
	if (!t || typeof t !== 'object') {
		return { equip: true, card: true, consumable: true, etc: true };
	}
	return t;
}

/**
 * Three loot filters (all fail-open on unknown data so nothing is lost):
 * category -> max weight (display units) -> max rate (percent).
 */
function passesLootFilter(entity) {
	if (typeof entity.ITID !== 'number') {
		return true;
	}
	const info = LootRates.query(entity.ITID);
	if (!info) {
		return true;
	}
	if (typeof info.type === 'number') {
		const cat = LOOT_TYPE_CATEGORY[info.type] || 'etc';
		if (getLootTypes()[cat] === false) {
			return false;
		}
	}
	const maxWeight = typeof Prefs.lootMaxWeight === 'number' ? Prefs.lootMaxWeight : 0;
	if (maxWeight > 0 && typeof info.weight === 'number' && info.weight / 10 > maxWeight) {
		return false;
	}
	const maxRate = typeof Prefs.lootMaxRate === 'number' ? Prefs.lootMaxRate : 100;
	if (maxRate < 100 && typeof info.rate === 'number' && info.rate / 100 > maxRate) {
		return false;
	}
	return true;
}

function tryUsePotion() {
	const hpP = getHpPercent();
	const spP = getSpPercent();
	const rules = Array.isArray(Prefs.recoveryRules) && Prefs.recoveryRules.length ? Prefs.recoveryRules : getLegacyRecoveryRules();

	for (let i = 0; i < rules.length; i++) {
		const rule = rules[i];
		if (!rule || rule.enabled === false || !rule.action) {
			continue;
		}
		const percent = rule.target === 'sp' ? spP : hpP;
		const threshold = typeof rule.threshold === 'number' ? rule.threshold : 50;
		if (!(percent < threshold)) {
			continue;
		}
		if (rule.action.kind === 'skill') {
			if (useSkillOnSelf(rule.action.SKID, rule.action.level)) {
				return true;
			}
			continue;
		}
		const ui = Inventory.getUI();
		let item = null;
		if (ui && ui.getItemById) {
			item = ui.getItemById(rule.action.ITID);
		}
		if (item) {
			useItemByIndex(item.index);
			return true;
		}
	}

	return false;
}

function getLegacyRecoveryRules() {
	return [
		{ id: -1, enabled: true, target: 'hp', threshold: Prefs.hpThreshold, action: { kind: 'item', ITID: Prefs.hpPotionId } },
		{ id: -2, enabled: true, target: 'sp', threshold: Prefs.spThreshold, action: { kind: 'item', ITID: Prefs.spPotionId } }
	];
}

function useSkillOnSelf(skillId, level) {
	const player = getPlayer();
	if (!player) {
		return false;
	}
	const SKID = parseInt(skillId, 10);
	let lv = parseInt(level, 10);
	if (isNaN(SKID) || isNaN(lv)) {
		return false;
	}
	lv = Math.max(1, Math.min(10, lv));
	if (player.amotionTick && player.amotionTick > Renderer.tick) {
		return false;
	}
	if (Session.moveAction) {
		return false;
	}
	// Don't interrupt an ongoing cast: the server rejects overlapping casts,
	// and the rejected send would poison the re-cast gate for 60s.
	// (amotionTick does NOT cover cast bars — those live on entity.cast.)
	const cast = player.cast;
	if (cast && cast.display && cast.delay > 0) {
		const elapsed = Date.now() - cast.tick;
		if (elapsed >= 0 && elapsed < cast.delay) {
			return false;
		}
	}
	// SP affordability pre-check: never send a skill we can't afford.
	// A server-rejected send would otherwise poison the re-cast gate
	// (_buffLastCast) for 60s while the buff stays missing.
	const info = SkillInfo[SKID];
	if (info && Array.isArray(info.SpAmount) && info.SpAmount.length) {
		const cost = info.SpAmount[Math.min(lv, info.SpAmount.length) - 1];
		if (typeof cost === 'number' && player.life && typeof player.life.sp === 'number' && player.life.sp < cost) {
			return false;
		}
	}
	let pkt;
	if (PACKETVER.value >= 20180307) {
		pkt = new PACKET.CZ.USE_SKILL2();
	} else {
		pkt = new PACKET.CZ.USE_SKILL();
	}
	pkt.SKID = SKID;
	pkt.selectedLevel = lv;
	pkt.targetID = player.GID;
	Network.sendPacket(pkt);
	return true;
}

function useItemByIndex(index) {
	if (index === undefined || index === null) {
		return;
	}
	let pkt;
	if (PACKETVER.value >= 20180307) {
		pkt = new PACKET.CZ.USE_ITEM2();
	} else {
		pkt = new PACKET.CZ.USE_ITEM();
	}
	pkt.index = index;
	pkt.AID = getPlayer().GID;
	Network.sendPacket(pkt);
}

function sendAttack(target) {
	const player = getPlayer();
	if (!player) {
		return false;
	}

	// amotion throttle
	if (player.amotionTick && player.amotionTick > Renderer.tick) {
		return false;
	}

	// already has pending move action
	if (Session.moveAction) {
		return false;
	}

	// Use skill if configured
	if (Prefs.useSkill && Prefs.skillId) {
		return sendSkillAttack(target);
	}

	return sendNormalAttack(target);
}

function sendNormalAttack(target) {
	const player = getPlayer();
	const out = [];
	const count = PathFinding.search(
		player.position[0] | 0, player.position[1] | 0,
		target.position[0] | 0, target.position[1] | 0,
		player.attack_range + 1,
		out
	);

	if (!count) {
		return false;
	}

	if (player.isOverWeight) {
		ChatBox.addText(DB.getMessage(243), ChatBox.TYPE.ERROR, ChatBox.FILTER.PUBLIC_LOG);
		return false;
	}

	player.lookTo(target.position[0], target.position[1]);

	let pkt;
	if (PACKETVER.value >= 20180307) {
		pkt = new PACKET.CZ.CHANGE_DIRECTION2();
	} else {
		pkt = new PACKET.CZ.CHANGE_DIRECTION();
	}
	pkt.headDir = player.headDir;
	pkt.dir = player.direction;
	Network.sendPacket(pkt);

	if (PACKETVER.value >= 20180307) {
		pkt = new PACKET.CZ.REQUEST_ACT2();
	} else {
		pkt = new PACKET.CZ.REQUEST_ACT();
	}
	pkt.action = 7;
	pkt.targetGID = target.GID;

	if (count < 2) {
		Network.sendPacket(pkt);
		return true;
	}

	setMoveAction(pkt);

	if (PACKETVER.value >= 20180307) {
		pkt = new PACKET.CZ.REQUEST_MOVE2();
	} else {
		pkt = new PACKET.CZ.REQUEST_MOVE();
	}
	pkt.dest[0] = out[(count - 1) * 2 + 0];
	pkt.dest[1] = out[(count - 1) * 2 + 1];
	Network.sendPacket(pkt);
	return true;
}

function sendSkillAttack(target) {
	const player = getPlayer();
	const skillId = Prefs.skillId;
	const level = Prefs.skillLevel || 1;

	if (player.amotionTick && player.amotionTick > Renderer.tick) {
		return false;
	}
	if (Session.moveAction) {
		return false;
	}

	const skill = SkillList.getUI() ? SkillList.getUI().getSkillById(skillId) : null;
	let range;
	if (skill) {
		range = skill.attackRange + 1;
	} else if (SkillInfo[skillId]) {
		range = SkillInfo[skillId].AttackRange[level - 1] + 1;
	} else {
		range = player.attack_range + 1;
	}

	const out = [];
	const count = PathFinding.search(
		player.position[0] | 0, player.position[1] | 0,
		target.position[0] | 0, target.position[1] | 0,
		range,
		out,
		Altitude.TYPE.WALKABLE
	);

	if (!count) {
		return false;
	}

	let pkt;
	if (PACKETVER.value >= 20180307) {
		pkt = new PACKET.CZ.USE_SKILL2();
	} else {
		pkt = new PACKET.CZ.USE_SKILL();
	}
	pkt.SKID = skillId;
	pkt.selectedLevel = level;
	pkt.targetID = target.GID;

	if (count < 2) {
		Network.sendPacket(pkt);
		return true;
	}

	setMoveAction(pkt);
	if (PACKETVER.value >= 20180307) {
		pkt = new PACKET.CZ.REQUEST_MOVE2();
	} else {
		pkt = new PACKET.CZ.REQUEST_MOVE();
	}
	pkt.dest[0] = out[(count - 1) * 2 + 0];
	pkt.dest[1] = out[(count - 1) * 2 + 1];
	Network.sendPacket(pkt);
	return true;
}

function sendLoot(item) {
	const player = getPlayer();
	if (!player || !item) {
		return false;
	}
	if (Session.moveAction) {
		return false;
	}

	const dist = vec2.distance(player.position, item.position);
	let pkt;
	if (PACKETVER.value >= 20180307) {
		pkt = new PACKET.CZ.ITEM_PICKUP2();
	} else {
		pkt = new PACKET.CZ.ITEM_PICKUP();
	}
	pkt.ITAID = item.GID;

	if (dist > 2) {
		setMoveAction(pkt);
		if (PACKETVER.value >= 20180307) {
			pkt = new PACKET.CZ.REQUEST_MOVE2();
		} else {
			pkt = new PACKET.CZ.REQUEST_MOVE();
		}
		// move to item position
		pkt.dest[0] = Math.floor(item.position[0]);
		pkt.dest[1] = Math.floor(item.position[1]);

		// try to find free cell near item
		const out = [];
		const found = checkFreeCellNear(pkt.dest[0], pkt.dest[1], 2, out);
		if (found) {
			pkt.dest[0] = out[0];
			pkt.dest[1] = out[1];
		}
		Network.sendPacket(pkt);
		return true;
	}

	Network.sendPacket(pkt);
	return true;
}

function checkFreeCellNear(x, y, range, out) {
	for (let r = 0; r <= range; ++r) {
		for (let dx = -r; dx <= r; ++dx) {
			for (let dy = -r; dy <= r; ++dy) {
				const nx = x + dx;
				const ny = y + dy;
				if (!(Altitude.getCellType(nx, ny) & Altitude.TYPE.WALKABLE)) {
					continue;
				}
				let free = true;
				EntityManager.forEach(entity => {
					if (entity.objecttype !== Entity.TYPE_EFFECT &&
						entity.objecttype !== Entity.TYPE_UNIT &&
						entity.objecttype !== Entity.TYPE_TRAP &&
						Math.round(entity.position[0]) === nx &&
						Math.round(entity.position[1]) === ny) {
						free = false;
						return false;
					}
					return true;
				});
				if (free) {
					out[0] = nx;
					out[1] = ny;
					return true;
				}
			}
		}
	}
	return false;
}

function isFreeCellForRoam(x, y) {
	if (!(Altitude.getCellType(x, y) & Altitude.TYPE.WALKABLE)) {
		return false;
	}
	let free = true;
	EntityManager.forEach(entity => {
		if (entity.objecttype !== Entity.TYPE_EFFECT &&
			entity.objecttype !== Entity.TYPE_UNIT &&
			entity.objecttype !== Entity.TYPE_TRAP &&
			Math.round(entity.position[0]) === x &&
			Math.round(entity.position[1]) === y) {
			free = false;
			return false;
		}
		return true;
	});
	return free;
}

function findClosestWalkable(x, y, rad) {
	if (isFreeCellForRoam(x, y)) {
		return { x, y };
	}
	for (let r = 1; r <= rad; ++r) {
		for (let dx = -r; dx <= r; ++dx) {
			for (let dy = -r; dy <= r; ++dy) {
				if (Math.abs(dx) !== r && Math.abs(dy) !== r) {
					continue;
				}
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= Altitude.width || ny >= Altitude.height) {
					continue;
				}
				if (isFreeCellForRoam(nx, ny)) {
					return { x: nx, y: ny };
				}
			}
		}
	}
	return null;
}

function pickRandomRoamDest() {
	const p = getPlayer();
	if (!p || !Altitude.width) {
		return null;
	}
	const cx = Prefs.lockCenter ? Prefs.centerX : Math.floor(p.position[0]);
	const cy = Prefs.lockCenter ? Prefs.centerY : Math.floor(p.position[1]);
	const range = Prefs.lockCenter ? Prefs.maxDistance : (Prefs.roamRange || Prefs.range);
	const tries = Prefs.roamTries || 10;
	const out = [];

	for (let attempt = 0; attempt < tries; ++attempt) {
		const rx = cx + (Math.floor(Math.random() * (range * 2 + 1)) - range);
		const ry = cy + (Math.floor(Math.random() * (range * 2 + 1)) - range);
		if (rx < 0 || ry < 0 || rx >= Altitude.width || ry >= Altitude.height) {
			continue;
		}
		let tx = rx;
		let ty = ry;
		if (!isFreeCellForRoam(tx, ty)) {
			const found = findClosestWalkable(rx, ry, 3);
			if (!found) {
				continue;
			}
			tx = found.x;
			ty = found.y;
		}
		const count = PathFinding.search(Math.floor(p.position[0]), Math.floor(p.position[1]), tx, ty, 0, out);
		if (!count || count > PathFinding.MAX_WALKPATH) {
			continue;
		}
		if (Prefs.lockCenter) {
			const cdx = tx - cx;
			const cdy = ty - cy;
			if (cdx * cdx + cdy * cdy > range * range) {
				continue;
			}
		}
		return [tx, ty];
	}

	// Fallback: enumerate walkable cells in range
	if (Altitude.getCellsInSquareRange) {
		const cells = Altitude.getCellsInSquareRange(Math.floor(p.position[0]), Math.floor(p.position[1]), range);
		for (let i = cells.length - 1; i > 0; --i) {
			const j = Math.floor(Math.random() * (i + 1));
			const tmp = cells[i];
			cells[i] = cells[j];
			cells[j] = tmp;
		}
		for (const c of cells) {
			if (!isFreeCellForRoam(c.x, c.y)) {
				continue;
			}
			if (Prefs.lockCenter) {
				const cdx = c.x - cx;
				const cdy = c.y - cy;
				if (cdx * cdx + cdy * cdy > range * range) {
					continue;
				}
			}
			const cnt = PathFinding.search(Math.floor(p.position[0]), Math.floor(p.position[1]), c.x, c.y, 0, out);
			if (cnt) {
				return [c.x, c.y];
			}
		}
	}

	return null;
}

function tryRoam() {
	if (!Prefs.roamWhenIdle || Session.moveAction) {
		return false;
	}
	const p = getPlayer();
	if (!p || p.walk.total !== 0) {
		return false;
	}
	if (Renderer.tick - _lastRoamTick < Prefs.roamInterval) {
		return false;
	}
	const dest = pickRandomRoamDest();
	if (!dest) {
		return false;
	}
	let pkt;
	if (PACKETVER.value >= 20180307) {
		pkt = new PACKET.CZ.REQUEST_MOVE2();
	} else {
		pkt = new PACKET.CZ.REQUEST_MOVE();
	}
	pkt.dest[0] = dest[0];
	pkt.dest[1] = dest[1];
	Network.sendPacket(pkt);
	_lastRoamTick = Renderer.tick;
	_roamDest = dest;
	return true;
}

function handleDeath() {
	if (Prefs.stopOnDeath) {
		stop();
		ChatBox.addText('AutoBattle: stopped (player dead)', ChatBox.TYPE.ERROR, ChatBox.FILTER.PUBLIC_LOG);
		return;
	}

	// Try resurrection with Token of Siegfried (item 7621)
	const ui = Inventory.getUI();
	let hasToken = false;
	if (ui && ui.getItemById) {
		hasToken = !!ui.getItemById(7621);
	}

	if (hasToken) {
		const pkt = new PACKET.CZ.STANDING_RESURRECTION();
		Network.sendPacket(pkt);
		ChatBox.addText('AutoBattle: trying resurrection', ChatBox.TYPE.INFO, ChatBox.FILTER.PUBLIC_LOG);
	} else {
		const pkt = new PACKET.CZ.RESTART();
		pkt.type = 0;
		Network.sendPacket(pkt);
		ChatBox.addText('AutoBattle: returning to save point', ChatBox.TYPE.INFO, ChatBox.FILTER.PUBLIC_LOG);
	}
}

function tryTeleportSlots() {
	const slots = Array.isArray(Prefs.teleportSlots) ? Prefs.teleportSlots : [];
	if (!slots[0] && !slots[1]) {
		return false;
	}
	// Teleport items/skills require standing (e.g. escaping while sit-resting).
	sendStandUp();
	for (let i = 0; i < 2; i++) {
		if (useTeleportAction(slots[i])) {
			return true;
		}
	}
	return false;
}

function tryTeleport(now) {
	if (!Prefs.useTeleportOnNoTarget) {
		return false;
	}
	let sec = parseInt(Prefs.teleportNoTargetSec, 10);
	if (isNaN(sec)) {
		sec = 30;
	}
	sec = Math.max(5, Math.min(300, sec));
	if (now - _lastTargetSeenTick < sec * 1000) {
		return false;
	}
	// Timer elapsed: try slots in order, then restart timing
	_lastTargetSeenTick = now;
	return tryTeleportSlots();
}

function useTeleportAction(action) {
	if (!action) {
		return false;
	}
	if (action.kind === 'skill') {
		if (action.SKID === SkillId.AL_TELEPORT) {
			// Teleport opens a warp-point menu: auto-pick the first entry
			setAutoSelectWarpTick(Renderer.tick);
		}
		return useSkillOnSelf(action.SKID, action.level);
	}
	const ui = Inventory.getUI();
	let item = null;
	if (ui && ui.getItemById) {
		item = ui.getItemById(action.ITID);
	}
	if (!item) {
		return false;
	}
	useItemByIndex(item.index);
	return true;
}

// SKID -> EFST status index (see DB/Status/StatusConst.js).
// Buffs not listed here fall back to timed re-cast.
const BUFF_STATUS_MAP = {
	[SkillId.SM_ENDURE]: 1, // EFST_ENDURE
	[SkillId.AL_ANGELUS]: 9, // EFST_ANGELUS
	[SkillId.AL_BLESSING]: 10, // EFST_BLESSING
	[SkillId.AL_INCAGI]: 12, // EFST_INC_AGI
	[SkillId.PR_IMPOSITIO]: 15, // EFST_IMPOSITIO
	[SkillId.PR_MAGNIFICAT]: 20, // EFST_MAGNIFICAT
	[SkillId.PR_GLORIA]: 21 // EFST_GLORIA
};

const BUFF_RECAST_MS = 60000;

const _buffLastCast = [0, 0, 0, 0, 0];

function isStatusIconActive(efst) {
	// Single source of truth: StatusIcons is fed by Entity's
	// onEntityStatusChange (the only MSG_STATE_CHANGE hook owner).
	try {
		if (StatusIcons && typeof StatusIcons.has === 'function') {
			return StatusIcons.has(efst);
		}
	} catch (_e) {
		// fall through to "missing" so the buff gets (re)cast
	}
	return false;
}

function isBuffActive(action, slotIndex, now) {
	// Just casted: avoid spam while the state packet is in flight
	if (now - (_buffLastCast[slotIndex] || 0) < BUFF_RECAST_MS) {
		return true;
	}
	if (action.kind === 'skill') {
		const efst = BUFF_STATUS_MAP[action.SKID];
		if (typeof efst === 'number') {
			return isStatusIconActive(efst);
		}
	}
	return false;
}

function tryKeepBuffs(now) {
	if (!Prefs.buffEnabled) {
		return false;
	}
	const slots = Array.isArray(Prefs.buffSlots) ? Prefs.buffSlots : [];
	for (let i = 0; i < slots.length; i++) {
		const action = slots[i];
		if (!action) {
			continue;
		}
		if (isBuffActive(action, i, now)) {
			continue;
		}
		let ok = false;
		if (action.kind === 'skill') {
			ok = useSkillOnSelf(action.SKID, action.level);
		} else {
			const ui = Inventory.getUI();
			const item = ui && ui.getItemById ? ui.getItemById(action.ITID) : null;
			if (item) {
				useItemByIndex(item.index);
				ok = true;
			}
		}
		if (ok) {
			_buffLastCast[i] = now;
			return true;
		}
	}
	return false;
}

/**
 * Track our own chase/pickup move so a watchdog can clear it when the
 * arrival never comes (unreachable target, lost packet). Only clears when
 * Session.moveAction is still our own packet (manual clicks replace it).
 */
function setMoveAction(pkt) {
	const player = getPlayer();
	Session.moveAction = pkt;
	_moveActionPkt = pkt;
	_moveActionTick = Renderer.tick;
	_moveActionPos = player ? [Math.floor(player.position[0]), Math.floor(player.position[1])] : null;
}

function dropMoveAction() {
	Session.moveAction = null;
	_moveActionPkt = null;
	_moveActionTick = 0;
	_moveActionPos = null;
}

function clearStaleMoveAction(now) {
	// Only ever touch our own packet (manual clicks replace it outright)
	if (!_moveActionPkt || Session.moveAction !== _moveActionPkt) {
		return;
	}
	const age = now - _moveActionTick;
	// Outer backstop: arrival never came
	if (age > MOVE_TIMEOUT_MS) {
		dropMoveAction();
		return;
	}
	// Stuck detection: standing on the same cell for a while means the
	// server is not moving us (blocked path, lost packet). Normal long
	// chases keep changing cells, and skill cast bars never set moveAction,
	// so neither is affected.
	if (age > MOVE_STUCK_MS && _moveActionPos) {
		const player = getPlayer();
		if (player &&
			Math.floor(player.position[0]) === _moveActionPos[0] &&
			Math.floor(player.position[1]) === _moveActionPos[1]) {
			dropMoveAction();
		}
	}
}

function tickImpl() {
	if (!_enabled || !Prefs.enabled) {
		return;
	}

	if (!isPlayerValid()) {
		const p = getPlayer();
		if (p && (p.action === p.ACTION.DIE || (p.life && p.life.hp <= 0))) {
			handleDeath();
		}
		schedule();
		return;
	}

	if (isOverWeight()) {
		schedule();
		return;
	}

	const now = Renderer.tick;

	// Watchdog: clear our own chase/pickup move when arrival never comes
	clearStaleMoveAction(now);

	// Sit-to-recover (independent card): resting blocks potions/buffs/loot/combat.
	const restState = handleSitRest();
	if (restState === 'resting') {
		// Emergency escape still wins while resting (stand + teleport).
		const cfg = getSitRecovery();
		if (cfg.enabled) {
			const countThreshold = typeof Prefs.attackedTeleportCount === 'number' ? Prefs.attackedTeleportCount : 0;
			if (countThreshold > 0 && getMobAttackers(now).length > countThreshold) {
				if (tryTeleportSlots()) {
					_lastTargetSeenTick = now;
					_retaliateGID = null;
				}
			}
		}
		schedule();
		return;
	}

	// Potion check each tick (fast)
	tryUsePotion();

	// Keep buffs up (one cast per tick at most, never blocks combat)
	tryKeepBuffs(now);

	// Under-attack policy (count escape wins, retaliation overrides target)
	if (handleAttacked(now)) {
		schedule();
		return;
	}

	// Loot has priority if close and no combat
	if (Prefs.loot && now - _lastLootTick > 300) {
		const loot = findLoot();
		if (loot) {
			const player = getPlayer();
			const d = vec2.distance(player.position, loot.position);
			if (d <= 2 || d <= Prefs.range) {
				if (sendLoot(loot)) {
					_lastLootTick = now;
					schedule();
					return;
				}
			}
		}
	}

	// Attack throttle
	if (now - _lastAttackTick < Prefs.attackInterval) {
		schedule();
		return;
	}

	const target = findTarget();
	if (!target) {
		tryTeleport(now);
		tryRoam();
		schedule();
		return;
	}

	// Found target: refresh no-target timer, cancel roam state and attack
	_lastTargetSeenTick = now;
	_roamDest = null;
	if (sendAttack(target)) {
		_lastAttackTick = now;
	}

	schedule();
}

/**
 * Tick wrapper: heartbeat + guarantee the timer is always re-armed,
 * so a bug can never silently freeze auto-battle anymore.
 */
function tick() {
	_tickCount++;
	try {
		tickImpl();
	} catch (e) {
		console.error('[AutoBattle] tick error (timer kept alive):', e);
	} finally {
		schedule();
	}
}

function schedule() {
	if (_timer !== null) {
		Events.clearTimeout(_timer);
	}
	if (!_enabled || !Prefs.enabled) {
		return;
	}
	_timer = Events.setTimeout(tick, Prefs.attackInterval);
}

function start() {
	if (_enabled) {
		return;
	}
	_enabled = true;
	Prefs.enabled = true;
	Prefs.save();

	const p = getPlayer();
	if (Prefs.lockCenter && p) {
		Prefs.centerX = Math.floor(p.position[0]);
		Prefs.centerY = Math.floor(p.position[1]);
		Prefs.save();
	}

	_lastAttackTick = 0;
	_lastLootTick = 0;
	_lastRoamTick = 0;
	_lastTargetSeenTick = Renderer.tick;
	_moveActionPkt = null;
	_moveActionTick = 0;
	_moveActionPos = null;
	_retaliateGID = null;
	_roamDest = null;
	_resting = false;
	// Fresh round: clear buff re-cast gates so enabling always tops up
	// actually-missing buffs (mapped skills are still skipped via live
	// StatusIcons check when genuinely active).
	for (let i = 0; i < _buffLastCast.length; i++) {
		_buffLastCast[i] = 0;
	}
	ChatBox.addText('AutoBattle: ON', ChatBox.TYPE.INFO, ChatBox.FILTER.PUBLIC_LOG);
	schedule();
}

function stop() {
	if (!_enabled && !Prefs.enabled) {
		return;
	}
	_enabled = false;
	Prefs.enabled = false;
	Prefs.save();

	if (_timer !== null) {
		Events.clearTimeout(_timer);
		_timer = null;
	}

	_lastRoamTick = 0;
	_retaliateGID = null;
	_roamDest = null;
	_resting = false;
	sendStandUp();
	Session.moveAction = null;
	_moveActionPkt = null;
	_moveActionTick = 0;
	ChatBox.addText('AutoBattle: OFF', ChatBox.TYPE.INFO, ChatBox.FILTER.PUBLIC_LOG);
}

function toggle() {
	if (isEnabled()) {
		stop();
	} else {
		start();
	}
}

function init() {
	_enabled = !!Prefs.enabled;
	// NOTE: do NOT hook ZC.MSG_STATE_CHANGE* here. hookPacket() replaces the
	// previous callback instead of chaining, so hooking would steal Entity's
	// onEntityStatusChange and break the StatusIcons buff display.
	// Buff presence is read via StatusIcons.has() instead (see isBuffActive).
	if (_enabled) {
		// Delay start until map fully loaded
		Events.setTimeout(() => {
			if (Prefs.enabled) {
				_enabled = false;
				start();
			}
		}, 1000);
	}
}

function setEnabled(v) {
	if (v) {
		start();
	} else {
		stop();
	}
}

function getStats() {
	const player = getPlayer();
	const now = Renderer.tick;
	let hasTarget = false;
	try {
		hasTarget = !!findTarget();
	} catch (_e) {
		hasTarget = 'error';
	}
	const sitCfg = getSitRecovery();
	return {
		enabled: isEnabled(),
		prefsEnabled: !!Prefs.enabled,
		killCount: _killCount,
		range: Prefs.range,
		tickCount: _tickCount,
		timerPending: _timer !== null,
		moveAction: !!Session.moveAction,
		moveActionOurs: !!(_moveActionPkt && Session.moveAction === _moveActionPkt),
		moveActionAgeMs: (_moveActionPkt && Session.moveAction === _moveActionPkt) ? now - _moveActionTick : 0,
		amotionRemainingMs: player && player.amotionTick ? Math.max(0, player.amotionTick - now) : 0,
		hasTarget: hasTarget,
		lastAttackAgoMs: now - _lastAttackTick,
		buffEnabled: !!Prefs.buffEnabled,
		attackedCount: getMobAttackers(now).length,
		retaliateGID: _retaliateGID,
		sitting: isSitting(),
		resting: _resting,
		sitRecovery: `enabled=${sitCfg.enabled} sit=${sitCfg.sitTarget}<=${sitCfg.sitThreshold}% stand=${sitCfg.standTarget}>=${sitCfg.standThreshold}% hp=${Math.round(getHpPercent())}% sp=${Math.round(getSpPercent())}%`,
		buffSlots: getBuffSlotDiagnostics(now)
	};
}

function describeBuffAction(action) {
	if (!action) {
		return 'empty';
	}
	if (action.kind === 'skill') {
		return `skill:${action.SKID}@${action.level || 1}`;
	}
	return `item:${action.ITID}`;
}

function getBuffSlotDiagnostics(now) {
	const slots = Array.isArray(Prefs.buffSlots) ? Prefs.buffSlots : [];
	const out = [];
	for (let i = 0; i < slots.length; i++) {
		const action = slots[i];
		if (!action) {
			out.push(`${i}:empty`);
			continue;
		}
		let icon = '-';
		if (action.kind === 'skill') {
			const efst = BUFF_STATUS_MAP[action.SKID];
			if (typeof efst === 'number') {
				icon = isStatusIconActive(efst) ? 'on' : 'off';
			} else {
				icon = 'unmapped';
			}
		}
		let active = false;
		try {
			active = isBuffActive(action, i, now);
		} catch (_e) {
			active = 'error';
		}
		out.push(`${i}:${describeBuffAction(action)} lastCast=${now - (_buffLastCast[i] || 0)}ms icon=${icon} skip=${active}`);
	}
	return out.join(' | ');
}

export default {
	init,
	start,
	stop,
	toggle,
	isEnabled,
	setEnabled,
	getStats,
	tick,
	// expose for UI/testing
	_findTarget: findTarget,
	_findLoot: findLoot
};
