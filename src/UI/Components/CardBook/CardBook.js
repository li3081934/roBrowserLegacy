/**
 * UI/Components/CardBook/CardBook.js
 *
 * Card collection album (homepage): browse all cards, submit cards from
 * player inventory (consumed on submit), and activate card effects by
 * equip category (one per category, two for accessories) without
 * socketing them into equipment.
 *
 * Server sync (custom game packets CZ/ZC_CARD_ALBUM_*) is stubbed with
 * TODOs — local state is used until the packets land.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import DB from 'DB/DBManager.js';
import ItemTable from 'DB/Items/ItemTable.js';
import ItemType from 'DB/Items/ItemType.js';
import Client from 'Core/Client.js';
import Renderer from 'Renderer/Renderer.js';
import Network from 'Network/NetworkManager.js';
import PACKET from 'Network/PacketStructure.js';
import UIManager from 'UI/UIManager.js';
import GUIComponent from 'UI/GUIComponent.js';
import Prefs from 'Preferences/CardBook.js';
import Inventory from 'UI/Components/Inventory/Inventory.js';
import ItemInfo from 'UI/Components/ItemInfo/ItemInfo.js';
import CardIllustration from 'UI/Components/CardIllustration/CardIllustration.js';
import Commands from 'Controls/ProcessCommand.js';
import htmlText from './CardBook.html?raw';
import cssText from './CardBook.css?raw';
import 'UI/Elements/Elements.js';

const PAGE_SIZE = 24;

// Card categories (must match card_album.hpp): 0 all, 1 weapon, 2 shield,
// 3 armor, 4 garment, 5 shoes, 6 headgear, 7 accessory.
// (8 is server-reserved fallback, never sent; legacy entries map there.)
const CATS = [
	{ v: 0, t: '全部' },
	{ v: 1, t: '武器' },
	{ v: 2, t: '盾牌' },
	{ v: 3, t: '铠甲' },
	{ v: 4, t: '披肩' },
	{ v: 5, t: '鞋子' },
	{ v: 6, t: '头饰' },
	{ v: 7, t: '饰品' }
];

const CardBook = new GUIComponent('CardBook', cssText);

CardBook.render = () => htmlText;

// --- local state (replaced by ZC_CARD_ALBUM_LIST once packets land) ---
function migrateActiveIds() {
	if (Array.isArray(Prefs.activeIds)) {
		return new Set(Prefs.activeIds);
	}
	if (Prefs.activeId) {
		return new Set([Prefs.activeId]);
	}
	return new Set();
}
CardBook._unlocked = new Set(Prefs.unlocked || []);
CardBook._activeIds = migrateActiveIds();
// Local-mode activation order (oldest first) for same-category eviction.
CardBook._localOrder = [...CardBook._activeIds];
CardBook._serverCatalog = {};
CardBook._catalog = [];
CardBook._showAll = !!Prefs.showAll;
CardBook._cat = (Prefs.cat >= 1 && Prefs.cat <= 7) ? Prefs.cat : 0;
CardBook._keyword = '';
CardBook._sort = 'id';
CardBook._page = 0;
// Selected entry: { kind: 'recorded'|'bag', id, index } (index only for bag)
CardBook._selected = null;

function saveState() {
	Prefs.unlocked = [...CardBook._unlocked];
	Prefs.activeIds = [...CardBook._activeIds];
	Prefs.showAll = CardBook._showAll;
	Prefs.cat = CardBook._cat;
	Prefs.save();
}

// Max simultaneously active cards per category (2 for accessories).
function catLimit(cat) {
	return cat === 7 ? 2 : 1;
}

function catOf(id) {
	return (CardBook._serverCatalog && CardBook._serverCatalog[id]) || 8;
}

function sameCatActives(cat) {
	return [...CardBook._activeIds].filter((id) => catOf(id) === cat);
}

/**
 * Build catalog: server-sent full card list first (id -> category map),
 * falling back to unlocked + inventory cards when the server has no catalog.
 */
