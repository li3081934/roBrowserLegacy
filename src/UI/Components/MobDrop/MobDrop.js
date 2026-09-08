/**
 * UI/Components/MobDrop/MobDrop.js
 *
 * Current-map monster + drop-rate viewer. Monster list and drops come
 * from the map server via custom packets (CZ/ZC_REQ_MAPMOBS,
 * CZ/ZC_REQ_MOBDROPS); see Engine/MapEngine/MobDrop.js.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import DB from 'DB/DBManager.js';
import Client from 'Core/Client.js';
import Renderer from 'Renderer/Renderer.js';
import SpriteRenderer from 'Renderer/SpriteRenderer.js';
import Entity from 'Renderer/Entity/Entity.js';
import MapRenderer from 'Renderer/MapRenderer.js';
import Network from 'Network/NetworkManager.js';
import PACKET from 'Network/PacketStructure.js';
import UIManager from 'UI/UIManager.js';
import GUIComponent from 'UI/GUIComponent.js';
import ItemInfo from 'UI/Components/ItemInfo/ItemInfo.js';
import ItemType from 'DB/Items/ItemType.js';
import Commands from 'Controls/ProcessCommand.js';
import htmlText from './MobDrop.html?raw';
import cssText from './MobDrop.css?raw';
import 'UI/Elements/Elements.js';

/**
 * Create component
 */
const MobDrop = new GUIComponent('MobDrop', cssText);

MobDrop.render = () => htmlText;

MobDrop._mobs = [];
MobDrop._selected = 0;
MobDrop._drops = {};
MobDrop._requested = false;
// mobId -> { entity, canvas, ctx } for idle sprite animation (Sense-style)
MobDrop._sprites = new Map();
MobDrop._spriteLoop = false;

function escapeHtml(str) {
	return String(str).replace(/[&<>"']/g, (c) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		'\'': '&#39;'
	}[c]));
}

function getItemName(id) {
	try {
		return DB.getItemInfo(id).identifiedDisplayName || `Unknown (${id})`;
	} catch (_e) {
		return `Unknown (${id})`;
	}
}

function getMonsterName(id) {
	try {
		return DB.getMonsterName(id) || `Unknown (${id})`;
	} catch (_e) {
		return `Unknown (${id})`;
	}
}

function getMapDisplayName() {
	const raw = MapRenderer.currentMap || '';
	if (!raw) {
		return '';
	}
	try {
		return DB.getMapName(raw, raw.replace(/\.gat$/i, '')) || raw;
	} catch (_e) {
		return raw;
	}
}

function loadItemIcon(iconEl, id) {
	let info = null;
	try {
		info = DB.getItemInfo(id);
	} catch (_e) {
		return;
	}
	if (!info || !info.identifiedResourceName) {
		return;
	}
	Client.loadFile(`${DB.INTERFACE_PATH}item/${info.identifiedResourceName}.bmp`, (data) => {
		if (iconEl && iconEl.isConnected) {
			iconEl.style.backgroundImage = `url(${data})`;
		}
	});
}

function requestMapMobs() {
	MobDrop._requested = true;
	try {
		Network.sendPacket(new PACKET.CZ.REQ_MAPMOBS());
	} catch (_e) {
		// ignore
	}
}

function requestMobDrops(mobId) {
	try {
		const pkt = new PACKET.CZ.REQ_MOBDROPS();
		pkt.mobId = mobId;
		Network.sendPacket(pkt);
	} catch (_e) {
		// ignore
	}
}

function renderMobList() {
	const root = MobDrop.getRoot();
	const list = root.querySelector('.moblist');
	const mapEl = root.querySelector('.mapname');
	mapEl.textContent = getMapDisplayName();
	list.innerHTML = '';

	if (!MobDrop._mobs.length) {
		list.insertAdjacentHTML('beforeend', `<div class="empty">${MobDrop._requested ? '等待服务器回包…<br/>（无回包 = map-server 未更新补丁）' : '暂无数据'}</div>`);
		syncSprites();
		return;
	}

	MobDrop._mobs.forEach((mob) => {
		const cls = mob.mobId === MobDrop._selected ? 'mob selected' : 'mob';
		list.insertAdjacentHTML(
			'beforeend',
			`<div class="${cls}" data-id="${mob.mobId}"><canvas class="mobspr" data-id="${mob.mobId}" width="64" height="64"></canvas><span class="name">${escapeHtml(getMonsterName(mob.mobId))}</span><span class="qty">x ${mob.qty}</span></div>`
		);
	});
	syncSprites();
}

