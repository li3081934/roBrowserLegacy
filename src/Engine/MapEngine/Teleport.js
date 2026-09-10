/**
 * Engine/MapEngine/Teleport.js
 *
 * Convenience teleport transport. Sends the custom CZ_REQ_TELEPORT request
 * and forwards the server ack (ZC_ACK_TELEPORT) to the Teleport UI.
 *
 * Kept in one place so the transport can evolve (item cost / cooldown /
 * permission checks all live server-side) without touching the UI.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import Network from 'Network/NetworkManager.js';
import PACKET from 'Network/PacketStructure.js';
import Teleport from 'UI/Components/Teleport/Teleport.js';

function onAck(pkt) {
	try {
		if (Teleport && typeof Teleport.onAck === 'function') {
			Teleport.onAck(pkt.result, pkt.param);
		}
	} catch (_e) {
		// UI not ready; ignore.
	}
}

/**
 * Request a teleport to a map.
 *
 * @param {string} map - map file name (no extension)
 * @param {number} [x] - cell x (0 = server picks a random walkable cell)
 * @param {number} [y] - cell y
 * @param {{ legacy?: boolean }} [options] - legacy sends CZ_MOVETO_MAP (@mapmove)
 */
export function teleportTo(map, x = 0, y = 0, options = {}) {
	if (!map) {
		return;
	}

	if (options.legacy && PACKET.CZ.MOVETO_MAP) {
		const legacyPkt = new PACKET.CZ.MOVETO_MAP();
		legacyPkt.mapName = map;
		legacyPkt.xPos = x;
		legacyPkt.yPos = y;
		Network.sendPacket(legacyPkt);
		return;
	}

	if (PACKET.CZ.REQ_TELEPORT) {
		const pkt = new PACKET.CZ.REQ_TELEPORT();
		pkt.mapName = map;
		pkt.xPos = x;
		pkt.yPos = y;
		Network.sendPacket(pkt);
	}
}

/**
 * Initialize
 */
export default function TeleportEngine() {
	// Custom packet: only hook when the structure exists, otherwise
	// MapEngine.init would abort and break all later UI setup.
	if (PACKET.ZC.ACK_TELEPORT) {
		Network.hookPacket(PACKET.ZC.ACK_TELEPORT, onAck);
	}
}
