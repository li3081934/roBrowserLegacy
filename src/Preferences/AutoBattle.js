/**
 * Preferences/AutoBattle.js
 *
 * Auto-battle preferences persisted in localStorage, isolated per character.
 *
 * Storage layout (single key 'AutoBattle'):
 *   { _version: 2, activeChar: '<server>|<AID>|<GID>',
 *     profiles: { '<key>': { ...config fields } },
 *     legacySeed?: { ...config fields } }
 *
 * In memory a single flat Prefs object is exported (same shape as the legacy
 * config) so Engine/UI keep reading Prefs.xxx unchanged. Profiles are swapped
 * in when a character is selected (CharEngine.onReceiveMapInfo).
 *
 * Upgrade path: a legacy flat config (pre-isolation) is kept as `legacySeed`
 * and becomes the profile of the first character that logs in after the
 * upgrade. Every other character starts from the defaults below.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import Session from 'Engine/SessionStorage.js';

const KEY = 'AutoBattle';
const VERSION = 2;
const FALLBACK_KEY = '_default';

const DEFAULTS = {
	enabled: false,
	range: 14,
	// Deprecated: engine tick is fixed at 200ms (TICK_MS); skill pacing
	// uses its own floor. Kept for stored-settings compatibility.
	attackInterval: 500,
	useSkill: false,
	skillId: 0,
	skillLevel: 1,
	loot: true,
	// Loot filters (Loot tab). Types follow ItemType ints.
	// Max weight in display units (raw / 10, e.g. red potion = 7).
	// Max rate in percent of per-10000 server rate (100 = off).
	// Unknown items always pass (fail-open).
	lootTypes: { equip: true, card: true, consumable: true, etc: true },
	lootMaxWeight: 0,
	lootMaxRate: 100,
	hpThreshold: 50,
	hpPotionId: 501,
	spThreshold: 20,
	spPotionId: 505,
	// Recovery migration flag (see AutoBattle component for schema).
	recoveryMigrated: false,
	// Recovery rules (new format, see AutoBattle component for schema):
	// [{ id, enabled, target: 'hp'|'sp', threshold: 0-100,
	//    action: null | { kind: 'item', ITID } | { kind: 'skill', SKID, level } }]
	recoveryRules: [],
	// Sit-to-recover card (recovery tab, independent from recoveryRules):
	// { enabled, sitTarget: 'hp'|'sp', sitThreshold: 0-100,
	//   standTarget: 'hp'|'sp', standThreshold: 0-100 }
	sitRecovery: {
		enabled: false,
		sitTarget: 'hp',
		sitThreshold: 50,
		standTarget: 'hp',
		standThreshold: 90
	},
	lockCenter: false,
	centerX: 0,
	centerY: 0,
	maxDistance: 14,
	stopOnDeath: true,
	useTeleportOnNoTarget: false,
	teleportNoTargetSec: 30,
	// Teleport slots (settings tab): [slot1, slot2], each
	// null | { kind: 'item', ITID } | { kind: 'skill', SKID, level }
	teleportSlots: [null, null],
	// Buff card (combat tab): master switch + 5 slots, same action shape
	buffEnabled: false,
	buffSlots: [null, null, null, null, null],
	// Target filter (combat tab): mobId list valid only for targetFilterMap.
	// Empty list or map mismatch = no filtering.
	targetFilterMap: '',
	targetFilter: [],
	// When hit by non-targets: 'ignore' | 'retaliate' | 'teleport'.
	attackedAction: 'ignore',
	// Teleport when distinct mob attackers in 5s window exceed this (0 = off).
	attackedTeleportCount: 3,
	// Teleport when live mobs within 2 cells (5x5) reach this (0 = off).
	surroundTeleportCount: 0,
	roamWhenIdle: true,
	roamInterval: 3000,
	roamRange: 6,
	roamTries: 10
};

function cloneValue(value) {
	if (value === undefined) {
		return value;
	}
	return JSON.parse(JSON.stringify(value));
}

function readStore() {
	let raw = null;
	try {
		raw = localStorage.getItem(KEY);
	} catch (_e) {
		return null;
	}
	if (!raw) {
		return null;
	}
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch (_e) {
		return null;
	}
}

function writeStore(store) {
	try {
		localStorage.setItem(KEY, JSON.stringify(store));
	} catch (_e) {
		// Storage unavailable (private mode / quota): keep in-memory values.
	}
}

// Keep known config fields only; drops legacy/meta keys (_version, _key,
// save) and any foreign junk from older or corrupted stores.
function pickConfig(source) {
	const out = {};
	if (!source || typeof source !== 'object') {
		return out;
	}
	Object.keys(DEFAULTS).forEach(key => {
		if (key in source) {
			out[key] = source[key];
		}
	});
	return out;
}

// Upgrade legacy (flat) storage to the per-character layout in place.
// The legacy config is preserved as `legacySeed` and consumed by the first
// character that logs in after the upgrade.
function ensureStore() {
	const store = readStore();
	if (store && store._version === VERSION && store.profiles && typeof store.profiles === 'object') {
		return store;
	}
	const legacySeed = pickConfig(store);
	const upgraded = { _version: VERSION, activeChar: null, profiles: {} };
	if (Object.keys(legacySeed).length) {
		upgraded.legacySeed = legacySeed;
	}
	writeStore(upgraded);
	return upgraded;
}

// Flat active config. Starts from defaults; loadForCharacter() swaps the
// active character profile in.
const Prefs = Object.assign({}, cloneValue(DEFAULTS));

// Active character key. null until a character is selected.
Prefs._charKey = null;

// Optional hook notified after a profile swap: onProfileChange(charKey).
Prefs.onProfileChange = null;

/**
 * Build the isolation key for the currently selected character.
 *
 * @returns {string} '<server>|<AID>|<GID>'
 */