/**
 * (Re)build per-row idle sprite entities and drive them with a single
 * render loop (same technique as Sense: bind2DContext + renderEntity).
 * Entities are reused across re-renders so sprites don't reload/flicker.
 */
function syncSprites() {
	let root = null;
	try {
		root = MobDrop.getRoot();
	} catch (_e) {
		return;
	}
	if (!root) {
		return;
	}
	const seen = new Set();
	MobDrop._mobs.forEach((mob) => {
		seen.add(mob.mobId);
		const canvas = root.querySelector(`canvas.mobspr[data-id="${mob.mobId}"]`);
		if (!canvas) {
			return;
		}
		let spr = MobDrop._sprites.get(mob.mobId);
		if (!spr) {
			const entity = new Entity();
			try {
				entity.set({
					job: mob.mobId,
					action: 0,
					direction: 0
				});
			} catch (_e) {
				return;
			}
			spr = { entity: entity, canvas: canvas, ctx: canvas.getContext('2d') };
			MobDrop._sprites.set(mob.mobId, spr);
		} else {
			spr.canvas = canvas;
			spr.ctx = canvas.getContext('2d');
		}
	});
	MobDrop._sprites.forEach((_spr, id) => {
		if (!seen.has(id)) {
			MobDrop._sprites.delete(id);
		}
	});
	if (MobDrop._sprites.size) {
		startSpriteLoop();
	} else {
		stopSpriteLoop();
	}
}

function renderSprites() {
	MobDrop._sprites.forEach((spr) => {
		if (!spr.canvas.isConnected) {
			return;
		}
		SpriteRenderer.bind2DContext(spr.ctx, Math.floor(spr.canvas.width / 2), spr.canvas.height);
		spr.ctx.clearRect(0, 0, spr.canvas.width, spr.canvas.height);
		spr.entity.renderEntity();
	});
}

function startSpriteLoop() {
	if (!MobDrop._spriteLoop) {
		MobDrop._spriteLoop = true;
		Renderer.render(renderSprites);
	}
}

function stopSpriteLoop() {
	if (MobDrop._spriteLoop) {
		MobDrop._spriteLoop = false;
		Renderer.stop(renderSprites);
	}
}

function clearSprites() {
	stopSpriteLoop();
	MobDrop._sprites.clear();
}

function renderDropDetail() {
	const root = MobDrop.getRoot();
	const detail = root.querySelector('.dropdetail');
	detail.innerHTML = '';

	const mobId = MobDrop._selected;
	if (!mobId) {
		detail.insertAdjacentHTML('beforeend', '<div class="empty">点击左侧怪物查看掉落</div>');
		return;
	}

	const data = MobDrop._drops[mobId];
	if (!data) {
		detail.insertAdjacentHTML('beforeend', `<div class="empty">${escapeHtml(getMonsterName(mobId))}<br/>掉落读取中…</div>`);
		return;
	}

	let html = `<div class="drophead">${escapeHtml(getMonsterName(mobId))}（掉率已含服务器倍率）</div>`;
	if (!data.drops.length && !data.mvpDrops.length) {
		html += '<div class="empty">该怪物无掉落</div>';
	}
	data.drops.forEach((drop) => {
		const rate = (drop.rate / 100).toFixed(2);
		const nosteal = (drop.flags & 1) ? '<span class="nosteal">不可偷</span>' : '';
		html += `<div class="drop" data-id="${drop.itemId}" title="${escapeHtml(getItemName(drop.itemId))}"><span class="icon"></span><span class="name">${escapeHtml(getItemName(drop.itemId))}</span><span class="rate">${rate}%</span>${nosteal}</div>`;
	});
	if (data.mvpDrops.length) {
		html += '<div class="drophead">MVP 奖励</div>';
		data.mvpDrops.forEach((drop) => {
			const rate = (drop.rate / 100).toFixed(2);
			html += `<div class="drop" data-id="${drop.itemId}" title="${escapeHtml(getItemName(drop.itemId))}"><span class="icon"></span><span class="name">${escapeHtml(getItemName(drop.itemId))}</span><span class="rate">${rate}%</span></div>`;
		});
	}
	detail.innerHTML = html;
	detail.querySelectorAll('.drop').forEach((el) => {
		const icon = el.querySelector('.icon');
		loadItemIcon(icon, parseInt(el.dataset.id, 10));
	});
}

