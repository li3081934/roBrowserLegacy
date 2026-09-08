/**
 * Engine/MapEngine/MobDrop.js
 *
 * Current-map monster + drop-rate viewer packets: request the map's
 * monster list (CZ_REQ_MAPMOBS) and per-monster drops (CZ_REQ_MOBDROPS),
 * cache server answers and forward them to the MobDrop UI.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import Network from 'Network/NetworkManager.js';
import PACKET from 'Network/PacketStructure.js';
import MobDrop from 'UI/Components/MobDrop/MobDrop.js';

// Last server answers, keyed for the UI.
const _cache = {
	mobs: null,
	drops: {}
};

// Extra subscribers (e.g. loot-rate aggregation) notified on answers.
// The UI keeps calling its own handlers directly; both paths coexist.
const _subscribers = [];

function notifySubscribers(kind, a, b) {
	for (let i = 0; i < _subscribers.length; i++) {
		try {
			_subscribers[i](kind, a, b);
		} catch (_e) {
			// ignore subscriber errors
		}
	}
}

function onMapMobs(pkt) {
	_cache.mobs = pkt.mobs || [];
	_cache.drops = {};
	try {
		MobDrop.onMapMobs(_cache.mobs);
	} catch (_e) {
		// UI not ready yet; data stays cached for when it opens.
	}
	notifySubscribers('mobs', _cache.mobs);
}

function onMobDrops(pkt) {
	_cache.drops[pkt.mobId] = {
		drops: pkt.drops || [],
		mvpDrops: pkt.mvpDrops || []
	};
	try {
		MobDrop.onMobDrops(pkt.mobId, _cache.drops[pkt.mobId]);
	} catch (_e) {
		// ignore
	}
	notifySubscribers('drops', pkt.mobId, _cache.drops[pkt.mobId]);
}

function reqMapMobs() {
	Network.sendPacket(new PACKET.CZ.REQ_MAPMOBS());
}

function reqMobDrops(mobId) {
	const pkt = new PACKET.CZ.REQ_MOBDROPS();
	pkt.mobId = mobId;
	Network.sendPacket(pkt);
}

function getCachedMobs() {
	return _cache.mobs;
}

function getCachedDrops(mobId) {
	return _cache.drops[mobId] || null;
}

function clearCache() {
	_cache.mobs = null;
	_cache.drops = {};
}

function subscribe(fn) {
	if (typeof fn === 'function' && _subscribers.indexOf(fn) === -1) {
		_subscribers.push(fn);
	}
}

function unsubscribe(fn) {
	const i = _subscribers.indexOf(fn);
	if (i !== -1) {
		_subscribers.splice(i, 1);
	}
}

function hasPacket(ns, name) {
	return !!(PACKET[ns] && PACKET[ns][name]);
}

/**
 * Initialize
 */
export default function MobDropEngine() {
	// Custom server packets: only hook when the packet structures exist,
	// otherwise MapEngine.init would abort and break all later UI setup.
	if (hasPacket('ZC', 'ACK_MAPMOBS')) {
		Network.hookPacket(PACKET.ZC.ACK_MAPMOBS, onMapMobs);
	}
	if (hasPacket('ZC', 'ACK_MOBDROPS')) {
		Network.hookPacket(PACKET.ZC.ACK_MOBDROPS, onMobDrops);
	}
}

export { reqMapMobs, reqMobDrops, getCachedMobs, getCachedDrops, clearCache, subscribe, unsubscribe };
