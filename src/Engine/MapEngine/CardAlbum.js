/**
 * Engine/MapEngine/CardAlbum.js
 *
 * Card collection album packets: request list / submit / activate /
 * deactivate, apply server answers to the CardBook UI.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import Network from 'Network/NetworkManager.js';
import PACKET from 'Network/PacketStructure.js';
import CardBook from 'UI/Components/CardBook/CardBook.js';
import ChatBox from 'UI/Components/ChatBox/ChatBox.js';

const RESULT_TEXT = {
	1: 'CardBook: invalid request.',
	2: 'CardBook: that item is not a card.',
	3: 'CardBook: that card has no usable effect.',
	4: 'CardBook: card is not in your collection.',
	5: 'CardBook: database error, try again.',
	6: 'CardBook: category full, replaced the earliest card.'
};

function onCardAlbumList(pkt) {
	CardBook.setUnlocked(pkt.cardIds || [], pkt.activeIds || [], pkt.catalogIds || [], pkt.catalogCats || []);
}

function onCardAlbumAck(pkt) {
	if (pkt.result !== 0) {
		const msg = RESULT_TEXT[pkt.result] || `CardBook: error ${pkt.result}.`;
		try {
			ChatBox.addText(msg, ChatBox.TYPE.INFO, ChatBox.FILTER.PUBLIC_LOG);
		} catch (_e) {
			// ignore
		}
	}
}

function reqCardAlbumList() {
	Network.sendPacket(new PACKET.CZ.CARD_ALBUM_LIST_REQ());
}

function reqCardAlbumSubmit(index) {
	const pkt = new PACKET.CZ.CARD_ALBUM_SUBMIT();
	pkt.index = index;
	Network.sendPacket(pkt);
}

function reqCardAlbumActivate(cardId) {
	const pkt = new PACKET.CZ.CARD_ALBUM_ACTIVATE();
	pkt.cardId = cardId;
	Network.sendPacket(pkt);
}

function reqCardAlbumDeactivate(cardId) {
	const pkt = new PACKET.CZ.CARD_ALBUM_DEACTIVATE();
	pkt.cardId = cardId;
	Network.sendPacket(pkt);
}

function hasPacket(ns, name) {
	return !!(PACKET[ns] && PACKET[ns][name]);
}

/**
 * Initialize
 */
export default function CardAlbumEngine() {
	// Custom server packets: only hook when the packet structures exist,
	// otherwise MapEngine.init would abort and break all later UI setup.
	if (hasPacket('ZC', 'CARD_ALBUM_LIST')) {
		Network.hookPacket(PACKET.ZC.CARD_ALBUM_LIST, onCardAlbumList);
	}
	if (hasPacket('ZC', 'CARD_ALBUM_ACK')) {
		Network.hookPacket(PACKET.ZC.CARD_ALBUM_ACK, onCardAlbumAck);
	}
}

export { reqCardAlbumList, reqCardAlbumSubmit, reqCardAlbumActivate, reqCardAlbumDeactivate };