/** Called by Engine/MapEngine/MobDrop.js when ZC_ACK_MAPMOBS arrives. */
MobDrop.onMapMobs = function onMapMobs(mobs) {
	MobDrop._mobs = (mobs || []).slice().sort((a, b) => a.mobId - b.mobId);
	if (!MobDrop._mobs.some((mob) => mob.mobId === MobDrop._selected)) {
		MobDrop._selected = MobDrop._mobs.length ? MobDrop._mobs[0].mobId : 0;
	}
	// Prefetch drops for cached entries is wasteful; fetch selected only.
	if (MobDrop._selected && !MobDrop._drops[MobDrop._selected]) {
		requestMobDrops(MobDrop._selected);
	}
	if (MobDrop._host && MobDrop._host.parentNode) {
		renderMobList();
		renderDropDetail();
	}
};

/** Called by Engine/MapEngine/MobDrop.js when ZC_ACK_MOBDROPS arrives. */
MobDrop.onMobDrops = function onMobDrops(mobId, data) {
	MobDrop._drops[mobId] = data;
	if (MobDrop._host && MobDrop._host.parentNode && mobId === MobDrop._selected) {
		renderDropDetail();
	}
};

MobDrop.init = function init() {
	const root = this.getRoot();

	this.draggable('.titlebar');

	const closeBtn = root.querySelector('.close');
	if (closeBtn) {
		closeBtn.addEventListener('mousedown', (ev) => ev.stopImmediatePropagation());
		closeBtn.addEventListener('click', () => this.remove());
	}

	root.querySelector('.refresh-btn').addEventListener('click', () => {
		MobDrop._mobs = [];
		MobDrop._drops = {};
		MobDrop._selected = 0;
		clearSprites();
		renderMobList();
		renderDropDetail();
		requestMapMobs();
	});

	root.querySelector('.moblist').addEventListener('click', (ev) => {
		const el = ev.target.closest('.mob');
		if (!el) {
			return;
		}
		MobDrop._selected = parseInt(el.dataset.id, 10);
		renderMobList();
		if (!MobDrop._drops[MobDrop._selected]) {
			renderDropDetail();
			requestMobDrops(MobDrop._selected);
		} else {
			renderDropDetail();
		}
	});

	root.querySelector('.dropdetail').addEventListener('contextmenu', (ev) => {
		ev.preventDefault();
		const el = ev.target.closest('.drop');
		if (!el) {
			return;
		}
		const id = parseInt(el.dataset.id, 10);
		ItemInfo.append();
		ItemInfo.uid = id;
		ItemInfo.setItem({ ITID: id, IsIdentified: true, type: ItemType.ETC });
	});

	if (!Commands.isEnabled('mobdrop')) {
		Commands.add('mobdrop', 'Toggle current-map monster drop viewer', () => MobDrop.toggle(), ['md', 'mapmob']);
	}
};

MobDrop.onAppend = function onAppend() {
	const host = this._host;
	if (host) {
		const x = Math.min(Math.max(0, 120), Math.max(0, Renderer.width - 580));
		const y = Math.min(Math.max(0, 120), Math.max(0, Renderer.height - 420));
		host.style.left = `${x}px`;
		host.style.top = `${y}px`;
	}
	renderMobList();
	renderDropDetail();
	requestMapMobs();
	// Re-render with cached engine data if the window opened after packets landed.
	try {
		const root = this.getRoot();
		if (root.querySelector('.moblist').querySelector('.empty') && MobDrop._mobs.length) {
			renderMobList();
			renderDropDetail();
		}
	} catch (_e) {
		// ignore
	}
};

MobDrop.onRemove = function onRemove() {
	clearSprites();
};

MobDrop.onKeyDown = function onKeyDown(event) {
	if (this.isEditableFocused && this.isEditableFocused()) {
		return true;
	}
	if (event.which === 27) {
		this.remove();
		return false;
	}
	return true;
};

MobDrop.toggle = function toggle() {
	if (this._host && this._host.parentNode) {
		this.remove();
	} else {
		this.append();
	}
};

export default UIManager.addComponent(MobDrop);
