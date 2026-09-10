/**
 * UI/Components/Teleport/Teleport.js
 *
 * Convenience teleport window: browse common cities and field maps (plus
 * favorites and recent destinations) and warp with one click.
 *
 * Transport lives in Engine/MapEngine/Teleport.js (custom CZ_REQ_TELEPORT;
 * legacy CZ_MOVETO_MAP for GM). Permission / item-cost checks are enforced
 * server-side and reported back through ZC_ACK_TELEPORT.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import UIManager from 'UI/UIManager.js';
import GUIComponent from 'UI/GUIComponent.js';
import Commands from 'Controls/ProcessCommand.js';
import ChatBox from 'UI/Components/ChatBox/ChatBox.js';
import Session from 'Engine/SessionStorage.js';
import MapRenderer from 'Renderer/MapRenderer.js';
import DB from 'DB/DBManager.js';
import Prefs from 'Preferences/Teleport.js';
import Destinations from 'DB/Teleport/Destinations.js';
import { teleportTo } from 'Engine/MapEngine/Teleport.js';
import htmlText from './Teleport.html?raw';
import cssText from './Teleport.css?raw';
import 'UI/Elements/Elements.js';

const RESULT_TEXT = {
	1: '地图不存在',
	2: '该地图禁止传送',
	3: '没有传送权限',
	4: '缺少所需物品',
	5: '传送冷却中',
	6: '坐标无效',
	7: '职业/等级不符'
};

const MAX_RECENT = 12;

const Teleport = new GUIComponent('Teleport', cssText);

Teleport.render = () => htmlText;

Teleport._tab = 'cities';
Teleport._sub = 'favorites';
Teleport._keyword = '';
Teleport._pending = null;

function escapeHtml(str) {
	return String(str).replace(
		/[&<>"']/g,
		c =>
			({
				'&': '&amp;',
				'<': '&lt;',
				'>': '&gt;',
				'"': '&quot;',
				"'": '&#39;'
			})[c]
	);
}

function destKey(dest) {
	return `${dest.map}:${dest.x},${dest.y}`;
}

function ensurePrefs() {
	if (!Array.isArray(Prefs.favorites)) {
		Prefs.favorites = [];
	}
	if (!Array.isArray(Prefs.recent)) {
		Prefs.recent = [];
	}
	// Migrate the old split favorites/recent tabs into the merged "mine" tab.
	if (Prefs.tab === 'favorites' || Prefs.tab === 'recent') {
		Prefs.subtab = Prefs.tab;
		Prefs.tab = 'mine';
	}
	if (Prefs.tab !== 'cities' && Prefs.tab !== 'fields' && Prefs.tab !== 'mine') {
		Prefs.tab = 'cities';
	}
	if (Prefs.subtab !== 'favorites' && Prefs.subtab !== 'recent') {
		Prefs.subtab = 'favorites';
	}
}

function setStatus(text, isError = false) {
	const root = Teleport.getRoot();
	if (!root) {
		return;
	}
	const el = root.querySelector('.status');
	if (el) {
		el.textContent = text || '';
		el.style.color = isError ? '#b00' : '#2a6';
	}
}

function currentTabList() {
	switch (Teleport._tab) {
		case 'fields':
			return Destinations.fields.slice();
		case 'mine':
			return Teleport._sub === 'recent' ? Prefs.recent.slice() : Prefs.favorites.slice();
		case 'cities':
		default:
			return Destinations.cities.slice();
	}
}

function isFavorite(dest) {
	const key = destKey(dest);
	return Prefs.favorites.some(d => destKey(d) === key);
}

function toggleFavorite(dest) {
	const key = destKey(dest);
	const index = Prefs.favorites.findIndex(d => destKey(d) === key);
	if (index === -1) {
		Prefs.favorites.unshift({ name: dest.name, map: dest.map, x: dest.x, y: dest.y, level: dest.level });
	} else {
		Prefs.favorites.splice(index, 1);
	}
	Prefs.save();
}

function addRecent(dest) {
	const key = destKey(dest);
	Prefs.recent = Prefs.recent.filter(d => destKey(d) !== key);
	Prefs.recent.unshift({ name: dest.name, map: dest.map, x: dest.x, y: dest.y, level: dest.level });
	if (Prefs.recent.length > MAX_RECENT) {
		Prefs.recent.length = MAX_RECENT;
	}
	Prefs.save();
}

function renderList() {
	const root = Teleport.getRoot();
	if (!root) {
		return;
	}
	const list = root.querySelector('.list');
	const keyword = Teleport._keyword.trim().toLowerCase();
	let entries = currentTabList();

	if (keyword) {
		entries = entries.filter(d => {
			return d.name.toLowerCase().indexOf(keyword) !== -1 || d.map.toLowerCase().indexOf(keyword) !== -1;
		});
	}

	if (!entries.length) {
		const emptyText = keyword ? '没有匹配的目的地' : '暂无记录';
		list.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
		return;
	}

	list.innerHTML = entries
		.map(d => {
			const star = isFavorite(d) ? '★' : '☆';
			const level = d.level ? `<span class="level">${escapeHtml(d.level)}</span>` : '';
			return (
				`<div class="row" data-map="${escapeHtml(d.map)}" data-x="${d.x | 0}" data-y="${d.y | 0}" data-name="${escapeHtml(d.name)}"${d.level ? ` data-level="${escapeHtml(d.level)}"` : ''}>` +
				`<span class="name">${escapeHtml(d.name)}</span>` +
				level +
				`<span class="map">${escapeHtml(d.map)}</span>` +
				`<button class="star${isFavorite(d) ? ' on' : ''}" title="收藏/取消收藏">${star}</button>` +
				'</div>'
			);
		})
		.join('');
}

function readRow(destEl) {
	return {
		name: destEl.dataset.name,
		map: destEl.dataset.map,
		x: parseInt(destEl.dataset.x, 10) || 0,
		y: parseInt(destEl.dataset.y, 10) || 0,
		level: destEl.dataset.level || undefined
	};
}

function requestTeleport(dest) {
	if (!dest || !dest.map) {
		return;
	}
	Teleport._pending = dest;
	setStatus(`正在传送至 ${dest.name}…`);
	teleportTo(dest.map, dest.x, dest.y);
}

function favoriteCurrent() {
	const map = MapRenderer.currentMap;
	if (!map) {
		setStatus('无法读取当前地图', true);
		return;
	}
	const x = Session.Entity ? Math.floor(Session.Entity.position[0]) : 0;
	const y = Session.Entity ? Math.floor(Session.Entity.position[1]) : 0;
	let label = map;
	try {
		label = DB.getMapName(map, map) || map;
	} catch (_e) {
		label = map;
	}
	const dest = { name: `${label} (${x},${y})`, map, x, y };
	if (isFavorite(dest)) {
		setStatus('当前位置已在收藏中');
		return;
	}
	Prefs.favorites.unshift(dest);
	Prefs.save();
	if (Teleport._tab === 'mine' && Teleport._sub === 'favorites') {
		renderList();
	}
	setStatus('已收藏当前位置');
}

function syncTabUI(root) {
	if (!root) {
		return;
	}
	root.querySelectorAll('.tabs .tab').forEach(b =>
		b.classList.toggle('active', b.getAttribute('data-tab') === Teleport._tab)
	);
	const subtabs = root.querySelector('.subtabs');
	if (subtabs) {
		subtabs.classList.toggle('hidden', Teleport._tab !== 'mine');
	}
	root.querySelectorAll('.subtabs .subtab').forEach(b =>
		b.classList.toggle('active', b.getAttribute('data-sub') === Teleport._sub)
	);
}

Teleport.init = function init() {
	const root = this.getRoot();

	this.draggable('.titlebar');

	const closeBtn = root.querySelector('.close');
	if (closeBtn) {
		closeBtn.addEventListener('mousedown', ev => ev.stopImmediatePropagation());
		closeBtn.addEventListener('click', () => this.remove());
	}

	ensurePrefs();
	Teleport._tab = Prefs.tab;
	Teleport._sub = Prefs.subtab;
	syncTabUI(root);

	// Tabs
	root.querySelectorAll('.tabs .tab').forEach(btn => {
		btn.addEventListener('click', () => {
			Teleport._tab = btn.getAttribute('data-tab');
			Prefs.tab = Teleport._tab;
			Prefs.save();
			syncTabUI(root);
			renderList();
		});
	});

	// Sub-tabs (favorites / recent inside the merged "mine" tab)
	root.querySelectorAll('.subtabs .subtab').forEach(btn => {
		btn.addEventListener('click', () => {
			Teleport._sub = btn.getAttribute('data-sub');
			Prefs.subtab = Teleport._sub;
			Prefs.save();
			syncTabUI(root);
			renderList();
		});
	});

	// Search
	const searchEl = root.querySelector('.search');
	if (searchEl) {
		searchEl.addEventListener('input', () => {
			Teleport._keyword = searchEl.value || '';
			renderList();
		});
	}

	// Favorite current location
	const favBtn = root.querySelector('.fav-current');
	if (favBtn) {
		favBtn.addEventListener('click', () => favoriteCurrent());
	}

	// List interaction (delegated)
	const list = root.querySelector('.list');
	if (list) {
		list.addEventListener('click', ev => {
			const row = ev.target.closest('.row');
			if (!row) {
				return;
			}
			const dest = readRow(row);
			if (ev.target.closest('.star')) {
				toggleFavorite(dest);
				renderList();
				return;
			}
			requestTeleport(dest);
		});
	}

	// Chat command
	if (!Commands.isEnabled('tp')) {
		Commands.add('tp', 'Toggle convenience teleport', () => Teleport.toggle(), ['teleport', 'trans']);
	}
};

Teleport.onAppend = function onAppend() {
	const root = this.getRoot();
	const host = this._host;
	if (host) {
		host.style.left = `${Prefs.x || 320}px`;
		host.style.top = `${Prefs.y || 120}px`;
	}
	ensurePrefs();
	Teleport._tab = Prefs.tab;
	Teleport._sub = Prefs.subtab;
	syncTabUI(root);
	const searchEl = root.querySelector('.search');
	if (searchEl) {
		searchEl.value = Teleport._keyword;
		searchEl.focus();
	}
	renderList();
};

Teleport.onRemove = function onRemove() {
	const host = this._host;
	if (host) {
		Prefs.x = parseInt(host.style.left, 10) || Prefs.x;
		Prefs.y = parseInt(host.style.top, 10) || Prefs.y;
	}
	Prefs.save();
};

Teleport.onKeyDown = function onKeyDown(event) {
	if (this.isEditableFocused && this.isEditableFocused()) {
		return true;
	}
	if (event.which === 27) {
		this.remove();
		return false;
	}
	return true;
};

Teleport.onShortCut = function onShortCut(key) {
	if (key.cmd === 'TOGGLE') {
		this.toggle();
	}
};

/** Called by Engine/MapEngine/Teleport.js when ZC_ACK_TELEPORT arrives. */
Teleport.onAck = function onAck(result, param) {
	const dest = Teleport._pending;
	if (result === 0) {
		if (dest) {
			addRecent(dest);
			ChatBox.addText(`[传送] 已前往 ${dest.name}`, ChatBox.TYPE.INFO, ChatBox.FILTER.PUBLIC_LOG);
		}
		Teleport._pending = null;
		setStatus('');
		// The map change tears this window down via cleanGameUI().
		return;
	}
	const text = RESULT_TEXT[result] || `传送失败 (${result})`;
	setStatus(param ? `${text} (#${param})` : text, true);
};

Teleport.toggle = function toggle() {
	if (this._host && this._host.parentNode) {
		this.remove();
	} else {
		this.append();
	}
};

export default UIManager.addComponent(Teleport);
