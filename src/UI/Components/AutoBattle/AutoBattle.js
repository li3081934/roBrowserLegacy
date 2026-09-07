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

	// Interval
	const intervalEl = root.querySelector('#ab_interval');
	if (intervalEl) {
		intervalEl.addEventListener('change', () => {
			let v = parseInt(intervalEl.value, 10);
			if (isNaN(v)) v = 500;
			v = Math.max(200, Math.min(5000, v));
			Prefs.attackInterval = v;
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

	// Loot
	const lootEl = root.querySelector('#ab_loot');
	if (lootEl) {
		lootEl.addEventListener('change', () => {
			Prefs.loot = lootEl.checked;
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

	// Register chat commands once
	if (!Commands.isEnabled('autobattle')) {
		Commands.add('autobattle', 'Toggle auto-battle', () => {
			AutoBattleEngine.toggle();
			updateStatus();
			syncUIFromPrefs();
		}, ['ab', 'autob']);
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
			onRecoverySlotDrop(event, rule, slot);
		});
		slot.addEventListener('contextmenu', event => {
			event.preventDefault();
			rule.action = null;
			Prefs.save();
			renderRecoverySlot(slot, rule);
		});
		useRow.appendChild(slot);
		renderRecoverySlot(slot, rule);

		card.appendChild(headRow);
		card.appendChild(condRow);
		card.appendChild(useRow);
		return card;
	}

	function onRecoverySlotDrop(event, rule, slot) {
		let data, element;
		event.stopImmediatePropagation();
		event.preventDefault();
		try {
			data = JSON.parse(event.dataTransfer.getData('Text'));
			element = data.data;
		} catch (_e) {
			return;
		}
		if (!data || !element) {
			return;
		}
		if (data.type !== 'item' && data.type !== 'skill') {
			return;
		}
		if (data.type === 'item') {
			const ITID = element.ITID;
			if (typeof ITID !== 'number') {
				return;
			}
			rule.action = { kind: 'item', ITID: ITID };
		} else {
			const SKID = element.SKID;
			if (typeof SKID !== 'number') {
				return;
			}
			let level = element.selectedLevel || element.level || 1;
			level = Math.max(1, Math.min(10, parseInt(level, 10) || 1));
			rule.action = { kind: 'skill', SKID: SKID, level: level };
		}
		Prefs.save();
		renderRecoverySlot(slot, rule);
	}

	function renderRecoverySlot(slot, rule) {
		slot.classList.toggle('filled', !!(rule.action));
		slot.style.backgroundImage = '';
		slot.removeAttribute('data-tooltip');
		if (!rule.action) {
			slot.title = 'Drag an item or skill here (right-click to clear)';
			return;
		}
		let file = null;
		let name = '';
		if (rule.action.kind === 'skill') {
			const info = SkillInfo[rule.action.SKID] || {};
			file = info.Name || null;
			name = info.SkillName || info.Name || `Skill ${rule.action.SKID}`;
			name += ` Lv${rule.action.level || 1}`;
		} else {
			const it = DB.getItemInfo(rule.action.ITID);
			if (it) {
				file = it.identifiedResourceName;
				name = `Item ${rule.action.ITID}`;
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
		status.textContent = on ? 'ON' : 'OFF';
		status.className = 'status ' + (on ? 'on' : 'off');
	}

	// expose for outer calls
	this._updateStatus = updateStatus;
	this._refreshSkillState = refreshSkillState;
	this._syncUIFromPrefs = syncUIFromPrefs;

	function syncUIFromPrefs() {
		const r = root.querySelector('#ab_range');
		if (r) r.value = Prefs.range;
		const iv = root.querySelector('#ab_interval');
		if (iv) iv.value = Prefs.attackInterval;
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
		const lo = root.querySelector('#ab_loot');
		if (lo) lo.checked = !!Prefs.loot;
		const so = root.querySelector('#ab_stopOnDeath');
		if (so) so.checked = !!Prefs.stopOnDeath;
		renderRecoveryList();
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
};

AutoBattle.onRemove = function onRemove() {
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