function buildCatalog() {
	const ids = new Set();
	const map = CardBook._serverCatalog || {};
	if (map && Object.keys(map).length) {
		Object.keys(map).forEach((key) => ids.add(parseInt(key, 10)));
	} else {
		Object.keys(ItemTable).forEach((key) => {
			const id = parseInt(key, 10);
			if (!id) {
				return;
			}
			let info = null;
			try {
				info = DB.getItemInfo(id);
			} catch (_e) {
				return;
			}
			if (info && info.type === ItemType.CARD) {
				ids.add(id);
			}
		});
	}
	CardBook._unlocked.forEach((id) => ids.add(id));
	getBagCards().forEach((item) => ids.add(item.ITID));
	CardBook._catalog = [...ids].sort((a, b) => a - b);
}

/**
 * Cards currently in the player inventory. The type comes from the server
 * item list (client ItemTable entries carry no `type` field).
 */
function getBagCards() {
	let list = [];
	try {
		list = Inventory.getUI().list || [];
	} catch (_e) {
		list = [];
	}
	return list.filter((item) => item && item.ITID && item.type === ItemType.CARD);
}

/**
 * Display entries for the single unified view.
 * Default: recorded cards + unrecorded cards sitting in the bag.
 * With "show all": plus every other catalog card (locked).
 * Each entry: { kind: 'recorded'|'bag'|'locked', id, index }.
 */
function getDisplayEntries() {
	const entries = [];
	const bagItems = getBagCards();
	const bagIds = new Set();

	bagItems.forEach((item) => {
		if (CardBook._unlocked.has(item.ITID)) {
			return;
		}
		bagIds.add(item.ITID);
		entries.push({ kind: 'bag', id: item.ITID, index: item.index, count: item.count || 1, cat: catOf(item.ITID) });
	});

	CardBook._unlocked.forEach((id) => {
		entries.push({ kind: 'recorded', id, index: -1, count: 1, cat: catOf(id) });
	});

	if (CardBook._showAll) {
		CardBook._catalog.forEach((id) => {
			if (!CardBook._unlocked.has(id) && !bagIds.has(id)) {
				entries.push({ kind: 'locked', id, index: -1, count: 1, cat: catOf(id) });
			}
		});
	}

	let out = entries;
	if (CardBook._cat) {
		out = out.filter((entry) => entry.cat === CardBook._cat);
	}
	if (CardBook._keyword) {
		let re = null;
		try {
			re = new RegExp(CardBook._keyword, 'i');
		} catch (_e) {
			re = null;
		}
		if (re) {
			out = out.filter((entry) => {
				let name = '';
				try {
					name = DB.getItemInfo(entry.id).identifiedDisplayName || '';
				} catch (_err) {
					name = '';
				}
				return re.test(name);
			});
		}
	}
	const nameOf = (entry) => {
		try {
			return DB.getItemInfo(entry.id).identifiedDisplayName || '';
		} catch (_e) {
			return '';
		}
	};
	if (CardBook._sort === 'name') {
		out = out.slice().sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
	} else {
		// Recorded first, then bag, then locked; stable by id within kind.
		const order = { recorded: 0, bag: 1, locked: 2 };
		out = out.slice().sort((a, b) => (order[a.kind] - order[b.kind]) || (a.id - b.id));
	}
	return out;
}

function getItemName(id) {
	try {
		return DB.getItemInfo(id).identifiedDisplayName || `Unknown (${id})`;
	} catch (_e) {
		return `Unknown (${id})`;
	}
}

/**
 * Load a card's artwork into a `.thumb` box with fallbacks:
 * cardbmp illustration -> collection image -> item icon.
 */
function loadCardArtwork(thumbEl, iconEl, id) {
	let info = null;
	try {
		info = DB.getItemInfo(id);
	} catch (_e) {
		return;
	}
	if (!info) {
		return;
	}
	const setThumb = (url) => {
		if (thumbEl && thumbEl.isConnected) {
			thumbEl.style.backgroundImage = `url(${url})`;
			if (iconEl) {
				iconEl.style.display = 'none';
			}
		}
	};
	const loadIcon = () => {
		if (!info.identifiedResourceName) {
			return;
		}
		Client.loadFile(`${DB.INTERFACE_PATH}item/${info.identifiedResourceName}.bmp`, (data) => {
			if (iconEl && iconEl.isConnected) {
				iconEl.style.backgroundImage = `url(${data})`;
			}
		});
	};
	if (info.illustResourcesName) {
		Client.loadFile(
			`${DB.INTERFACE_PATH}cardbmp/${info.illustResourcesName}.bmp`,
			setThumb,
			() => {
				if (!info.identifiedResourceName) {
					return;
				}
				Client.loadFile(
					`${DB.INTERFACE_PATH}collection/${info.identifiedResourceName}.bmp`,
					setThumb,
					loadIcon
				);
			}
		);
	} else {
		loadIcon();
	}
}

