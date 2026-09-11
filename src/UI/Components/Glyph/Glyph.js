/**
 * UI/Components/Glyph/Glyph.js
 *
 * Standalone Glyph window.
 *
 * Glyphs are a second "equipment set": major (max 3, inner ring) and minor
 * (max 5, outer ring) slots that hold glyph items. Server-side they use real
 * custom equipment locations (EQP_GLYPH_*), so item scripts apply
 * automatically, but the UI is kept independent from the equipment window.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import UIManager from 'UI/UIManager.js';
import GUIComponent from 'UI/GUIComponent.js';
import Network from 'Network/NetworkManager.js';
import PACKET from 'Network/PacketStructure.js';
import DB from 'DB/DBManager.js';
import Client from 'Core/Client.js';
import EquipLocation from 'DB/Items/EquipmentLocation.js';
import ItemInfo from 'UI/Components/ItemInfo/ItemInfo.js';
import ChatBox from 'UI/Components/ChatBox/ChatBox.js';
import htmlText from './Glyph.html?raw';
import cssText from './Glyph.css?raw';

const Glyph = new GUIComponent('Glyph', cssText);
Glyph.render = () => htmlText;

const GLYPH_MAJOR = [EquipLocation.GLYPH_MAJOR_1, EquipLocation.GLYPH_MAJOR_2, EquipLocation.GLYPH_MAJOR_3];
const GLYPH_MINOR = [
	EquipLocation.GLYPH_MINOR_1,
	EquipLocation.GLYPH_MINOR_2,
	EquipLocation.GLYPH_MINOR_3,
	EquipLocation.GLYPH_MINOR_4,
	EquipLocation.GLYPH_MINOR_5
];
const GLYPH_BITS = GLYPH_MAJOR.concat(GLYPH_MINOR);
const GLYPH_MASK = GLYPH_BITS.reduce((mask, bit) => mask | bit, 0);
const GLYPH_MAJOR_MASK = GLYPH_MAJOR.reduce((mask, bit) => mask | bit, 0);
const GLYPH_MINOR_MASK = GLYPH_MINOR.reduce((mask, bit) => mask | bit, 0);

const BOARD = 260;
const CENTER = BOARD / 2;
const MAJOR_RADIUS = 52;
const MINOR_RADIUS = 104;
const MAJOR_SIZE = 46;
const MINOR_SIZE = 38;

/** bit -> { index, ITID } */
const _slots = new Map();

function slotEl(bit) {
	const root = Glyph.getRoot();
	return root ? root.querySelector(`#Glyph .slot[data-bit="${bit}"]`) : null;
}

/**
 * Resolve a single glyph slot bit from a location mask.
 * @param {number} mask
 * @returns {number}
 */
function pickBit(mask) {
	if (!mask) return 0;
	if ((mask & (mask - 1)) === 0) return mask; // single bit already
	for (const bit of GLYPH_BITS) {
		if (mask & bit && !_slots.has(bit)) return bit;
	}
	return 0;
}

function sendEquip(index, mask) {
	const pkt = new PACKET.CZ.REQ_WEAR_EQUIP();
	pkt.index = index;
	pkt.wearLocation = mask;
	Network.sendPacket(pkt);
}

function sendTakeOff(index) {
	const pkt = new PACKET.CZ.REQ_TAKEOFF_EQUIP();
	pkt.index = index;
	Network.sendPacket(pkt);
}

function place(bit, radius, angleDeg, size) {
	const el = slotEl(bit);
	if (!el) return;
	const angle = (angleDeg * Math.PI) / 180;
	const x = CENTER + radius * Math.cos(angle) - size / 2;
	const y = CENTER + radius * Math.sin(angle) - size / 2;
	el.style.left = x + 'px';
	el.style.top = y + 'px';
}

function placeSlots() {
	GLYPH_MAJOR.forEach((bit, i) => place(bit, MAJOR_RADIUS, -90 + i * 120, MAJOR_SIZE));
	GLYPH_MINOR.forEach((bit, i) => place(bit, MINOR_RADIUS, -90 + i * 72, MINOR_SIZE));
}

function updateCounts() {
	const root = Glyph.getRoot();
	if (!root) return;
	let major = 0;
	let minor = 0;
	GLYPH_MAJOR.forEach(bit => {
		if (_slots.has(bit)) major++;
	});
	GLYPH_MINOR.forEach(bit => {
		if (_slots.has(bit)) minor++;
	});
	const mEl = root.querySelector('#Glyph .major-count');
	const nEl = root.querySelector('#Glyph .minor-count');
	if (mEl) mEl.textContent = major;
	if (nEl) nEl.textContent = minor;
}

function renderSlots() {
	if (!Glyph.__loaded) return;
	GLYPH_BITS.forEach(bit => {
		const el = slotEl(bit);
		if (!el) return;
		const entry = _slots.get(bit);
		el.classList.toggle('filled', !!entry);
		el.dataset.index = entry ? entry.index : '';
		el.style.backgroundImage = '';
		if (entry) {
			const info = DB.getItemInfo(entry.ITID);
			el.title = info.identifiedDisplayName || 'Item ' + entry.ITID;
			Client.loadFile(DB.INTERFACE_PATH + 'item/' + info.identifiedResourceName + '.bmp', dataURI => {
				if (el.isConnected) el.style.backgroundImage = 'url(' + dataURI + ')';
			});
		} else {
			el.title = GLYPH_MAJOR.includes(bit) ? '大雕文（空）' : '小雕文（空）';
		}
	});
	updateCounts();
}

