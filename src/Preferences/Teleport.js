/**
 * Preferences/Teleport.js
 *
 * Convenience teleport window preferences persisted in localStorage.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import Preferences from 'Core/Preferences.js';

export default Preferences.get(
	'Teleport',
	{
		x: 320,
		y: 120,
		// 'cities' | 'fields' | 'mine'
		tab: 'cities',
		// 'favorites' | 'recent' (sub-tag inside the "mine" tab)
		subtab: 'favorites',
		// [{ name, map, x, y, level? }]
		favorites: [],
		recent: []
	},
	1.0
);