function renderStats() {
	const root = CardBook.getRoot();
	root.querySelector('.ncnt').textContent = String(CardBook._unlocked.size);
	root.querySelector('.mcnt').textContent = String(CardBook._catalog.length);
	const activeEl = root.querySelector('.active-name');
	activeEl.textContent = `${CardBook._activeIds.size}/8`;
	activeEl.title = [...CardBook._activeIds].map((id) => getItemName(id)).join(', ') || '未生效';
}

function renderList() {
	const root = CardBook.getRoot();
	const content = root.querySelector('.content');
	const overlay = root.querySelector('.overlay');
	overlay.style.display = 'none';
	content.innerHTML = '';

	renderEntries(content);
	renderStats();
	syncChips();
	updateActionButton();
	// Reset scroll on every re-render (category/page/search/sort/show-all/refresh)
	const scroller = root.querySelector('.scroll-host');
	if (scroller) {
		scroller.scrollTop = 0;
	}
}

function entryKey(entry) {
	return `${entry.kind}:${entry.id}:${entry.index}`;
}

function renderEntries(content) {
	const entries = getDisplayEntries();
	const totalPage = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
	CardBook._page = Math.min(CardBook._page, totalPage - 1);
	const pageEntries = entries.slice(CardBook._page * PAGE_SIZE, CardBook._page * PAGE_SIZE + PAGE_SIZE);
	updatePagi(totalPage);

	if (!pageEntries.length) {
		content.insertAdjacentHTML('beforeend', `<div class="empty">${CardBook._showAll ? '全收集！' : '暂无收集，背包里的卡片会出现在这里'}</div>`);
		return;
	}

	const selKey = CardBook._selected ? entryKey(CardBook._selected) : '';
	pageEntries.forEach((entry) => {
		const name = entry.kind === 'bag' ? DB.getItemName(Inventory.getUI().getItemByIndex(entry.index) || { ITID: entry.id }) : getItemName(entry.id);
		let cls = 'item';
		if (entry.kind === 'locked') {
			cls += ' locked';
		} else if (entry.kind === 'bag') {
			cls += ' bag';
		}
		content.insertAdjacentHTML(
			'beforeend',
			`<div class="${cls}" data-kind="${entry.kind}" data-id="${entry.id}" data-index="${entry.index}" title="${name}"><div class="thumb"></div><div class="icon"></div><div class="bagtag">包</div><div class="cardname">${name}</div>${entry.kind === 'bag' ? `<div class="amount"><span class="count">${entry.count}</span></div>` : ''}</div>`
		);
		const cell = content.lastElementChild;
		if (!cell) {
			return;
		}
		if (entry.kind === 'recorded' && CardBook._activeIds.has(entry.id)) {
			cell.classList.add('active');
		}
		if (entryKey(entry) === selKey) {
			cell.classList.add('selected');
		}
		loadCardArtwork(
			cell.querySelector('.thumb'),
			cell.querySelector('.icon'),
			entry.id
		);
	});
}

function updatePagi(totalPage) {
	const root = CardBook.getRoot();
	root.querySelector('.pagi-count').textContent = `${CardBook._page + 1}/${totalPage}`;
}

function syncChips() {
	const root = CardBook.getRoot();
	root.querySelectorAll('.catchips .chip').forEach((chip) => {
		const cat = parseInt(chip.dataset.cat, 10);
		chip.classList.toggle('selected', cat === CardBook._cat);
		const label = chip.dataset.label || chip.textContent;
		chip.dataset.label = label;
		if (cat === 0) {
			chip.textContent = `${label} ${CardBook._activeIds.size}/8`;
		} else {
			chip.textContent = `${label} ${sameCatActives(cat).length}/${catLimit(cat)}`;
		}
	});
}

