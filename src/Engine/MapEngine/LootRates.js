/**
 * Engine/MapEngine/LootRates.js
 *
 * Per-map loot-rate table for auto-loot filtering, fed by the live
 * MobDrop custom packets (see Engine/MapEngine/MobDrop.js).
 *
 * Flow: on a new map -> REQ_MAPMOBS -> REQ_MOBDROPS for every mob ->
 * aggregate itemId -> { rate (per-10000 max on this map), type, weight }.
 * Rates are server-adjusted (multipliers/VIP/caps), MVP drops merged in.
 * Until ready (or when the server has no patch): query() returns null
 * and callers must fail-open (pick everything).
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import Renderer from 'Renderer/Renderer.js';
import MapRenderer from 'Renderer/MapRenderer.js';
import { reqMapMobs, reqMobDrops, subscribe } from 'Engine/MapEngine/MobDrop.js';

// Give up waiting for stragglers and use whatever arrived.
const FETCH_TIMEOUT_MS = 5000;

let _subscribed = false;
let _mapKey = null;
let _rates = new Map();
let _pending = new Set();
let _fetchTick = 0;
let _ready = false;
let _warned = false;

function normalizeMapName() {
	const raw = (MapRenderer && MapRenderer.currentMap) || '';
	return String(raw).replace(/\.gat$/i, '').toLowerCase();
}

function onMobs(mobs) {
	_pending = new Set();
	_rates = new Map();
	_fetchTick = Renderer.tick;
	(mobs || []).forEach(mob => {
		if (mob && typeof mob.mobId === 'number') {
			_pending.add(mob.mobId);
			try {
				reqMobDrops(mob.mobId);
			} catch (_e) {
				_pending.delete(mob.mobId);
			}
		}
	});
	if (_pending.size === 0) {
		_ready = true;
	} else {
		_ready = false;
	}
}

function mergeDrop(itemId, rate, type, weight) {
	if (typeof itemId !== 'number') {
		return;
	}
	const prev = _rates.get(itemId);
	if (!prev || (typeof rate === 'number' && rate > prev.rate)) {
		_rates.set(itemId, {
			rate: typeof rate === 'number' ? rate : 0,
			type: typeof type === 'number' ? type : (prev ? prev.type : null),
			weight: typeof weight === 'number' ? weight : (prev ? prev.weight : null)
		});
	} else if (prev) {
		// Keep already-known type/weight when the hotter entry lacks them.
		if (prev.type === null && typeof type === 'number') {
			prev.type = type;
		}
		if (prev.weight === null && typeof weight === 'number') {
			prev.weight = weight;
		}
	}
}

function onDrops(mobId, data) {
	_pending.delete(mobId);
	(data.drops || []).forEach(d => {
		mergeDrop(d.itemId, d.rate, d.type, d.weight);
	});
	(data.mvpDrops || []).forEach(d => {
		mergeDrop(d.itemId, d.rate, d.type, d.weight);
	});
	if (_pending.size === 0) {
		_ready = true;
	}
}

function onNotify(kind, a, b) {
	if (kind === 'mobs') {
		onMobs(a);
	} else if (kind === 'drops') {
		onDrops(a, b || { drops: [], mvpDrops: [] });
	}
}

function ensureSubscribed() {
	if (!_subscribed) {
		_subscribed = true;
		try {
			subscribe(onNotify);
		} catch (_e) {
			_subscribed = false;
		}
	}
}

/**
 * Re-query when the map changed. Cheap: one string compare per tick.
 */
function refreshIfNeeded() {
	ensureSubscribed();
	const key = normalizeMapName();
	if (!key || key === _mapKey) {
		// Timeout guard: use partial data instead of waiting forever.
		if (!_ready && _mapKey && Renderer.tick - _fetchTick > FETCH_TIMEOUT_MS) {
			_ready = true;
		}
		return;
	}
	_mapKey = key;
	_ready = false;
	_rates = new Map();
	_pending = new Set();
	_fetchTick = Renderer.tick;
	try {
		reqMapMobs();
	} catch (_e) {
		if (!_warned) {
			_warned = true;
			console.warn('[LootRates] map-mob query failed (server without patch?). Loot filters disabled.');
		}
	}
}

/**
 * Look up aggregated info for a ground item.
 *
 * @param {number} itemId
 * @returns {object|null} { rate, type, weight } or null when unknown
 * (not ready yet, unknown map/item, server without patch).
 */
function query(itemId) {
	if (typeof itemId !== 'number') {
		return null;
	}
	const hit = _rates.get(itemId);
	return hit || null;
}

function isReady() {
	return _ready;
}

function getMapKey() {
	return _mapKey;
}

export default {
	refreshIfNeeded,
	query,
	isReady,
	getMapKey
};