Prefs.getCharacterKey = function getCharacterKey() {
	const server = Session.ServerName || '';
	const aid = Session.AID || 0;
	const gid = Session.GID || 0;
	return `${server}|${aid}|${gid}`;
};

/**
 * Persist the current in-memory config into the active character profile.
 */
Prefs.save = function save() {
	const key = this._charKey || FALLBACK_KEY;
	const store = ensureStore();
	store.profiles[key] = pickConfig(this);
	if (this._charKey) {
		store.activeChar = this._charKey;
	}
	writeStore(store);
};

/**
 * Switch the active config to the given character profile.
 *
 * The outgoing profile is persisted first. Unknown characters start from
 * the defaults; the first character after the upgrade inherits the legacy
 * (pre-isolation) config.
 *
 * @param {string} [charKey] - defaults to the currently selected character
 * @returns {string} the activated character key
 */
Prefs.loadForCharacter = function loadForCharacter(charKey) {
	charKey = charKey || this.getCharacterKey();
	if (this._charKey && this._charKey === charKey) {
		return charKey;
	}
	// Persist the outgoing profile before switching.
	if (this._charKey) {
		this.save();
	}
	const store = ensureStore();
	let profile = store.profiles[charKey];
	if (!profile && store.legacySeed) {
		profile = store.legacySeed;
		delete store.legacySeed;
	}
	// Reset to defaults, then apply the profile.
	Object.keys(DEFAULTS).forEach(key => {
		Prefs[key] = cloneValue(DEFAULTS[key]);
	});
	if (profile) {
		const clean = pickConfig(profile);
		Object.keys(clean).forEach(key => {
			Prefs[key] = clean[key];
		});
	}
	this._charKey = charKey;
	store.activeChar = charKey;
	if (!store.profiles[charKey]) {
		store.profiles[charKey] = pickConfig(Prefs);
	}
	writeStore(store);
	if (typeof this.onProfileChange === 'function') {
		try {
			this.onProfileChange(charKey);
		} catch (_e) {
			// Never let a UI hook break the profile switch.
		}
	}
	return charKey;
};

export default Prefs;