function updateActionButton() {
	const root = CardBook.getRoot();
	const actionBtn = root.querySelector('.action-btn');
	const hint = root.querySelector('.hint');
	const sel = CardBook._selected;

	if (!sel) {
		actionBtn.disabled = true;
		actionBtn.textContent = '提交';
		hint.textContent = '右键看详情，双击看大图';
		return;
	}
	if (sel.kind === 'bag') {
		const item = Inventory.getUI().getItemByIndex(sel.index);
		actionBtn.disabled = !item;
		actionBtn.textContent = '提交';
		hint.textContent = item ? `选中: ${DB.getItemName(item)}（提交后卡片消失）` : '右键看详情，双击看大图';
		return;
	}
	if (sel.kind === 'recorded') {
		if (CardBook._activeIds.has(sel.id)) {
			actionBtn.disabled = false;
			actionBtn.textContent = '关闭生效';
			hint.textContent = `生效中: ${getItemName(sel.id)}`;
		} else {
			actionBtn.disabled = false;
			actionBtn.textContent = '激活';
			const cat = catOf(sel.id);
			const full = sameCatActives(cat).length >= catLimit(cat);
			hint.textContent = full
				? `选中: ${getItemName(sel.id)}（该分类已满，激活将顶掉最早的一张）`
				: `选中: ${getItemName(sel.id)}`;
		}
		return;
	}
	actionBtn.disabled = true;
	actionBtn.textContent = '激活';
	hint.textContent = `选中: ${getItemName(sel.id)}（未收录）`;
}

// --- server sync (custom packets CZ/ZC_CARD_ALBUM_*) ---
// _localMode stays true until the first ZC_CARD_ALBUM_LIST arrives, so the
// window remains usable against servers without the card album patch.
CardBook._localMode = true;

function requestList() {
	try {
		Network.sendPacket(new PACKET.CZ.CARD_ALBUM_LIST_REQ());
	} catch (_e) {
		// ignore
	}
	if (CardBook._localMode) {
		renderList();
	}
}

function requestSubmit(index) {
	try {
		const pkt = new PACKET.CZ.CARD_ALBUM_SUBMIT();
		pkt.index = index;
		Network.sendPacket(pkt);
	} catch (_e) {
		// ignore
	}
	if (!CardBook._localMode) {
		return;
	}
	// Local simulation until packets land:
	const item = Inventory.getUI().getItemByIndex(index);
	if (!item) {
		return;
	}
	CardBook._unlocked.add(item.ITID);
	CardBook._selected = null;
	saveState();
	buildCatalog();
	renderList();
}

function requestActivate(cardId) {
	try {
		const pkt = new PACKET.CZ.CARD_ALBUM_ACTIVATE();
		pkt.cardId = cardId;
		Network.sendPacket(pkt);
	} catch (_e) {
		// ignore
	}
	if (!CardBook._localMode) {
		return;
	}
	if (!CardBook._unlocked.has(cardId)) {
		return;
	}
	// Local simulation mirrors the server rule: per-category budget,
	// accessories 2, evict earliest on overflow.
	const cat = catOf(cardId);
	const limit = catLimit(cat);
	CardBook._activeIds.delete(cardId);
	CardBook._localOrder = CardBook._localOrder.filter((id) => id !== cardId);
	while (sameCatActives(cat).length >= limit) {
		const victim = CardBook._localOrder.find((id) => catOf(id) === cat);
		if (victim === undefined) {
			break;
		}
		CardBook._activeIds.delete(victim);
		CardBook._localOrder = CardBook._localOrder.filter((id) => id !== victim);
	}
	CardBook._activeIds.add(cardId);
	CardBook._localOrder.push(cardId);
	saveState();
	renderList();
}

