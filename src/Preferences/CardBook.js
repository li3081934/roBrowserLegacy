/**
 * Preferences/CardBook.js
 *
 * Card collection album preferences persisted in localStorage.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import Preferences from 'Core/Preferences.js';

export default Preferences.get(
	'CardBook',
	{
		x: 100,
		y: 100,
		showAll: false,
		cat: 0,
		unlocked: [],
		activeIds: []
	},
	1.0
);
