/**
 * Preferences/AutoBattle.js
 *
 * Auto-battle preferences persisted in localStorage
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import Preferences from 'Core/Preferences.js';

export default Preferences.get(
	'AutoBattle',
	{
		enabled: false,
		range: 14,
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
		// Recovery rules (new format, see AutoBattle component for schema):
		// [{ id, enabled, target: 'hp'|'sp', threshold: 0-100,
		//    action: null | { kind: 'item', ITID } | { kind: 'skill', SKID, level } }]
		recoveryRules: [],
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
		roamWhenIdle: true,
		roamInterval: 3000,
		roamRange: 6,
		roamTries: 10
	},
	1.1
);