function requestDeactivate(cardId) {
	try {
		const pkt = new PACKET.CZ.CARD_ALBUM_DEACTIVATE();
		pkt.cardId = cardId;
		Network.sendPacket(pkt);
	} catch (_e) {
		// ignore
	}
	if (!CardBook._localMode) {
		return;
	}
	CardBook._activeIds.delete(cardId);
	CardBook._localOrder = CardBook._localOrder.filter((id) => id !== cardId);
	saveState();
	renderList();
}

/** Called by ZC_CARD_ALBUM_LIST handler once packets land. */
CardBook.setUnlocked = function setUnlocked(ids, activeIds, catalogIds, catalogCats) {
	CardBook._localMode = false;
	CardBook._unlocked = new Set(ids || []);
	CardBook._activeIds = new Set(activeIds || []);
	CardBook._localOrder = [...CardBook._activeIds];
	const map = {};
	(catalogIds || []).forEach((id, i) => {
		map[id] = (catalogCats && catalogCats[i]) || 8;
	});
	CardBook._serverCatalog = map;
	saveState();
	buildCatalog();
	renderList();
};

function onItemOver() {
	const root = CardBook.getRoot();
	const overlay = root.querySelector('.overlay');
	// .overlay is positioned absolute inside #CardBook, so measure against it
	const box = root.querySelector('#CardBook').getBoundingClientRect();
	const rect = this.getBoundingClientRect();
	overlay.style.display = 'block';
	overlay.style.top = `${rect.bottom - box.top + 4}px`;
	overlay.style.left = `${rect.left - box.left + 8}px`;
	overlay.textContent = this.title;
}

