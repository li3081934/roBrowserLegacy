/**
 * DB/Teleport/Destinations.js
 *
 * Static teleport destination table for the convenience teleport window.
 *
 * Cities mirror the server's `@go` table (src/map/atcommand.cpp) so the
 * coordinates land exactly where the official command does. Field maps use
 * x = y = 0, which makes the server pick a random walkable cell, so entries
 * keep working after map edits without hand-tuning coordinates.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

/**
 * @typedef {object} TeleportDestination
 * @property {string} name  - display name
 * @property {string} map   - map file name (without extension)
 * @property {number} x     - cell x (0 = let the server pick)
 * @property {number} y     - cell y (0 = let the server pick)
 * @property {string} [level] - level hint, fields only
 */

/** @type {TeleportDestination[]} */
const cities = [
	{ name: '普隆德拉', map: 'prontera', x: 156, y: 191 },
	{ name: '梦罗克', map: 'morocc', x: 156, y: 93 },
	{ name: '吉芬', map: 'geffen', x: 119, y: 59 },
	{ name: '斐扬', map: 'payon', x: 162, y: 233 },
	{ name: '阿尔贝塔', map: 'alberta', x: 192, y: 147 },
	{ name: '依斯鲁得', map: 'izlude', x: 128, y: 146 },
	{ name: '艾尔帕兰', map: 'aldebaran', x: 140, y: 131 },
	{ name: '圣诞村', map: 'lutie', x: 147, y: 134 },
	{ name: '科莫多', map: 'comodo', x: 209, y: 143 },
	{ name: '朱诺', map: 'yuno', x: 157, y: 51 },
	{ name: '天津', map: 'amatsu', x: 198, y: 84 },
	{ name: '昆仑', map: 'gonryun', x: 160, y: 120 },
	{ name: '乌巴拉', map: 'umbala', x: 89, y: 157 },
	{ name: '尼芙菲姆', map: 'niflheim', x: 21, y: 153 },
	{ name: '洛阳', map: 'louyang', x: 217, y: 40 },
	{ name: '新手训练场', map: 'new_1-1', x: 53, y: 111 },
	{ name: '监狱', map: 'jail', x: 23, y: 61 },
	{ name: '爪哇岛', map: 'jawaii', x: 249, y: 127 },
	{ name: '阿育塔雅', map: 'ayothaya', x: 151, y: 117 },
	{ name: '恩布罗克', map: 'einbroch', x: 64, y: 200 },
	{ name: '里希塔乐镇', map: 'lighthalzen', x: 158, y: 92 },
	{ name: '恩贝奇', map: 'einbech', x: 70, y: 95 },
	{ name: '修黑尔', map: 'hugel', x: 96, y: 145 },
	{ name: '拉赫', map: 'rachel', x: 130, y: 110 },
	{ name: '维因斯', map: 'veins', x: 216, y: 123 },
	{ name: '莫斯科', map: 'moscovia', x: 223, y: 184 },
	{ name: '米德加尔特营地', map: 'mid_camp', x: 180, y: 240 },
	{ name: '马努克', map: 'manuk', x: 282, y: 138 },
	{ name: '斯普兰迪', map: 'splendide', x: 201, y: 147 },
	{ name: '巴西利斯', map: 'brasilis', x: 182, y: 239 },
	{ name: '埃尔迪卡斯', map: 'dicastes01', x: 198, y: 187 },
	{ name: '莫拉', map: 'mora', x: 44, y: 151 },
	{ name: '德瓦塔', map: 'dewata', x: 200, y: 180 },
	{ name: '马兰多', map: 'malangdo', x: 140, y: 114 },
	{ name: '马来港', map: 'malaya', x: 242, y: 211 },
	{ name: '埃克拉格', map: 'eclage', x: 110, y: 39 },
	{ name: '拉丝格纳', map: 'lasagna', x: 193, y: 182 }
];

/** @type {TeleportDestination[]} */
const fields = [
	{ name: '普隆德拉南·波利', map: 'prt_fild08', x: 0, y: 0, level: 'Lv 1-10' },
	{ name: '普隆德拉平原', map: 'prt_fild05', x: 0, y: 0, level: 'Lv 8-15' },
	{ name: '吉芬外野·蘑菇', map: 'gef_fild04', x: 0, y: 0, level: 'Lv 15-25' },
	{ name: '吉芬外野·松鼠', map: 'gef_fild07', x: 0, y: 0, level: 'Lv 25-40' },
	{ name: '斐扬外野', map: 'pay_fild04', x: 0, y: 0, level: 'Lv 20-30' },
	{ name: '斐扬洞穴口', map: 'pay_fild08', x: 0, y: 0, level: 'Lv 28-38' },
	{ name: '梦罗克沙原·摩卡', map: 'moc_fild17', x: 0, y: 0, level: 'Lv 25-35' },
	{ name: '梦罗克沙原·甲虫', map: 'moc_fild12', x: 0, y: 0, level: 'Lv 30-40' },
	{ name: '妙勒尼山脉·大嘴鸟', map: 'mjolnir_04', x: 0, y: 0, level: 'Lv 30-45' },
	{ name: '妙勒尼山脉·深处', map: 'mjolnir_02', x: 0, y: 0, level: 'Lv 35-50' },
	{ name: '科莫多外野·海滩', map: 'cmd_fild01', x: 0, y: 0, level: 'Lv 35-45' },
	{ name: '科莫多外野·湿地', map: 'cmd_fild02', x: 0, y: 0, level: 'Lv 38-48' },
	{ name: '朱诺草原·飞龙', map: 'yuno_fild03', x: 0, y: 0, level: 'Lv 40-50' },
	{ name: '恩布罗克外野', map: 'ein_fild06', x: 0, y: 0, level: 'Lv 45-55' },
	{ name: '里希塔乐外野', map: 'lhz_fild01', x: 0, y: 0, level: 'Lv 50-60' },
	{ name: '拉赫沙漠', map: 'ra_fild01', x: 0, y: 0, level: 'Lv 55-65' },
	{ name: '马努克外野', map: 'man_fild01', x: 0, y: 0, level: 'Lv 60-70' },
	{ name: '斯普兰迪外野', map: 'spl_fild01', x: 0, y: 0, level: 'Lv 65-75' },
	{ name: '埃尔迪卡斯外野', map: 'dic_fild01', x: 0, y: 0, level: 'Lv 70-80' },
	{ name: '莫斯科外野', map: 'mosk_fild01', x: 0, y: 0, level: 'Lv 45-55' },
	{ name: '德瓦塔丛林', map: 'dew_fild01', x: 0, y: 0, level: 'Lv 60-75' }
];

export { cities, fields };
export default { cities, fields };
