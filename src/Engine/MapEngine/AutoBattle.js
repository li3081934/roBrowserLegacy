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
const TICK_MS = 200;
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

// ---- State machine (idle|chase|combat|loot|resting|casting) ----
// Packets are sent on state entry / transitions only; while staying in a
// state the tick only monitors. The server maintains continuous attack,
// walk completion auto-fires the stashed moveAction (MapEngine onWalkEnd).
const ST_IDLE = 'idle';
const ST_CHASE = 'chase';
const ST_COMBAT = 'combat';
const ST_LOOT = 'loot';
const ST_RESTING = 'resting';
const ST_CASTING = 'casting';
let _state = ST_IDLE;
let _stateTick = 0;
let _stateGID = null; // bound target GID for chase/combat/loot
let _statePos = null; // [x, y] target snapshot at last chase-move send
let _planFailCount = 0;
let _lootLastSend = 0;
const LOOT_TIMEOUT_MS = 10000;
const LOOT_RESEND_MS = 2000;
// Chase: resend move only when the target walked this many cells away
// from the snapshot (or the watchdog dropped our move).
const CHASE_REPATH_CELLS = 3;
// Combat (normal attack): safety-net re-fire when the server seemingly
// stopped without any event (target alive, in range, us idle).
const COMBAT_REATTACK_MS = 5000;
// Combat (attack skill): re-fire no earlier than this after the last fire,
// extended by the observed cast length (client has no Delay/Cooldown data).
const SKILL_REFIRE_FLOOR_MS = 150; // just above server min (100 + SECURITY 100)
const SKILL_REFIRE_CAST_MARGIN_MS = 200;
let _skillBeatTimer = null; // exact-time combat-skill refire, decoupled from the 200ms tick grid
let _skillLastFire = 0;
// Set when our own skill cast interrupted continuous attack: refire once.
let _combatDisrupted = false;
// Casting satellite state: remembers where to resume.
let _pendingCast = null; // { skillId, sentWall, confirmed, barStartWall, delay, returnState, result }
const _skillCastLen = {}; // SKID -> last observed cast ms ('instant' for none)
let _castLastInfo = '-';
const CAST_CONFIRM_MS = 800; // wait for server ack before judging instant skills
const CAST_TIMEOUT_EXTRA_MS = 3000; // hard backstop (stalled render loop, lost packets)

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
	// Sitting is rejected server-side while casting; don't waste the packet.
	if (isCastDisplayActive()) {
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

function setState(next, now) {
	if (_state === next) {
		return;
	}
	_state = next;
	_stateTick = (typeof now === 'number') ? now : Renderer.tick;
	if (next !== ST_CHASE && next !== ST_COMBAT && next !== ST_LOOT) {
		_stateGID = null;
	}
	if (next !== ST_CHASE) {
		_statePos = null;
	}
	_planFailCount = 0;
}

function getState() {
	return _state;
}

function useSkillMode() {
	return !!(Prefs.useSkill && Prefs.skillId);
}

function skillRefireFloor(skillId) {
	const learned = _skillCastLen[skillId] || 0;
	return Math.max(SKILL_REFIRE_FLOOR_MS, learned + SKILL_REFIRE_CAST_MARGIN_MS);
}

function armSkillBeat(ms) {
	if (_skillBeatTimer !== null) {
		Events.clearTimeout(_skillBeatTimer);
		_skillBeatTimer = null;
	}
	if (!_enabled || !Prefs.enabled) {
		return;
	}
	_skillBeatTimer = Events.setTimeout(onSkillBeat, Math.max(50, ms));
}

/**
 * Exact-time combat-skill refire, decoupled from the 200ms monitoring tick
 * so chaining gaps track the floor instead of the tick grid. Any state
 * change in between makes this a no-op; the tick owns all transitions.
 */
function onSkillBeat() {
	_skillBeatTimer = null;
	if (!_enabled || !Prefs.enabled) {
		return;
	}
	if (_state !== ST_COMBAT || !useSkillMode()) {
		return;
	}
	if (!isPlayerValid() || isOverWeight()) {
		return;
	}
	const target = resolveBoundTarget(Renderer.tick);
	if (!target) {
		return;
	}
	const plan = getAttackPlan(target);
	if (!plan || plan.count >= 2) {
		return;
	}
	if (isBusy()) {
		armSkillBeat(SKILL_REFIRE_FLOOR_MS);
		return;
	}
	fireAttackDirect(target); // re-arms the beat itself
}

function ownMovePending() {
	return !!(_moveActionPkt && Session.moveAction === _moveActionPkt);
}

function foreignMoveActive() {
	return !!(Session.moveAction && Session.moveAction !== _moveActionPkt);
}

function isCastDisplayActive() {
	const p = getPlayer();
	const cast = p && p.cast;
	if (!cast || !cast.display || !(cast.delay > 0)) {
		return false;
	}
	return (Date.now() - cast.tick) < cast.delay;
}

/**
 * Global send guard: while busy, combat/loot/roam packets must not go out.
 * Casting (satellite state or visible bar), resting/sitting and our own
 * in-flight move each block new sends.
 */
function isBusy() {
	if (_state === ST_CASTING || _state === ST_RESTING) {
		return true;
	}
	if (isCastDisplayActive()) {
		return true;
	}
	if (isSitting()) {
		return true;
	}
	if (ownMovePending()) {
		return true;
	}
	return false;
}

/**
 * Enter the casting satellite state. Sending the skill and entering must
 * be atomic (same code path) so there is no blind window.
 */
function enterCasting(returnState, skillId) {
	if (_state === ST_CASTING) {
		return;
	}
	const learned = _skillCastLen[skillId];
	_pendingCast = {
		skillId: skillId || 0,
		sentWall: Date.now(),
		confirmed: false,
		barStartWall: 0,
		delay: (typeof learned === 'number' && learned > 0) ? learned : 0,
		returnState: returnState === ST_CASTING ? ST_IDLE : returnState,
		result: '-'
	};
	setState(ST_CASTING, Renderer.tick);
}

function exitCasting(result, now) {
	const ret = (_pendingCast && _pendingCast.returnState) || ST_IDLE;
	const skillId = _pendingCast && _pendingCast.skillId;
	_castLastInfo = `${skillId || '?'}:${result}`;
	_pendingCast = null;
	// Any own cast (landed or not) leaves server canact hot past what we
	// can see: the next skill send waits out the grace in useSkillOnSelf.
	_lastOwnCastEndTick = now;
	// Our own cast stopped continuous attack: refire once when resuming
	// normal-attack combat (skill-mode combat re-fires on its own beat).
	if (ret === ST_COMBAT && !useSkillMode()) {
		_combatDisrupted = true;
	}
	setState(ret, now);
}

function updateCasting(now) {
	const p = getPlayer();
	const wall = Date.now();
	const cast = p && p.cast;
	const displaying = !!(cast && cast.display && cast.delay > 0);
	if (displaying) {
		if (!_pendingCast.confirmed) {
			_pendingCast.confirmed = true;
			_pendingCast.barStartWall = wall;
		}
		_pendingCast.delay = cast.delay;
		if (_pendingCast.skillId) {
			_skillCastLen[_pendingCast.skillId] = cast.delay;
		}
		const elapsed = wall - cast.tick;
		if (elapsed >= cast.delay) {
			exitCasting('ok', now);
			return;
		}
		if (elapsed > cast.delay + CAST_TIMEOUT_EXTRA_MS) {
			exitCasting('timeout', now);
		}
		return;
	}
	// No bar visible.
	const elapsed = wall - _pendingCast.sentWall;
	if (!_pendingCast.confirmed) {
		// Waiting for the server ack; instant-cast skills never show a bar.
		if (elapsed < CAST_CONFIRM_MS) {
			return;
		}
		exitCasting('instant', now);
		return;
	}
	// Bar was showing, now gone early = cancelled (e.g. ZC.DISPEL).
	const shownFor = wall - (_pendingCast.barStartWall || _pendingCast.sentWall);
	if (shownFor >= _pendingCast.delay * 0.95) {
		exitCasting('ok', now);
		return;
	}
	const limit = Math.max(_pendingCast.delay, CAST_CONFIRM_MS) + CAST_TIMEOUT_EXTRA_MS;
	if (elapsed > limit) {
		exitCasting('timeout', now);
		return;
	}
	exitCasting('cancelled', now);
}

/**
 * Sit-to-recover as a real state (independent from recoveryRules).
 */
function updateResting(now) {
	const cfg = getSitRecovery();
	if (!cfg.enabled) {
		sendStandUp();
		setState(ST_IDLE, now);
		return;
	}
	if (getSitPercent(cfg.standTarget) >= cfg.standThreshold) {
		sendStandUp();
		setState(ST_IDLE, now);
		return;
	}
	sendSitDown();
	// Emergency escape still wins while resting (stand + teleport).
	const countThreshold = typeof Prefs.attackedTeleportCount === 'number' ? Prefs.attackedTeleportCount : 0;
	if (countThreshold > 0 && getMobAttackers(now).length > countThreshold) {
		if (tryTeleportSlots()) {
			_lastTargetSeenTick = now;
			_retaliateGID = null;
			setState(ST_IDLE, now);
		}
	}
}

function maybeEnterResting(now) {
	if (_state === ST_RESTING || _state === ST_CASTING) {
		return false;
	}
	const cfg = getSitRecovery();
	if (!cfg.enabled) {
		return false;
	}
	if (getSitPercent(cfg.sitTarget) <= cfg.sitThreshold) {
		// Abandon our own chase/pickup move so the sit packet is not
		// blocked by it; the server stops the walk on sit. Manual moves
		// are left alone (sit goes out once they finish).
		if (ownMovePending()) {
			dropMoveAction();
		}
		setState(ST_RESTING, now);
		sendSitDown();
		return true;
	}
	return false;
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
	// Post-cast grace: our own previous cast leaves server canact hot past
	// its visible end (e.g. IncAgi's 400ms aftercast, invisible to us). The
	// next skill sent inside it duds deterministically, so hold briefly.
	if (Renderer.tick - _lastOwnCastEndTick < OWN_CAST_GRACE_MS) {
		return false;
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
	// Atomic with the send: track the cast in the satellite state so the
	// blind window (before the server ack creates the cast bar) is covered.
	enterCasting(_state, SKID);
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

function getCombatRange() {
	const player = getPlayer();
	if (useSkillMode()) {
		const skillId = Prefs.skillId;
		const level = Prefs.skillLevel || 1;
		const skill = SkillList.getUI() ? SkillList.getUI().getSkillById(skillId) : null;
		if (skill) {
			return skill.attackRange + 1;
		}
		if (SkillInfo[skillId]) {
			return SkillInfo[skillId].AttackRange[level - 1] + 1;
		}
	}
	return player ? player.attack_range + 1 : 1;
}

/**
 * Pathfind-only probe shared by chase/combat. Returns null when the target
 * is unreachable, else { count, out, range, skill }.
 * Packet construction is unchanged from the old send functions.
 */
function getAttackPlan(target) {
	const player = getPlayer();
	if (!player || !target) {
		return null;
	}
	const skill = useSkillMode();
	const range = getCombatRange();
	const out = [];
	let count;
	if (skill) {
		count = PathFinding.search(
			player.position[0] | 0, player.position[1] | 0,
			target.position[0] | 0, target.position[1] | 0,
			range,
			out,
			Altitude.TYPE.WALKABLE
		);
	} else {
		count = PathFinding.search(
			player.position[0] | 0, player.position[1] | 0,
			target.position[0] | 0, target.position[1] | 0,
			range,
			out
		);
	}
	if (!count) {
		return null;
	}
	return { count: count, out: out, range: range, skill: skill };
}

function sendChangeDirection() {
	const player = getPlayer();
	if (!player) {
		return;
	}
	let pkt;
	if (PACKETVER.value >= 20180307) {
		pkt = new PACKET.CZ.CHANGE_DIRECTION2();
	} else {
		pkt = new PACKET.CZ.CHANGE_DIRECTION();
	}
	pkt.headDir = player.headDir;
	pkt.dir = player.direction;
	Network.sendPacket(pkt);
}

/**
 * Fire once at a target already in range (plan.count < 2).
 * Normal attack is server-maintained afterwards; attack skills are
 * one-shot and re-fired by the combat beat.
 */
function fireAttackDirect(target) {
	const player = getPlayer();
	if (!player || !target) {
		return false;
	}
	if (player.amotionTick && player.amotionTick > Renderer.tick) {
		return false;
	}
	if (Session.moveAction) {
		return false;
	}
	if (useSkillMode()) {
		const skillId = Prefs.skillId;
		const level = Prefs.skillLevel || 1;
		// SP pre-check (mirrors useSkillOnSelf): hold the beat while broke
		// instead of spamming doomed sends; regen resumes it automatically.
		const info = SkillInfo[skillId];
		if (info && Array.isArray(info.SpAmount) && info.SpAmount.length) {
			const cost = info.SpAmount[Math.min(level, info.SpAmount.length) - 1];
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
		pkt.SKID = skillId;
		pkt.selectedLevel = level;
		pkt.targetID = target.GID;
		Network.sendPacket(pkt);
		_skillLastFire = Renderer.tick;
		// Enter the satellite state only when a cast bar is actually expected
		// (learned before). Instant sends skip it: a dud then costs exactly
		// one dropped packet instead of an 800ms combat freeze, while a real
		// bar is still picked up by the passive detector (which learns).
		if ((_skillCastLen[skillId] || 0) > 0) {
			enterCasting(_state, skillId);
		}
		armSkillBeat(skillRefireFloor(skillId));
		return true;
	}
	if (player.isOverWeight) {
		ChatBox.addText(DB.getMessage(243), ChatBox.TYPE.ERROR, ChatBox.FILTER.PUBLIC_LOG);
		return false;
	}
	player.lookTo(target.position[0], target.position[1]);
	sendChangeDirection();
	let pkt;
	if (PACKETVER.value >= 20180307) {
		pkt = new PACKET.CZ.REQUEST_ACT2();
	} else {
		pkt = new PACKET.CZ.REQUEST_ACT();
	}
	pkt.action = 7;
	pkt.targetGID = target.GID;
	Network.sendPacket(pkt);
	return true;
}

/**
 * Start (or restart) walking toward the target; the stashed action packet
 * is auto-sent by MapEngine onWalkEnd on arrival.
 */
function sendChaseMove(target, plan) {
	const player = getPlayer();
	if (!player || !target || !plan) {
		return false;
	}
	let pkt;
	if (plan.skill) {
		const level = Prefs.skillLevel || 1;
		if (PACKETVER.value >= 20180307) {
			pkt = new PACKET.CZ.USE_SKILL2();
		} else {
			pkt = new PACKET.CZ.USE_SKILL();
		}
		pkt.SKID = Prefs.skillId;
		pkt.selectedLevel = level;
		pkt.targetID = target.GID;
	} else {
		if (player.isOverWeight) {
			ChatBox.addText(DB.getMessage(243), ChatBox.TYPE.ERROR, ChatBox.FILTER.PUBLIC_LOG);
			return false;
		}
		player.lookTo(target.position[0], target.position[1]);
		sendChangeDirection();
		if (PACKETVER.value >= 20180307) {
			pkt = new PACKET.CZ.REQUEST_ACT2();
		} else {
			pkt = new PACKET.CZ.REQUEST_ACT();
		}
		pkt.action = 7;
		pkt.targetGID = target.GID;
	}
	setMoveAction(pkt);
	if (PACKETVER.value >= 20180307) {
		pkt = new PACKET.CZ.REQUEST_MOVE2();
	} else {
		pkt = new PACKET.CZ.REQUEST_MOVE();
	}
	pkt.dest[0] = plan.out[(plan.count - 1) * 2 + 0];
	pkt.dest[1] = plan.out[(plan.count - 1) * 2 + 1];
	Network.sendPacket(pkt);
	_statePos = [Math.floor(target.position[0]), Math.floor(target.position[1])];
	return true;
}

/**
 * Resolve the bound target GID to a live entity. Retaliation override wins
 * and rebinds. Returns the entity or null (dead/gone/invalid).
 */
function resolveBoundTarget(now) {
	const player = getPlayer();
	if (!player || _stateGID === null) {
		return null;
	}
	const retaliation = getRetaliationTarget(player.position[0], player.position[1]);
	if (retaliation) {
		if (retaliation.GID !== _stateGID) {
			_stateGID = retaliation.GID;
			_statePos = null;
			_planFailCount = 0;
		}
		return retaliation;
	}
	let entity = null;
	try {
		entity = EntityManager.get(_stateGID);
	} catch (_e) {
		entity = null;
	}
	if (!isMobEntity(entity) || entity.action === entity.ACTION.DIE || entity.remove_tick !== 0) {
		return null;
	}
	if (entity.isVisible && !entity.isVisible()) {
		return null;
	}
	return entity;
}

function boundTargetGoneDead() {
	if (_stateGID === null) {
		return false;
	}
	let entity = null;
	try {
		entity = EntityManager.get(_stateGID);
	} catch (_e) {
		entity = null;
	}
	return !isMobEntity(entity) || entity.action === entity.ACTION.DIE || entity.remove_tick !== 0;
}

/**
 * Chase-only gates (range / lock-center / target filter). Combat keeps the
 * old stickiness: once engaged, only death/gone/invisible/unreachable ends it.
 */
function passesChaseGates(entity) {
	const player = getPlayer();
	if (!player || !entity) {
		return false;
	}
	const dx = entity.position[0] - player.position[0];
	const dy = entity.position[1] - player.position[1];
	if (dx * dx + dy * dy > Prefs.range * Prefs.range) {
		return false;
	}
	if (Prefs.lockCenter) {
		const maxDistSq = Prefs.maxDistance * Prefs.maxDistance;
		const cdx = entity.position[0] - Prefs.centerX;
		const cdy = entity.position[1] - Prefs.centerY;
		if (cdx * cdx + cdy * cdy > maxDistSq) {
			return false;
		}
	}
	const filter = getActiveTargetFilter();
	if (filter && _retaliateGID !== entity.GID) {
		const job = (typeof entity._job === 'number') ? entity._job : entity.job;
		if (filter.indexOf(job) === -1) {
			return false;
		}
	}
	return true;
}

function targetMovedCells(entity) {
	if (!_statePos || !entity) {
		return 0;
	}
	const dx = Math.floor(entity.position[0]) - _statePos[0];
	const dy = Math.floor(entity.position[1]) - _statePos[1];
	return Math.max(Math.abs(dx), Math.abs(dy));
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

const BUFF_RECAST_MS = 60000; // unverifiable buffs only (unmapped skills, items)
const BUFF_MAPPED_RECAST_MS = 8000; // mapped skills: icon is authoritative, gate only bounds dud retries

const _buffLastCast = [0, 0, 0, 0, 0];
// Per-cycle gate jitter (ms), re-rolled on each send: breaks exact phase
// resonance between fixed-interval retries and the server attack rhythm.
const _buffGateJitter = [0, 0, 0, 0, 0];
// Consecutive dud sends per slot (sent, icon still off). Landed icons reset.
const _buffDud = [0, 0, 0, 0, 0];

// Last tick a buff *skill* was sent (Renderer.tick). Idle waits for the
// send to land instead of engaging immediately.
let _lastBuffSkillSendTick = 0;
// Grace after a buff send during which idle holds engagement for it to land.
const BUFF_SETTLE_MS = 2500;
// Hold after any own cast ends before the next self-skill send: covers
// invisible server aftercast residue that would dud the retry deterministically.
const OWN_CAST_GRACE_MS = 600;
let _lastOwnCastEndTick = 0;

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

function buffRecastMs(action) {
	if (action && action.kind === 'skill' && typeof BUFF_STATUS_MAP[action.SKID] === 'number') {
		return BUFF_MAPPED_RECAST_MS;
	}
	return BUFF_RECAST_MS;
}

function isBuffActive(action, slotIndex, now) {
	// Send-gate: bounds retries while the result is unknown. Mapped skills
	// get a short gate because the live icon (below) is authoritative and
	// the casting state already covers the in-flight window; a dud send
	// therefore retries in seconds, not minutes. Unverifiable buffs keep
	// the long gate (it is their only anti-spam: no cast state for items,
	// no icon for unmapped skills).
	if (now - (_buffLastCast[slotIndex] || 0) < buffRecastMs(action) + (_buffGateJitter[slotIndex] || 0)) {
		return true;
	}
	if (action.kind === 'skill') {
		const efst = BUFF_STATUS_MAP[action.SKID];
		if (typeof efst === 'number') {
			const on = isStatusIconActive(efst);
			if (on) {
				_buffDud[slotIndex] = 0;
			}
			return on;
		}
	}
	return false;
}

/**
 * True while any buff slot still needs a cast (same lenses as upkeep).
 * Used by idle to hold engagement until fresh sends land.
 */
function buffDemandExists(now) {
	if (!Prefs.buffEnabled) {
		return false;
	}
	const slots = Array.isArray(Prefs.buffSlots) ? Prefs.buffSlots : [];
	for (let i = 0; i < slots.length; i++) {
		if (slots[i] && !isBuffActive(slots[i], i, now)) {
			return true;
		}
	}
	return false;
}

// Buff skill sends wait for this long after our own attack motion ends:
// server canact stays hot a bit longer than the visible motion, and sends
// inside it dud silently. Recovery/teleport intentionally skip this.
const BUFF_AMOTION_GAP_MS = 250;

function tryKeepBuffs(now) {
	if (!Prefs.buffEnabled) {
		return false;
	}
	const slots = Array.isArray(Prefs.buffSlots) ? Prefs.buffSlots : [];
	const player = getPlayer();
	const amotionEnd = (player && player.amotionTick) || 0;
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
			if (now - amotionEnd < BUFF_AMOTION_GAP_MS) {
				// All buff slots share the same attack rhythm: stop here
				// and retry on a later tick instead of dudding into canact.
				break;
			}
			ok = useSkillOnSelf(action.SKID, action.level);
			if (ok) {
				_lastBuffSkillSendTick = now;
				const efst = BUFF_STATUS_MAP[action.SKID];
				if (typeof efst === 'number') {
					_buffDud[i] = isStatusIconActive(efst) ? 0 : (_buffDud[i] || 0) + 1;
				}
			}
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
			_buffGateJitter[i] = Math.random() * 2000;
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

/**
 * Shared upkeep for idle/chase/combat: potions first, then one buff at most.
 * Skill sends enter the casting satellite state atomically.
 */
function upkeep(now) {
	tryUsePotion();
	tryKeepBuffs(now);
}

function updateIdle(now) {
	upkeep(now);
	if (_state !== ST_IDLE) {
		// Upkeep cast a skill: satellite state took over.
		return;
	}

	// Idle tops up buffs before engaging: when a buff is still missing and
	// a buff skill was just sent, hold engagement a moment for it to land
	// instead of chasing right away. Anything else (blocked sends, dud
	// sends past the settle window) engages normally, so idle never stands
	// still forever waiting.
	if (buffDemandExists(now) && (isCastDisplayActive() || now - _lastBuffSkillSendTick < BUFF_SETTLE_MS)) {
		return;
	}

	// Under-attack policy (count escape wins, retaliation overrides target)
	if (handleAttacked(now)) {
		setState(ST_IDLE, now);
		return;
	}

	// Retaliation: jump straight onto the attacker.
	if (_retaliateGID !== null) {
		const player = getPlayer();
		const target = player ? getRetaliationTarget(player.position[0], player.position[1]) : null;
		if (target) {
			_stateGID = target.GID;
			_statePos = null;
			_planFailCount = 0;
			_lastTargetSeenTick = now;
			_roamDest = null;
			setState(ST_CHASE, now);
			return;
		}
	}

	// Loot only from idle: never interrupt an ongoing fight over drops.
	if (Prefs.loot) {
		const loot = findLoot();
		if (loot) {
			const player = getPlayer();
			const d = vec2.distance(player.position, loot.position);
			if (d <= 2 || d <= Prefs.range) {
				_stateGID = loot.GID;
				_lootLastSend = 0;
				setState(ST_LOOT, now);
				return;
			}
		}
	}

	const target = findTarget();
	if (!target) {
		tryTeleport(now);
		tryRoam();
		return;
	}

	// Found target: refresh no-target timer, cancel roam state and chase.
	_lastTargetSeenTick = now;
	_roamDest = null;
	_stateGID = target.GID;
	_statePos = null;
	_planFailCount = 0;
	setState(ST_CHASE, now);
}

function updateChase(now) {
	// Player took the wheel manually: hand control back.
	if (foreignMoveActive()) {
		setState(ST_IDLE, now);
		return;
	}

	upkeep(now);
	if (_state !== ST_CHASE) {
		// Upkeep cast a skill: satellite state took over.
		return;
	}

	if (handleAttacked(now)) {
		setState(ST_IDLE, now);
		return;
	}

	const target = resolveBoundTarget(now);
	if (!target || !passesChaseGates(target)) {
		setState(ST_IDLE, now);
		return;
	}
	_lastTargetSeenTick = now;
	_roamDest = null;

	// Target outran the last move order: cancel and re-issue.
	if (ownMovePending() && targetMovedCells(target) > CHASE_REPATH_CELLS) {
		dropMoveAction();
	}

	const plan = getAttackPlan(target);
	if (!plan) {
		if (++_planFailCount > 15) {
			setState(ST_IDLE, now);
		}
		return;
	}
	if (plan.count < 2) {
		if (fireAttackDirect(target)) {
			_planFailCount = 0;
			_combatDisrupted = false;
			setState(ST_COMBAT, now);
		}
		return;
	}
	// Out of reach: walk, but only when nothing is already in flight
	// (arrival auto-fires the stashed packet via MapEngine onWalkEnd).
	if (!ownMovePending() && !isBusy()) {
		if (sendChaseMove(target, plan)) {
			_planFailCount = 0;
		}
	}
}

function updateCombat(now) {
	if (foreignMoveActive()) {
		setState(ST_IDLE, now);
		return;
	}

	upkeep(now);
	if (_state !== ST_COMBAT) {
		// Upkeep cast a skill: satellite state took over.
		return;
	}

	if (handleAttacked(now)) {
		setState(ST_IDLE, now);
		return;
	}

	// Retaliation switched targets: rechase the new one.
	if (_retaliateGID !== null && _retaliateGID !== _stateGID) {
		const player = getPlayer();
		const target = player ? getRetaliationTarget(player.position[0], player.position[1]) : null;
		if (target) {
			_stateGID = target.GID;
			_statePos = null;
			_planFailCount = 0;
			setState(ST_CHASE, now);
			return;
		}
	}

	const target = resolveBoundTarget(now);
	if (!target) {
		// Bound target died or vanished mid-fight: count the kill.
		if (boundTargetGoneDead()) {
			_killCount++;
		}
		setState(ST_IDLE, now);
		return;
	}
	_lastTargetSeenTick = now;
	_roamDest = null;

	const plan = getAttackPlan(target);
	if (!plan) {
		if (++_planFailCount > 15) {
			setState(ST_IDLE, now);
		}
		return;
	}
	if (plan.count >= 2) {
		// Drifted out of reach: rechase (stays sticky, no range re-gate).
		setState(ST_CHASE, now);
		return;
	}

	if (!useSkillMode()) {
		// Normal attack is server-maintained: only refire when our own cast
		// broke it, or the safety net trips (server stopped silently).
		if (_combatDisrupted) {
			if (fireAttackDirect(target)) {
				_combatDisrupted = false;
				_planFailCount = 0;
			}
			return;
		}
		const player = getPlayer();
		const idleAttacker = !player.amotionTick || player.amotionTick <= now;
		if (now - _stateTick > COMBAT_REATTACK_MS && idleAttacker && !ownMovePending()) {
			if (fireAttackDirect(target)) {
				_planFailCount = 0;
				// Re-arm the safety net from this refire.
				_stateTick = now;
			}
		}
		return;
	}

	// Attack-skill mode: one-shot casts on our own beat (exact timer first,
	// tick check as fallback). Overpace sends are silently dropped
	// server-side (canact_tick gate).
	const floor = skillRefireFloor(Prefs.skillId);
	if (!isBusy() && now - _skillLastFire >= floor) {
		if (fireAttackDirect(target)) {
			_planFailCount = 0;
		}
	}
}

function updateLoot(now) {
	if (foreignMoveActive()) {
		setState(ST_IDLE, now);
		return;
	}

	if (handleAttacked(now)) {
		setState(ST_IDLE, now);
		return;
	}

	let item = null;
	try {
		item = EntityManager.get(_stateGID);
	} catch (_e) {
		item = null;
	}
	if (!item || item.objecttype !== Entity.TYPE_ITEM || item.remove_tick !== 0) {
		// Picked up (or gone): back to business.
		setState(ST_IDLE, now);
		return;
	}
	if (now - _stateTick > LOOT_TIMEOUT_MS) {
		setState(ST_IDLE, now);
		return;
	}
	// Send once; resend only when nothing is in flight (watchdog drop or
	// fail-ack) and enough time passed.
	if (!ownMovePending() && !isBusy() && now - _lootLastSend > LOOT_RESEND_MS) {
		if (sendLoot(item)) {
			_lootLastSend = now;
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
		return;
	}

	if (isOverWeight()) {
		return;
	}

	const now = Renderer.tick;

	// Watchdog: clear our own chase/pickup move when arrival never comes
	clearStaleMoveAction(now);

	// Sit-to-recover preemption (real state, independent from recoveryRules).
	if (_state !== ST_RESTING && _state !== ST_CASTING && maybeEnterResting(now)) {
		return;
	}

	// A cast bar we didn't send (arrival-fired skill, manual cast, NPC
	// progress bar): track it in the satellite state all the same.
	// NOTE: Session.Entity.lastSKID is set by any nearby cast ack, so the
	// skill id here is best-effort diagnostics only; delay learning for a
	// wrong id errs toward slower pacing, never toward spam.
	if (_state !== ST_CASTING && _state !== ST_RESTING) {
		const p = getPlayer();
		const cast = p && p.cast;
		if (cast && cast.display && cast.delay > 0) {
			enterCasting(_state, (Session.Entity && Session.Entity.lastSKID) || 0);
		}
	}

	switch (_state) {
		case ST_CASTING:
			updateCasting(now);
			if (_state === ST_CASTING) {
				return;
			}
			// Fell through on exit: run the resumed state this same tick.
			tickImplState(now);
			return;
		default:
			tickImplState(now);
			return;
	}
}

function tickImplState(now) {
	switch (_state) {
		case ST_CHASE:
			updateChase(now);
			return;
		case ST_COMBAT:
			updateCombat(now);
			return;
		case ST_LOOT:
			updateLoot(now);
			return;
		case ST_RESTING:
			updateResting(now);
			return;
		case ST_CASTING:
			updateCasting(now);
			return;
		default:
			updateIdle(now);
			return;
	}
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
	// Fixed cadence for every state; pacing lives in the state logic.
	_timer = Events.setTimeout(tick, TICK_MS);
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

	_lastRoamTick = 0;
	_lastTargetSeenTick = Renderer.tick;
	_moveActionPkt = null;
	_moveActionTick = 0;
	_moveActionPos = null;
	_retaliateGID = null;
	_roamDest = null;
	_state = ST_IDLE;
	_stateTick = Renderer.tick;
	_stateGID = null;
	_statePos = null;
	_planFailCount = 0;
	_lootLastSend = 0;
	_skillLastFire = 0;
	_skillBeatTimer = null;
	_combatDisrupted = false;
	_pendingCast = null;
	_castLastInfo = '-';
	_lastBuffSkillSendTick = 0;
	_lastOwnCastEndTick = 0;
	for (let i = 0; i < _buffDud.length; i++) {
		_buffDud[i] = 0;
		_buffGateJitter[i] = 0;
	}
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
	if (_skillBeatTimer !== null) {
		Events.clearTimeout(_skillBeatTimer);
		_skillBeatTimer = null;
	}

	_lastRoamTick = 0;
	_retaliateGID = null;
	_roamDest = null;
	_state = ST_IDLE;
	_stateGID = null;
	_statePos = null;
	_pendingCast = null;
	_combatDisrupted = false;
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
		tickMs: TICK_MS,
		timerPending: _timer !== null,
		state: _state,
		stateAgeMs: now - _stateTick,
		stateGID: _stateGID,
		skillBeat: _skillBeatTimer !== null,
		cast: _castLastInfo,
		moveAction: !!Session.moveAction,
		moveActionOurs: !!(_moveActionPkt && Session.moveAction === _moveActionPkt),
		moveActionAgeMs: (_moveActionPkt && Session.moveAction === _moveActionPkt) ? now - _moveActionTick : 0,
		amotionRemainingMs: player && player.amotionTick ? Math.max(0, player.amotionTick - now) : 0,
		hasTarget: hasTarget,
		buffEnabled: !!Prefs.buffEnabled,
		sp: player && player.life ? `${player.life.sp}/${player.life.sp_max}` : '-',
		attackedCount: getMobAttackers(now).length,
		retaliateGID: _retaliateGID,
		sitting: isSitting(),
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
		out.push(`${i}:${describeBuffAction(action)} lastCast=${now - (_buffLastCast[i] || 0)}ms icon=${icon} skip=${active} dud=${_buffDud[i] || 0}`);
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
	getState,
	getStats,
	tick,
	// expose for UI/testing
	_findTarget: findTarget,
	_findLoot: findLoot
};