CardBook.init = function init() {
	const root = this.getRoot();

	this.draggable('.titlebar');

	const closeBtn = root.querySelector('.close');
	if (closeBtn) {
		closeBtn.addEventListener('mousedown', (ev) => ev.stopImmediatePropagation());
		closeBtn.addEventListener('click', () => this.remove());
	}

	const showAllCheck = root.querySelector('.show-all-check');
	showAllCheck.checked = CardBook._showAll;
	showAllCheck.addEventListener('mousedown', (ev) => ev.stopImmediatePropagation());
	showAllCheck.addEventListener('change', () => {
		CardBook._showAll = showAllCheck.checked;
		CardBook._page = 0;
		CardBook._selected = null;
		saveState();
		renderList();
	});

	const chipsBox = root.querySelector('.catchips');
	chipsBox.innerHTML = '';
	CATS.forEach((cat) => {
		chipsBox.insertAdjacentHTML(
			'beforeend',
			`<button class="chip" data-cat="${cat.v}">${cat.t}</button>`
		);
	});
	chipsBox.addEventListener('click', (ev) => {
		const chip = ev.target.closest('.chip');
		if (!chip) {
			return;
		}
		CardBook._cat = parseInt(chip.dataset.cat, 10) || 0;
		CardBook._page = 0;
		CardBook._selected = null;
		saveState();
		syncChips();
		renderList();
	});

	const searchInput = root.querySelector('.cb-search');
	searchInput.addEventListener('mousedown', (ev) => ev.stopImmediatePropagation());
	searchInput.addEventListener('keydown', (ev) => ev.stopPropagation());
	const doSearch = () => {
		CardBook._keyword = searchInput.value.trim().toLowerCase();
		CardBook._page = 0;
		renderList();
	};
	root.querySelector('.cb-search-btn').addEventListener('click', doSearch);
	searchInput.addEventListener('keydown', (ev) => {
		if (ev.which === 13) {
			doSearch();
		}
	});
	root.querySelector('.cb-sort').addEventListener('change', (ev) => {
		CardBook._sort = ev.target.value;
		CardBook._page = 0;
		renderList();
	});

	root.querySelectorAll('.pagi-btn').forEach((btn) => {
		btn.addEventListener('click', () => {
			const mode = btn.dataset.page;
			if (mode === 'first') {
				CardBook._page = 0;
			} else if (mode === 'prev') {
				CardBook._page = Math.max(0, CardBook._page - 1);
			} else if (mode === 'next') {
				CardBook._page += 1;
			} else if (mode === 'last') {
				CardBook._page = 9999;
			}
			renderList();
		});
	});

	root.querySelector('.action-btn').addEventListener('click', () => {
		const sel = CardBook._selected;
		if (!sel) {
			return;
		}
		if (sel.kind === 'bag') {
			const item = Inventory.getUI().getItemByIndex(sel.index);
			if (!item) {
				return;
			}
			UIManager.showPromptBox(
				`提交 ${DB.getItemName(item)} 到收集册？提交后卡片消失。`,
				'ok',
				'cancel',
				() => requestSubmit(item.index),
				() => {}
			);
			return;
		}
		if (sel.kind === 'recorded') {
			if (CardBook._activeIds.has(sel.id)) {
				requestDeactivate(sel.id);
				return;
			}
			const cat = catOf(sel.id);
			if (sameCatActives(cat).length >= catLimit(cat)) {
				UIManager.showPromptBox(
					`该分类已满，激活 ${getItemName(sel.id)} 将顶掉最早生效的一张，继续？`,
					'ok',
					'cancel',
					() => requestActivate(sel.id),
					() => {}
				);
			} else {
				requestActivate(sel.id);
			}
		}
	});

	const content = root.querySelector('.content');
	content.addEventListener('click', (ev) => {
		const el = ev.target.closest('.item');
		if (!el) {
			return;
		}
		CardBook._selected = {
			kind: el.dataset.kind,
			id: parseInt(el.dataset.id, 10),
			index: parseInt(el.dataset.index, 10)
		};
		content.querySelectorAll('.item.selected').forEach((x) => x.classList.remove('selected'));
		el.classList.add('selected');
		updateActionButton();
	});
	content.addEventListener('mouseover', (ev) => {
		const el = ev.target.closest('.item');
		if (el) {
			onItemOver.call(el);
		}
	});
	content.addEventListener('mouseout', () => {
		root.querySelector('.overlay').style.display = 'none';
	});
	this._host.addEventListener('mouseleave', () => {
		root.querySelector('.overlay').style.display = 'none';
	});
	content.addEventListener('contextmenu', (ev) => {
		ev.preventDefault();
		const el = ev.target.closest('.item');
		if (!el) {
			return;
		}
		const id = parseInt(el.dataset.id, 10);
		ItemInfo.append();
		ItemInfo.uid = id;
		ItemInfo.setItem({ ITID: id, IsIdentified: true, type: ItemType.CARD });
	});
	content.addEventListener('dblclick', (ev) => {
		const el = ev.target.closest('.item');
		if (!el) {
			return;
		}
		const id = parseInt(el.dataset.id, 10);
		let info = null;
		try {
			info = DB.getItemInfo(id);
		} catch (_err) {
			return;
		}
		CardIllustration.append();
		CardIllustration.setCard({
			identifiedDisplayName: info.identifiedDisplayName,
			illustResourcesName: info.illustResourcesName
		});
	});

	if (!Commands.isEnabled('cardbook')) {
		Commands.add('cardbook', 'Toggle card collection album', () => CardBook.toggle(), ['cb', 'cardalbum']);
	}
};

CardBook.onAppend = function onAppend() {
	const root = this.getRoot();
	const host = this._host;
	if (host) {
		const x = Math.min(Math.max(0, Prefs.x || 100), Math.max(0, Renderer.width - 470));
		const y = Math.min(Math.max(0, Prefs.y || 100), Math.max(0, Renderer.height - 500));
		host.style.left = `${x}px`;
		host.style.top = `${y}px`;
	}
	root.querySelector('.show-all-check').checked = CardBook._showAll;
	buildCatalog();
	requestList();
};

CardBook.onRemove = function onRemove() {
	const host = this._host;
	if (host) {
		Prefs.x = parseInt(host.style.left, 10) || 0;
		Prefs.y = parseInt(host.style.top, 10) || 0;
		Prefs.save();
	}
};

CardBook.onKeyDown = function onKeyDown(event) {
	if (this.isEditableFocused && this.isEditableFocused()) {
		return true;
	}
	if (event.which === 27) {
		this.remove();
		return false;
	}
	return true;
};

CardBook.toggle = function toggle() {
	if (this._host && this._host.parentNode) {
		this.remove();
	} else {
		this.append();
	}
};

export default UIManager.addComponent(CardBook);
