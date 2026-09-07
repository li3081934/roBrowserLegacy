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
		roamWhenIdle: true,
		roamInterval: 3000,
		roamRange: 6,
		roamTries: 10
	},
	1.1
);
