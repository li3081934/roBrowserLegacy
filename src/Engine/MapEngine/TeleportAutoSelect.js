/**
 * Engine/MapEngine/TeleportAutoSelect.js
 *
 * Shared flag for AutoBattle teleport: when set, the next warp-point
 * menu (ZC.WARPLIST) is auto-answered with the first entry instead of
 * showing the NpcMenu popup.
 *
 * Kept as a zero-dependency leaf module on purpose: both
 * Engine/MapEngine/Skill.js and Engine/MapEngine/AutoBattle.js use it,
 * and a direct import between those two creates a module evaluation cycle
 * (Skill.js pulls UI components such as Sense.js which instantiates
 * Entity at module top level).
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

let _autoSelectWarpTick = 0;

export function setAutoSelectWarpTick(tick) {
	_autoSelectWarpTick = tick;
}

export function consumeAutoSelectWarpTick() {
	const tick = _autoSelectWarpTick;
	_autoSelectWarpTick = 0;
	return tick;
}
