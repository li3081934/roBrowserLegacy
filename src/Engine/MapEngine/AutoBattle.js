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
import SkillList from 'UI/Components/SkillList/SkillList.js';
import Prefs from 'Preferences/AutoBattle.js';
import glMatrix from 'Utils/gl-matrix.js';

const vec2 = glMatrix.vec2;

let _timer = null;
let _enabled = false;
let _lastAttackTick = 0;
let _lastLootTick = 0;
let _lastRoamTick = 0;
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

function findTarget() {
	const player = getPlayer();
	if (!player) {
		return null;
	}

	const px = player.position[0];
	const py = player.position[1];
	const rangeSq = Prefs.range * Prefs.range;
	const maxDistSq = Prefs.lockCenter ? Prefs.maxDistance * Prefs.maxDistance : Infinity;
	const cx = Prefs.centerX;
	const cy = Prefs.centerY;

	let best = null;
	let bestDist = Infinity;

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

	const px = player.position[0];
	const py = player.position[1];
	let best = null;
	let bestDist = Infinity;

	EntityManager.forEach(entity => {
		if (entity.objecttype !== Entity.TYPE_ITEM || entity.remove_tick !== 0) {
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

	Session.moveAction = pkt;

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

	Session.moveAction = pkt;
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
		Session.moveAction = pkt;
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

function tick() {
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

	// Potion check each tick (fast)
	tryUsePotion();

	const now = Renderer.tick;

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
		tryRoam();
		schedule();
		return;
	}

	// Found target: cancel roam state and attack
	_roamDest = null;
	if (sendAttack(target)) {
		_lastAttackTick = now;
	}

	schedule();
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
	_roamDest = null;
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
	_roamDest = null;
	Session.moveAction = null;
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
	return {
		enabled: isEnabled(),
		killCount: _killCount,
		range: Prefs.range
	};
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
