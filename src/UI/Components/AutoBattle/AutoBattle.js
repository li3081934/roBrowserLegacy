/**
 * UI/Components/AutoBattle/AutoBattle.js
 *
 * Auto-battle configuration panel.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import UIManager from 'UI/UIManager.js';
import GUIComponent from 'UI/GUIComponent.js';
import Prefs from 'Preferences/AutoBattle.js';
import AutoBattleEngine from 'Engine/MapEngine/AutoBattle.js';
import Session from 'Engine/SessionStorage.js';
import SkillList from 'UI/Components/SkillList/SkillList.js';
import SkillInfo from 'DB/Skills/SkillInfo.js';
import DB from 'DB/DBManager.js';
import Client from 'Core/Client.js';
import ChatBox from 'UI/Components/ChatBox/ChatBox.js';
import Commands from 'Controls/ProcessCommand.js';
import LootRates from 'Engine/MapEngine/LootRates.js';
import { getCachedMobs, reqMapMobs } from 'Engine/MapEngine/MobDrop.js';
import htmlText from './AutoBattle.html?raw';
import cssText from './AutoBattle.css?raw';
import 'UI/Elements/Elements.js';

const AutoBattle = new GUIComponent('AutoBattle', cssText);

AutoBattle.render = () => htmlText;

AutoBattle.init = function init() {
	const root = this.getRoot();

	this.draggable('.titlebar');

	const closeBtn = root.querySelector('.close');
	if (closeBtn) {
		closeBtn.addEventListener('mousedown', e => e.stopImmediatePropagation());
		closeBtn.addEventListener('click', () => this.remove());
	}

	// Main toggle
	const enabledEl = root.querySelector('#ab_enabled');
	if (enabledEl) {
		enabledEl.addEventListener('change', () => {
			const val = enabledEl.checked;
			if (val) {
				AutoBattleEngine.start();
			} else {
				AutoBattleEngine.stop();
			}
			updateStatus();
		});
	}

	// Range
	const rangeEl = root.querySelector('#ab_range');
	if (rangeEl) {
		rangeEl.addEventListener('change', () => {
			let v = parseInt(rangeEl.value, 10);
			if (isNaN(v)) v = 14;
			v = Math.max(1, Math.min(30, v));
			Prefs.range = v;
			Prefs.save();
		});
	}

	// Use skill
	const useSkillEl = root.querySelector('#ab_useSkill');
	if (useSkillEl) {
		useSkillEl.addEventListener('change', () => {
			Prefs.useSkill = useSkillEl.checked;
			Prefs.save();
			refreshSkillState();
		});
	}

	const skillIdEl = root.querySelector('#ab_skillId');
	if (skillIdEl) {
		skillIdEl.addEventListener('change', () => {
			const v = parseInt(skillIdEl.value, 10);
			Prefs.skillId = isNaN(v) ? 0 : v;
			Prefs.save();
		});
	}

	const skillLvEl = root.querySelector('#ab_skillLv');
	if (skillLvEl) {
		skillLvEl.addEventListener('change', () => {
			let v = parseInt(skillLvEl.value, 10);
			if (isNaN(v)) v = 1;
			v = Math.max(1, Math.min(10, v));
			Prefs.skillLevel = v;
			Prefs.save();
		});
	}

	// Lock center
	const lockEl = root.querySelector('#ab_lockCenter');
	if (lockEl) {
		lockEl.addEventListener('change', () => {
			Prefs.lockCenter = lockEl.checked;
			if (lockEl.checked && Session.Entity) {
				Prefs.centerX = Math.floor(Session.Entity.position[0]);
				Prefs.centerY = Math.floor(Session.Entity.position[1]);
				const maxDistEl = root.querySelector('#ab_maxDist');
				if (maxDistEl) maxDistEl.value = Prefs.maxDistance;
			}
			Prefs.save();
		});
	}

	const maxDistEl = root.querySelector('#ab_maxDist');
	if (maxDistEl) {
		maxDistEl.addEventListener('change', () => {
			let v = parseInt(maxDistEl.value, 10);
			if (isNaN(v)) v = 14;
			v = Math.max(1, Math.min(30, v));
			Prefs.maxDistance = v;
			Prefs.save();
		});
	}

	const setCenterBtn = root.querySelector('#ab_setCenter');
	if (setCenterBtn) {
		setCenterBtn.addEventListener('click', () => {
			if (Session.Entity) {
				Prefs.centerX = Math.floor(Session.Entity.position[0]);
				Prefs.centerY = Math.floor(Session.Entity.position[1]);
				Prefs.lockCenter = true;
				Prefs.save();
				const lock = root.querySelector('#ab_lockCenter');
				if (lock) lock.checked = true;
				ChatBox.addText(`AutoBattle center set to ${Prefs.centerX},${Prefs.centerY}`, ChatBox.TYPE.INFO, ChatBox.FILTER.PUBLIC_LOG);
			}
		});
	}

	const roamEl = root.querySelector('#ab_roam');
	if (roamEl) {
		roamEl.addEventListener('change', () => {
			Prefs.roamWhenIdle = roamEl.checked;
			Prefs.save();
		});
	}

	const roamRangeEl = root.querySelector('#ab_roamRange');
	if (roamRangeEl) {
		roamRangeEl.addEventListener('change', () => {
			let v = parseInt(roamRangeEl.value, 10);
			if (isNaN(v)) v = 6;
			v = Math.max(1, Math.min(14, v));
			Prefs.roamRange = v;
			Prefs.save();
		});
	}

	const teleportEl = root.querySelector('#ab_teleport');
	if (teleportEl) {
		teleportEl.addEventListener('change', () => {
			Prefs.useTeleportOnNoTarget = teleportEl.checked;
			Prefs.save();
		});
	}

	const teleportSecEl = root.querySelector('#ab_teleportSec');
	if (teleportSecEl) {
		teleportSecEl.addEventListener('change', () => {
			let v = parseInt(teleportSecEl.value, 10);
			if (isNaN(v)) v = 30;
			v = Math.max(5, Math.min(300, v));
			Prefs.teleportNoTargetSec = v;
			Prefs.save();
		});
	}

	bindTeleportSlot('#ab_tpSlot0', 0);
	bindTeleportSlot('#ab_tpSlot1', 1);

	const buffEnabledEl = root.querySelector('#ab_buffEnabled');
	if (buffEnabledEl) {
		buffEnabledEl.addEventListener('change', () => {
			Prefs.buffEnabled = buffEnabledEl.checked;
			Prefs.save();
		});
	}

	for (let i = 0; i < 5; i++) {
		bindBuffSlot(`#ab_buffSlot${i}`, i);
	}

	// Loot
	const lootEl = root.querySelector('#ab_loot');
	if (lootEl) {
		lootEl.addEventListener('change', () => {
			Prefs.loot = lootEl.checked;
			Prefs.save();
		});
	}

	function ensureLootTypes() {
		if (!Prefs.lootTypes || typeof Prefs.lootTypes !== 'object') {
			Prefs.lootTypes = { equip: true, card: true, consumable: true, etc: true };
			Prefs.save();
		}
		return Prefs.lootTypes;
	}

	[
		['#ab_lootEquip', 'equip'],
		['#ab_lootCard', 'card'],
		['#ab_lootConsumable', 'consumable'],
		['#ab_lootEtc', 'etc']
	].forEach(([selector, key]) => {
		const el = root.querySelector(selector);
		if (el) {
			el.addEventListener('change', () => {
				ensureLootTypes()[key] = el.checked;
				Prefs.save();
			});
		}
	});

	const lootMaxWeightEl = root.querySelector('#ab_lootMaxWeight');
	if (lootMaxWeightEl) {
		lootMaxWeightEl.addEventListener('change', () => {
			let v = parseInt(lootMaxWeightEl.value, 10);
			if (isNaN(v)) v = 0;
			Prefs.lootMaxWeight = Math.max(0, v);
			Prefs.save();
		});
	}

	const lootMaxRateEl = root.querySelector('#ab_lootMaxRate');
	if (lootMaxRateEl) {
		lootMaxRateEl.addEventListener('change', () => {
			let v = parseInt(lootMaxRateEl.value, 10);
			if (isNaN(v)) v = 100;
			Prefs.lootMaxRate = Math.max(0, Math.min(100, v));
			Prefs.save();
		});
	}

	const attackedActionEl = root.querySelector('#ab_attackedAction');
	if (attackedActionEl) {
		attackedActionEl.addEventListener('change', () => {
			const v = attackedActionEl.value;
			Prefs.attackedAction = (v === 'retaliate' || v === 'teleport') ? v : 'ignore';
			Prefs.save();
		});
	}

	const attackedCountEl = root.querySelector('#ab_attackedTeleportCount');
	if (attackedCountEl) {
		attackedCountEl.addEventListener('change', () => {
			let v = parseInt(attackedCountEl.value, 10);
			if (isNaN(v)) v = 0;
			Prefs.attackedTeleportCount = Math.max(0, Math.min(20, v));
			Prefs.save();
		});
	}

	const stopEl = root.querySelector('#ab_stopOnDeath');
	if (stopEl) {
		stopEl.addEventListener('change', () => {
			Prefs.stopOnDeath = stopEl.checked;
			Prefs.save();
		});
	}

	// Tabs
	const tabBtns = root.querySelectorAll('.tabs .tab');
	tabBtns.forEach(btn => {
		btn.addEventListener('click', () => {
			tabBtns.forEach(b => b.classList.remove('active'));
			btn.classList.add('active');
			const name = btn.getAttribute('data-tab');
			root.querySelectorAll('.tab-panel').forEach(panel => {
				panel.classList.toggle('hidden', panel.getAttribute('data-panel') !== name);
			});
			if (name === 'combat') {
				renderTargetList();
			}
		});
	});

	// Recovery rules
	const addRecoveryBtn = root.querySelector('#ab_addRecovery');
	if (addRecoveryBtn) {
		addRecoveryBtn.addEventListener('click', () => {
			migrateRecoveryRules();
			Prefs.recoveryRules.push(createRecoveryRule());
			Prefs.save();
			renderRecoveryList();
		});
	}

	// Sit-to-recover card (independent from recovery rules)
	function ensureSitRecovery() {
		const def = { enabled: false, sitTarget: 'hp', sitThreshold: 50, standTarget: 'hp', standThreshold: 90 };
		if (!Prefs.sitRecovery || typeof Prefs.sitRecovery !== 'object') {
			Prefs.sitRecovery = Object.assign({}, def);
			Prefs.save();
		}
		const s = Prefs.sitRecovery;
		if (s.sitTarget !== 'sp') s.sitTarget = 'hp';
		if (s.standTarget !== 'sp') s.standTarget = 'hp';
		if (typeof s.sitThreshold !== 'number' || isNaN(s.sitThreshold)) s.sitThreshold = def.sitThreshold;
		if (typeof s.standThreshold !== 'number' || isNaN(s.standThreshold)) s.standThreshold = def.standThreshold;
		s.sitThreshold = Math.max(0, Math.min(100, Math.round(s.sitThreshold)));
		s.standThreshold = Math.max(0, Math.min(100, Math.round(s.standThreshold)));
		s.enabled = !!s.enabled;
		return s;
	}

	function updateSitWarn() {
		const warn = root.querySelector('#ab_sitWarn');
		if (!warn) return;
		const s = ensureSitRecovery();
		if (s.sitTarget === s.standTarget && s.standThreshold <= s.sitThreshold) {
			warn.textContent = '站起阈值应大于坐下阈值，否则会频繁坐起';
		} else {
			warn.textContent = '';
		}
	}

	function syncSitCard() {
		const s = ensureSitRecovery();
		const en = root.querySelector('#ab_sitEnabled');
		if (en) en.checked = s.enabled;
		const sitT = root.querySelector('#ab_sitSitTarget');
		if (sitT) sitT.value = s.sitTarget;
		const sitR = root.querySelector('#ab_sitSitThreshold');
		if (sitR) sitR.value = String(s.sitThreshold);
		const sitV = root.querySelector('#ab_sitSitValue');
		if (sitV) sitV.textContent = `${s.sitThreshold}%`;
		const standT = root.querySelector('#ab_sitStandTarget');
		if (standT) standT.value = s.standTarget;
		const standR = root.querySelector('#ab_sitStandThreshold');
		if (standR) standR.value = String(s.standThreshold);
		const standV = root.querySelector('#ab_sitStandValue');
		if (standV) standV.textContent = `${s.standThreshold}%`;
		updateSitWarn();
	}

	const sitEnabledEl = root.querySelector('#ab_sitEnabled');
	if (sitEnabledEl) {
		sitEnabledEl.addEventListener('change', () => {
			ensureSitRecovery().enabled = sitEnabledEl.checked;
			Prefs.save();
		});
	}
	const sitSitTargetEl = root.querySelector('#ab_sitSitTarget');
	if (sitSitTargetEl) {
		sitSitTargetEl.addEventListener('change', () => {
			ensureSitRecovery().sitTarget = sitSitTargetEl.value === 'sp' ? 'sp' : 'hp';
			Prefs.save();
			updateSitWarn();
		});
	}
	const sitSitThresholdEl = root.querySelector('#ab_sitSitThreshold');
	if (sitSitThresholdEl) {
		sitSitThresholdEl.addEventListener('input', () => {
			let v = parseInt(sitSitThresholdEl.value, 10);
			if (isNaN(v)) v = 50;
			v = Math.max(0, Math.min(100, v));
			ensureSitRecovery().sitThreshold = v;
			const label = root.querySelector('#ab_sitSitValue');
			if (label) label.textContent = `${v}%`;
			Prefs.save();
			updateSitWarn();
		});
	}
	const sitStandTargetEl = root.querySelector('#ab_sitStandTarget');
	if (sitStandTargetEl) {
		sitStandTargetEl.addEventListener('change', () => {
			ensureSitRecovery().standTarget = sitStandTargetEl.value === 'sp' ? 'sp' : 'hp';
			Prefs.save();
			updateSitWarn();
		});
	}
	const sitStandThresholdEl = root.querySelector('#ab_sitStandThreshold');
	if (sitStandThresholdEl) {
		sitStandThresholdEl.addEventListener('input', () => {
			let v = parseInt(sitStandThresholdEl.value, 10);
			if (isNaN(v)) v = 90;
			v = Math.max(0, Math.min(100, v));
			ensureSitRecovery().standThreshold = v;
			const label = root.querySelector('#ab_sitStandValue');
			if (label) label.textContent = `${v}%`;
			Prefs.save();
			updateSitWarn();
		});
	}

	// Register chat commands once
	if (!Commands.isEnabled('autobattle')) {
		Commands.add('autobattle', 'Toggle auto-battle', () => {
			AutoBattleEngine.toggle();
			updateStatus();
			syncUIFromPrefs();
		}, ['ab', 'autob']);
	}

	if (!Commands.isEnabled('abstatus')) {
		Commands.add('abstatus', 'Show auto-battle diagnostics', () => {
			const stats = AutoBattleEngine.getStats();
			Object.keys(stats).forEach(key => {
				ChatBox.addText(`[abstatus] ${key}: ${stats[key]}`, ChatBox.TYPE.INFO, ChatBox.FILTER.PUBLIC_LOG);
			});
		}, []);
	}

	let _nextRecoveryId = 1;

	function createRecoveryRule() {
		const rules = Prefs.recoveryRules || [];
		let maxId = 0;
		rules.forEach(rule => {
			if (rule && typeof rule.id === 'number' && rule.id > maxId) {
				maxId = rule.id;
			}
		});
		_nextRecoveryId = Math.max(_nextRecoveryId, maxId + 1);
		return {
			id: _nextRecoveryId++,
			enabled: true,
			target: 'hp',
			threshold: 50,
			action: null
		};
	}

	function migrateRecoveryRules() {
		if (Prefs.recoveryMigrated) {
			if (!Array.isArray(Prefs.recoveryRules)) {
				Prefs.recoveryRules = [];
			}
			return;
		}
		const hpThres = typeof Prefs.hpThreshold === 'number' ? Prefs.hpThreshold : 50;
		const hpItem = typeof Prefs.hpPotionId === 'number' ? Prefs.hpPotionId : 501;
		const spThres = typeof Prefs.spThreshold === 'number' ? Prefs.spThreshold : 20;
		const spItem = typeof Prefs.spPotionId === 'number' ? Prefs.spPotionId : 505;
		Prefs.recoveryRules = [
			{ id: 1, enabled: true, target: 'hp', threshold: hpThres, action: { kind: 'item', ITID: hpItem } },
			{ id: 2, enabled: true, target: 'sp', threshold: spThres, action: { kind: 'item', ITID: spItem } }
		];
		_nextRecoveryId = 3;
		Prefs.recoveryMigrated = true;
		Prefs.save();
	}

	function renderRecoveryList() {
		const list = root.querySelector('#ab_recoveryList');
		if (!list) {
			return;
		}
		migrateRecoveryRules();
		list.innerHTML = '';
		Prefs.recoveryRules.forEach(rule => {
			list.appendChild(createRecoveryCard(rule));
		});
	}

	function createRecoveryCard(rule) {
		const card = document.createElement('div');
		card.className = 'rec-card';

		const headRow = document.createElement('div');
		headRow.className = 'rec-row';
		const enableLabel = document.createElement('label');
		const enableBox = document.createElement('input');
		enableBox.type = 'checkbox';
		enableBox.checked = !!rule.enabled;
		enableBox.addEventListener('change', () => {
			rule.enabled = enableBox.checked;
			Prefs.save();
		});
		enableLabel.appendChild(enableBox);
		enableLabel.appendChild(document.createTextNode(' Enable'));
		const delBtn = document.createElement('button');
		delBtn.className = 'rec-del';
		delBtn.textContent = 'x';
		delBtn.title = 'Delete';
		delBtn.addEventListener('click', () => {
			Prefs.recoveryRules = Prefs.recoveryRules.filter(item => item.id !== rule.id);
			Prefs.save();
			renderRecoveryList();
		});
		headRow.appendChild(enableLabel);
		headRow.appendChild(delBtn);

		const condRow = document.createElement('div');
		condRow.className = 'rec-row';
		const targetSelect = document.createElement('select');
		['hp', 'sp'].forEach(value => {
			const opt = document.createElement('option');
			opt.value = value;
			opt.textContent = value.toUpperCase();
			targetSelect.appendChild(opt);
		});
		targetSelect.value = rule.target === 'sp' ? 'sp' : 'hp';
		targetSelect.addEventListener('change', () => {
			rule.target = targetSelect.value;
			Prefs.save();
		});
		const slider = document.createElement('input');
		slider.type = 'range';
		slider.min = '0';
		slider.max = '100';
		slider.step = '1';
		slider.value = String(rule.threshold);
		const valueLabel = document.createElement('span');
		valueLabel.className = 'rec-value';
		valueLabel.textContent = `${rule.threshold}%`;
		slider.addEventListener('input', () => {
			let v = parseInt(slider.value, 10);
			if (isNaN(v)) {
				v = 50;
			}
			rule.threshold = Math.max(0, Math.min(100, v));
			valueLabel.textContent = `${rule.threshold}%`;
			Prefs.save();
		});
		condRow.appendChild(targetSelect);
		condRow.appendChild(slider);
		condRow.appendChild(valueLabel);

		const useRow = document.createElement('div');
		useRow.className = 'rec-row';
		useRow.appendChild(document.createTextNode('Use'));
		const slot = document.createElement('div');
		slot.className = 'rec-slot';
		slot.title = 'Drag an item or skill here (right-click to clear)';
		slot.addEventListener('dragover', event => {
			event.stopImmediatePropagation();
			event.preventDefault();
			slot.classList.add('dragover');
		});
		slot.addEventListener('dragleave', () => {
			slot.classList.remove('dragover');
		});
		slot.addEventListener('drop', event => {
			slot.classList.remove('dragover');
			if (onActionSlotDrop(event, action => { rule.action = action; })) {
				Prefs.save();
				renderActionSlot(slot, rule.action);
			}
		});
		slot.addEventListener('contextmenu', event => {
			event.preventDefault();
			rule.action = null;
			Prefs.save();
			renderActionSlot(slot, rule.action);
		});
		useRow.appendChild(slot);
		renderActionSlot(slot, rule.action);

		card.appendChild(headRow);
		card.appendChild(condRow);
		card.appendChild(useRow);
		return card;
	}

	function onActionSlotDrop(event, setAction) {
		let data, element;
		event.stopImmediatePropagation();
		event.preventDefault();
		try {
			data = JSON.parse(event.dataTransfer.getData('Text'));
			element = data.data;
		} catch (_e) {
			return false;
		}
		if (!data || !element) {
			return false;
		}
		if (data.type !== 'item' && data.type !== 'skill') {
			return false;
		}
		let action = null;
		if (data.type === 'item') {
			const ITID = element.ITID;
			if (typeof ITID !== 'number') {
				return false;
			}
			action = { kind: 'item', ITID: ITID };
		} else {
			const SKID = element.SKID;
			if (typeof SKID !== 'number') {
				return false;
			}
			let level = element.selectedLevel || element.level || 1;
			level = Math.max(1, Math.min(10, parseInt(level, 10) || 1));
			action = { kind: 'skill', SKID: SKID, level: level };
		}
		setAction(action);
		return true;
	}

	function renderActionSlot(slot, action) {
		slot.classList.toggle('filled', !!(action));
		slot.style.backgroundImage = '';
		slot.removeAttribute('data-tooltip');
		if (!action) {
			slot.title = 'Drag an item or skill here (right-click to clear)';
			return;
		}
		let file = null;
		let name = '';
		if (action.kind === 'skill') {
			const info = SkillInfo[action.SKID] || {};
			file = info.Name || null;
			name = info.SkillName || info.Name || `Skill ${action.SKID}`;
			name += ` Lv${action.level || 1}`;
		} else {
			const it = DB.getItemInfo(action.ITID);
			if (it) {
				file = it.identifiedResourceName;
				name = `Item ${action.ITID}`;
			}
		}
		if (!file) {
			slot.title = name || 'Unknown';
			return;
		}
		Client.loadFile(`${DB.INTERFACE_PATH}item/${file}.bmp`, url => {
			slot.style.backgroundImage = `url(${url})`;
			slot.title = name;
		});
	}

	function ensureTeleportSlots() {
		if (!Array.isArray(Prefs.teleportSlots)) {
			Prefs.teleportSlots = [null, null];
			Prefs.save();
		}
		while (Prefs.teleportSlots.length < 2) {
			Prefs.teleportSlots.push(null);
		}
		return Prefs.teleportSlots;
	}

	function bindTeleportSlot(selector, index) {
		const slot = root.querySelector(selector);
		if (!slot) {
			return;
		}
		slot.addEventListener('dragover', event => {
			event.stopImmediatePropagation();
			event.preventDefault();
			slot.classList.add('dragover');
		});
		slot.addEventListener('dragleave', () => {
			slot.classList.remove('dragover');
		});
		slot.addEventListener('drop', event => {
			slot.classList.remove('dragover');
			if (onActionSlotDrop(event, action => { ensureTeleportSlots()[index] = action; })) {
				Prefs.save();
				renderActionSlot(slot, ensureTeleportSlots()[index]);
			}
		});
		slot.addEventListener('contextmenu', event => {
			event.preventDefault();
			ensureTeleportSlots()[index] = null;
			Prefs.save();
			renderActionSlot(slot, null);
		});
	}

	function renderTeleportSlots() {
		const slots = ensureTeleportSlots();
		['#ab_tpSlot0', '#ab_tpSlot1'].forEach((selector, index) => {
			const slot = root.querySelector(selector);
			if (slot) {
				renderActionSlot(slot, slots[index]);
			}
		});
	}

	function ensureBuffSlots() {
		if (!Array.isArray(Prefs.buffSlots)) {
			Prefs.buffSlots = [null, null, null, null, null];
			Prefs.save();
		}
		while (Prefs.buffSlots.length < 5) {
			Prefs.buffSlots.push(null);
		}
		return Prefs.buffSlots;
	}

	function bindBuffSlot(selector, index) {
		const slot = root.querySelector(selector);
		if (!slot) {
			return;
		}
		slot.addEventListener('dragover', event => {
			event.stopImmediatePropagation();
			event.preventDefault();
			slot.classList.add('dragover');
		});
		slot.addEventListener('dragleave', () => {
			slot.classList.remove('dragover');
		});
		slot.addEventListener('drop', event => {
			slot.classList.remove('dragover');
			if (onActionSlotDrop(event, action => { ensureBuffSlots()[index] = action; })) {
				Prefs.save();
				renderActionSlot(slot, ensureBuffSlots()[index]);
			}
		});
		slot.addEventListener('contextmenu', event => {
			event.preventDefault();
			ensureBuffSlots()[index] = null;
			Prefs.save();
			renderActionSlot(slot, null);
		});
	}

	function renderBuffSlots() {
		const slots = ensureBuffSlots();
		for (let i = 0; i < 5; i++) {
			const slot = root.querySelector(`#ab_buffSlot${i}`);
			if (slot) {
				renderActionSlot(slot, slots[i]);
			}
		}
	}

	let _targetRequestedMap = null;

	function getTargetFilter() {
		if (Array.isArray(Prefs.targetFilter)) {
			return Prefs.targetFilter;
		}
		return [];
	}

	function renderTargetList() {
		const list = root.querySelector('#ab_targetList');
		if (!list) {
			return;
		}
		let mapKey = '';
		try {
			LootRates.refreshIfNeeded();
			mapKey = LootRates.getMapKey() || '';
		} catch (_e) {
			mapKey = '';
		}
		let mobs = [];
		try {
			mobs = (getCachedMobs() || []).slice().sort((a, b) => a.mobId - b.mobId);
		} catch (_e) {
			mobs = [];
		}
		if (!mapKey || !mobs.length) {
			if (_targetRequestedMap !== mapKey) {
				_targetRequestedMap = mapKey;
				try {
					reqMapMobs();
				} catch (_e) {
					// ignore
				}
			}
			list.innerHTML = '<div class="tempty">Loading map monsters… reopen this tab.</div>';
			return;
		}
		_targetRequestedMap = mapKey;
		const active = Prefs.targetFilterMap === mapKey ? getTargetFilter() : [];
		list.innerHTML = '';
		mobs.forEach(mob => {
			const label = document.createElement('label');
			const box = document.createElement('input');
			box.type = 'checkbox';
			box.checked = active.indexOf(mob.mobId) !== -1;
			box.addEventListener('change', () => {
				const cur = LootRates.getMapKey() || '';
				const set = new Set(Prefs.targetFilterMap === cur ? getTargetFilter() : []);
				if (box.checked) {
					set.add(mob.mobId);
				} else {
					set.delete(mob.mobId);
				}
				Prefs.targetFilterMap = cur;
				Prefs.targetFilter = Array.from(set);
				Prefs.save();
			});
			label.appendChild(box);
			let monsterName = `Unknown (${mob.mobId})`;
			try {
				monsterName = DB.getMonsterName(mob.mobId) || monsterName;
			} catch (_e) {
				// keep fallback
			}
			label.appendChild(document.createTextNode(` ${monsterName}`));
			const qty = document.createElement('span');
			qty.className = 'tqty';
			qty.textContent = `x ${mob.qty}`;
			label.appendChild(qty);
			list.appendChild(label);
		});
	}

	function refreshSkillState() {
		const sid = root.querySelector('#ab_skillId');
		const slv = root.querySelector('#ab_skillLv');
		if (!sid || !slv) return;
		const dis = !Prefs.useSkill;
		sid.disabled = dis;
		slv.disabled = dis;
	}

	function updateStatus() {
		const status = root.querySelector('#ab_status');
		const cb = root.querySelector('#ab_enabled');
		if (!status || !cb) return;
		const on = AutoBattleEngine.isEnabled();
		cb.checked = on;
		let label = on ? 'ON' : 'OFF';
		if (on && AutoBattleEngine.getState) {
			try {
				label += ' · ' + AutoBattleEngine.getState();
			} catch (_e) {
				// keep plain ON/OFF
			}
		}
		status.textContent = label;
		status.className = 'status ' + (on ? 'on' : 'off');
	}

	// expose for outer calls
	this._updateStatus = updateStatus;
	this._refreshSkillState = refreshSkillState;
	this._syncUIFromPrefs = syncUIFromPrefs;

	function syncUIFromPrefs() {
		const r = root.querySelector('#ab_range');
		if (r) r.value = Prefs.range;
		const us = root.querySelector('#ab_useSkill');
		if (us) us.checked = !!Prefs.useSkill;
		const slv = root.querySelector('#ab_skillLv');
		if (slv) slv.value = Prefs.skillLevel;
		const lk = root.querySelector('#ab_lockCenter');
		if (lk) lk.checked = !!Prefs.lockCenter;
		const md = root.querySelector('#ab_maxDist');
		if (md) md.value = Prefs.maxDistance;
		const ro = root.querySelector('#ab_roam');
		if (ro) ro.checked = !!Prefs.roamWhenIdle;
		const rr = root.querySelector('#ab_roamRange');
		if (rr) rr.value = Prefs.roamRange;
		const tp = root.querySelector('#ab_teleport');
		if (tp) tp.checked = !!Prefs.useTeleportOnNoTarget;
		const tps = root.querySelector('#ab_teleportSec');
		if (tps) tps.value = Prefs.teleportNoTargetSec;
		renderTeleportSlots();
		const be = root.querySelector('#ab_buffEnabled');
		if (be) be.checked = !!Prefs.buffEnabled;
		renderBuffSlots();
		const lo = root.querySelector('#ab_loot');
		if (lo) lo.checked = !!Prefs.loot;
		const lt = ensureLootTypes();
		const le = root.querySelector('#ab_lootEquip');
		if (le) le.checked = lt.equip !== false;
		const lc = root.querySelector('#ab_lootCard');
		if (lc) lc.checked = lt.card !== false;
		const lco = root.querySelector('#ab_lootConsumable');
		if (lco) lco.checked = lt.consumable !== false;
		const letc = root.querySelector('#ab_lootEtc');
		if (letc) letc.checked = lt.etc !== false;
		const lmw = root.querySelector('#ab_lootMaxWeight');
		if (lmw) lmw.value = Prefs.lootMaxWeight;
		const lmr = root.querySelector('#ab_lootMaxRate');
		if (lmr) lmr.value = Prefs.lootMaxRate;
		const aa = root.querySelector('#ab_attackedAction');
		if (aa) aa.value = Prefs.attackedAction === 'retaliate' || Prefs.attackedAction === 'teleport' ? Prefs.attackedAction : 'ignore';
		const atc = root.querySelector('#ab_attackedTeleportCount');
		if (atc) atc.value = Prefs.attackedTeleportCount;
		const so = root.querySelector('#ab_stopOnDeath');
		if (so) so.checked = !!Prefs.stopOnDeath;
		renderRecoveryList();
		syncSitCard();
		renderTargetList();
		updateStatus();
		refreshSkillState();
	}
};

AutoBattle.onAppend = function onAppend() {
	const root = this.getRoot();
	// Populate skill list
	const skillSelect = root.querySelector('#ab_skillId');
	if (skillSelect) {
		// Clear
		skillSelect.innerHTML = '';
		const noneOpt = document.createElement('option');
		noneOpt.value = '0';
		noneOpt.textContent = 'None (Normal Attack)';
		skillSelect.appendChild(noneOpt);

		try {
			const ui = SkillList.getUI();
			let list = [];
			if (ui && ui.list) {
				list = ui.list;
			} else if (ui && ui.getSkills) {
				list = ui.getSkills();
			}
			// Fallback: also check SkillInfo keys if list empty
			if (!list || list.length === 0) {
				// keep only none
			} else {
				list.forEach(skill => {
					const info = SkillInfo[skill.SKID] || {};
					const name = info.SkillName || info.Name || `Skill ${skill.SKID}`;
					const opt = document.createElement('option');
					opt.value = String(skill.SKID);
					opt.textContent = `${name} (${skill.SKID}) Lv${skill.level || 1}`;
					skillSelect.appendChild(opt);
				});
			}
		} catch (e) {
			// ignore
		}
		skillSelect.value = String(Prefs.skillId || 0);
	}

	// Sync all fields
	if (this._syncUIFromPrefs) {
		this._syncUIFromPrefs();
	}

	// Position save on move
	const host = this._host;
	if (host) {
		host.style.top = '120px';
		host.style.left = '400px';
	}

	// Live state readout (ON · idle/chase/...) while the panel is open.
	if (this._statusTimer) {
		clearInterval(this._statusTimer);
	}
	this._statusTimer = setInterval(() => {
		if (this._updateStatus) {
			this._updateStatus();
		}
	}, 500);
};

AutoBattle.onRemove = function onRemove() {
	if (this._statusTimer) {
		clearInterval(this._statusTimer);
		this._statusTimer = null;
	}
	Prefs.save();
};

AutoBattle.onKeyDown = function onKeyDown(event) {
	if (event.which === 27) { // ESC
		this.remove();
		return false;
	}
	return true;
};

AutoBattle.toggle = function toggle() {
	if (this._host && this._host.parentNode) {
		this.remove();
	} else {
		this.append();
	}
};

export default UIManager.addComponent(AutoBattle);
