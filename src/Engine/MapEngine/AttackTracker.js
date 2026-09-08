/**
 * Engine/MapEngine/AttackTracker.js
 *
 * Who is hitting me: records attacker GIDs from incoming damage packets.
 * Callers pass the tick explicitly so this module stays dependency-free
 * (Entity.js feeds it; AutoBattle reads it). Mob resolution happens at
 * query time in the consumer (which owns EntityManager access).
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

// attacker GID -> last hit tick (Renderer.tick ms)
const _hits = new Map();

export const ATTACK_WINDOW_MS = 5000;

export function recordAttacker(gid, tick) {
	if (typeof gid !== 'number' || gid <= 0 || typeof tick !== 'number') {
		return;
	}
	_hits.set(gid, tick);
}

/**
 * Distinct attacker GIDs seen within the window, oldest first.
 * Prunes expired entries as a side effect.
 */
export function getRecentAttackers(now, windowMs) {
	const window = typeof windowMs === 'number' ? windowMs : ATTACK_WINDOW_MS;
	const out = [];
	_hits.forEach((tick, gid) => {
		if (now - tick <= window) {
			out.push({ gid: gid, tick: tick });
		} else {
			_hits.delete(gid);
		}
	});
	out.sort((a, b) => a.tick - b.tick);
	return out;
}

export function clearAttackers() {
	_hits.clear();
}