function toggleItemInfo(bit) {
	const entry = _slots.get(bit);
	if (!entry) return;
	if (ItemInfo.uid === entry.ITID) {
		ItemInfo.remove();
		return;
	}
	ItemInfo.append();
	ItemInfo.uid = entry.ITID;
	ItemInfo.setItem(entry.item || { ITID: entry.ITID, IsIdentified: true });
}

function hideItemInfo() {
	ItemInfo.remove();
}

Glyph.init = function init() {
	const root = this.getRoot();
	const slots = root.querySelectorAll('#Glyph .slot');

	GLYPH_BITS.forEach((bit, i) => {
		if (slots[i]) slots[i].dataset.bit = bit;
	});

	placeSlots();

	slots.forEach(el => {
		const bit = parseInt(el.dataset.bit, 10) || 0;
		const ringMask = el.dataset.ring === 'minor' ? GLYPH_MINOR_MASK : GLYPH_MAJOR_MASK;

		el.addEventListener('click', () => {
			const index = parseInt(el.dataset.index, 10);
			if (!isNaN(index)) sendTakeOff(index);
		});

		el.addEventListener('contextmenu', e => {
			e.preventDefault();
			e.stopImmediatePropagation();
			toggleItemInfo(bit);
		});

		el.addEventListener('dragover', e => {
			e.preventDefault();
			el.classList.add('dragover');
		});
		el.addEventListener('dragleave', () => el.classList.remove('dragover'));
		el.addEventListener('drop', e => {
			e.preventDefault();
			el.classList.remove('dragover');

			let payload;
			try {
				payload = JSON.parse(e.dataTransfer.getData('Text'));
			} catch (_e) {
				return;
			}
			if (!payload || payload.type !== 'item' || !payload.data) return;

			const item = payload.data;
			if (!(item.location & ringMask)) return; // wrong ring
			if (Glyph.isEquipped(item.ITID)) {
				ChatBox.addText(DB.getMessage(372), ChatBox.TYPE.ERROR, ChatBox.FILTER.ITEM);
				return;
			}
			sendEquip(item.index, ringMask);
		});
	});

	this.draggable('.titlebar');

	const closeBtn = root.querySelector('.close');
	if (closeBtn) {
		closeBtn.addEventListener('mousedown', e => e.stopImmediatePropagation());
		closeBtn.addEventListener('click', () => this.remove());
	}
};

Glyph.toggle = function toggle() {
	if (this._host && this._host.parentNode) {
		this.remove();
	} else {
		this.append();
	}
};

Glyph.onAppend = function onAppend() {
	if (this._host) {
		this._host.style.top = '120px';
		this._host.style.left = '400px';
	}
	placeSlots();
	renderSlots();
};

Glyph.onRemove = function onRemove() {
	hideItemInfo();
};

Glyph.onKeyDown = function onKeyDown(event) {
	if (event.which === 27) {
		this.remove();
		return false;
	}
	return true;
};

/**
 * Upsert the slot state from an inventory/equipment list.
 * Equipped glyphs (WearState has a glyph bit) fill their slot; other items
 * remove any slot previously held at that inventory index.
 * @param {Array} items
 */
Glyph.setList = function setList(items) {
	if (Array.isArray(items)) {
		for (const item of items) {
			const bit = pickBit((item.WearState || 0) & GLYPH_MASK);
			if (bit) {
				_slots.set(bit, { index: item.index, ITID: item.ITID, item });
			} else {
				for (const [b, entry] of Array.from(_slots.entries())) {
					if (entry.index === item.index) _slots.delete(b);
				}
			}
		}
	}
	renderSlots();
};

/**
 * Register a newly equipped glyph.
 * @param {object} item
 * @param {number} location
 */
Glyph.equip = function equip(item, location) {
	if (!item) return;
	const mask = ((location || 0) & GLYPH_MASK) || ((item.location || 0) & GLYPH_MASK);
	const bit = pickBit(mask);
	if (bit) _slots.set(bit, { index: item.index, ITID: item.ITID, item });
	renderSlots();
};

/**
 * Remove a glyph by inventory index.
 * @param {number} index
 */
Glyph.unEquip = function unEquip(index) {
	for (const [bit, entry] of Array.from(_slots.entries())) {
		if (entry.index === index) _slots.delete(bit);
	}
	renderSlots();
};

/**
 * Whether the given location bitmask targets a glyph slot.
 * @param {number} location
 * @returns {boolean}
 */
Glyph.isGlyphLocation = function isGlyphLocation(location) {
	return !!((location || 0) & GLYPH_MASK);
};

/**
 * Whether a glyph item with the given item id is already equipped.
 * @param {number} ITID
 * @returns {boolean}
 */
Glyph.isEquipped = function isEquipped(ITID) {
	for (const entry of _slots.values()) {
		if (entry.ITID === ITID) return true;
	}
	return false;
};

export default UIManager.addComponent(Glyph);
