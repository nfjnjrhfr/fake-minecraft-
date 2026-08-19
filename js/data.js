/* ============================================================
   開玉 — 資料層
   場口、設備、消耗品、玉石品質表、工人名冊
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 玉石品質表 ---------- */

  // 種（質地）：越後面越老、越透
  const ZHONG = [
    { id: 'zhuan', name: '磚頭料', base: 40, desc: '不透、粗粒，基本沒水頭' },
    { id: 'dou', name: '豆種', base: 320, desc: '顆粒明顯，水頭短' },
    { id: 'nuo', name: '糯種', base: 1400, desc: '像糯米湯，半透' },
    { id: 'nuobing', name: '糯冰種', base: 4200, desc: '糯中帶冰，通透度不錯' },
    { id: 'bing', name: '冰種', base: 16000, desc: '冰塊感，起膠' },
    { id: 'gaobing', name: '高冰種', base: 48000, desc: '接近玻璃，剛性強' },
    { id: 'boli', name: '玻璃種', base: 130000, desc: '透明起熒，極品質地' }
  ];

  // 色
  const COLOR = [
    { id: 'wuse', name: '無色白', mult: 1.0 },
    { id: 'piaohua', name: '飄花', mult: 1.35 },
    { id: 'doulv', name: '豆綠', mult: 1.2 },
    { id: 'danlv', name: '淡綠', mult: 1.45 },
    { id: 'qingshui', name: '晴水', mult: 1.9 },
    { id: 'lanshui', name: '藍水', mult: 1.7 },
    { id: 'huangfei', name: '黃翡', mult: 1.55 },
    { id: 'hongfei', name: '紅翡', mult: 2.1 },
    { id: 'mocui', name: '墨翠', mult: 1.8 },
    { id: 'ziluolan', name: '紫羅蘭', mult: 2.4 },
    { id: 'yanglv', name: '陽綠', mult: 3.6 },
    { id: 'zhengyang', name: '正陽綠', mult: 6.2 },
    { id: 'diwang', name: '帝王綠', mult: 15.0 }
  ];

  // 皮殼（原石外皮）— 給玩家的線索
  const SKIN = [
    { id: 'heiwu', name: '黑烏砂', hint: '皮下常出高綠，但也常滿裂' },
    { id: 'huangyan', name: '黃鹽砂', hint: '砂發翻得起，種水通常不差' },
    { id: 'baiyan', name: '白鹽砂', hint: '皮薄肉細，出冰的機會高' },
    { id: 'hongwu', name: '紅霧皮', hint: '霧色重，肉容易偏黃' },
    { id: 'tiehei', name: '鐵鏽皮', hint: '皮厚難看漲，賭性大' },
    { id: 'huangla', name: '黃臘皮', hint: '常帶糯化，穩但難出高貨' }
  ];

  /* ---------- 場口（礦區） ---------- */
  // zhongBias / colorBias：正值把該場口的出貨往好料推
  const SITES = [
    {
      id: 'huika', name: '會卡', alt: 480, fee: 4000,
      road: 3, danger: 0.10, water: 0.15, hardness: 0.8,
      zhongBias: -0.15, colorBias: -0.10, crackBias: 0.05, density: 0.16, sizeMul: 1.15,
      skins: ['huangla', 'hongwu', 'tiehei'],
      desc: '入門場口，皮厚肉粗，量大但價低。新隊伍練手的地方。'
    },
    {
      id: 'damakan', name: '大馬坎', alt: 620, fee: 12000,
      road: 3, danger: 0.14, water: 0.30, hardness: 1.0,
      zhongBias: 0.0, colorBias: 0.05, crackBias: 0.0, density: 0.14, sizeMul: 0.95,
      skins: ['hongwu', 'huangyan', 'huangla'],
      desc: '黃霧紅霧出名，容易出黃翡紅翡。水坑多，記得帶抽水機。'
    },
    {
      id: 'muna', name: '木那', alt: 900, fee: 60000,
      road: 2, danger: 0.22, water: 0.20, hardness: 1.25,
      zhongBias: 0.12, colorBias: 0.10, crackBias: -0.05, density: 0.12, sizeMul: 1.05,
      skins: ['baiyan', 'huangyan', 'heiwu'],
      desc: '種老色陽、點狀棉是招牌。山路難行，圍岩偏硬。'
    },
    {
      id: 'moxisha', name: '莫西沙', alt: 1050, fee: 130000,
      road: 2, danger: 0.26, water: 0.35, hardness: 1.45,
      zhongBias: 0.26, colorBias: -0.05, crackBias: -0.02, density: 0.10, sizeMul: 0.8,
      skins: ['baiyan', 'huangyan'],
      desc: '出高透明度的第一場口。塊頭小、圍岩極硬，切漲一刀吃三年。'
    },
    {
      id: 'houjiang', name: '後江', alt: 780, fee: 70000,
      road: 2, danger: 0.20, water: 0.45, hardness: 1.1,
      zhongBias: 0.14, colorBias: 0.22, crackBias: 0.10, density: 0.11, sizeMul: 0.55,
      skins: ['heiwu', 'baiyan'],
      desc: '小塊高色，河床料。水位高，沒抽水機下不了坑。'
    },
    {
      id: 'hpakant', name: '帕敢老坑', alt: 1260, fee: 260000,
      road: 1, danger: 0.38, water: 0.40, hardness: 1.6,
      zhongBias: 0.20, colorBias: 0.16, crackBias: 0.04, density: 0.09, sizeMul: 1.35,
      skins: ['heiwu', 'tiehei', 'baiyan'],
      desc: '老坑之王，大料高綠都從這出。坑深、塌方多、礦權貴，賭的是命也是錢。'
    }
  ];

  /* ---------- 設備 ---------- */
  // cat: dig 採掘 / support 支援 / safety 安全 / transport 運輸 / shop 工房 / camp 營地
  const EQUIP = {
    /* --- 採掘工具：礦場工具列 --- */
    shovel: {
      name: '鐵鏟', cat: 'dig', price: 900, dur: 200, icon: '⛏',
      desc: '清表土用。挖土快，敲石頭幾乎沒用。',
      tool: { pattern: 'single', power: 16, soft: 2.2, stam: 3, wear: 1, crack: 0.10, needs: [] }
    },
    pickaxe: {
      name: '十字鎬', cat: 'dig', price: 1800, dur: 260, icon: '⛏',
      desc: '萬用手工具，土石通吃，效率普通。',
      tool: { pattern: 'single', power: 24, soft: 1.2, stam: 5, wear: 1, crack: 0.25, needs: [] }
    },
    sledge: {
      name: '大鐵鎚', cat: 'dig', price: 2600, dur: 240, icon: '🔨',
      desc: '直上直下三格，破圍岩猛，但砸到玉必裂。',
      tool: { pattern: 'vert3', power: 38, soft: 0.9, stam: 9, wear: 2, crack: 0.55, needs: [] }
    },
    chisel: {
      name: '鑿子＋手鎚', cat: 'dig', price: 1500, dur: 300, icon: '🪛',
      desc: '取料神器。慢，但幾乎不傷玉肉，出料乾淨。',
      tool: { pattern: 'single', power: 13, soft: 1.0, stam: 4, wear: 1, crack: 0.0, needs: [] }
    },
    prybar: {
      name: '撬棍', cat: 'dig', price: 1200, dur: 320, icon: '🩻',
      desc: '沿縫撬，橫向三格鬆動圍岩，傷玉極低。',
      tool: { pattern: 'horz3', power: 18, soft: 1.1, stam: 6, wear: 1, crack: 0.05, needs: [] }
    },
    jackhammer: {
      name: '風鎬', cat: 'dig', price: 42000, dur: 400, icon: '🛠',
      desc: '效率翻倍。需要空壓機供風、吃柴油，震裂風險高。',
      tool: { pattern: 'cross', power: 46, soft: 1.0, stam: 8, wear: 3, crack: 0.50, fuel: { diesel: 3 }, needs: ['compressor'] }
    },
    excavator: {
      name: '挖土機', cat: 'dig', price: 380000, dur: 900, icon: '🚜',
      desc: '一斗掃 3×3，剝離表土無敵。需機械師操作，對玉肉極不友善。',
      tool: { pattern: 'box3', power: 58, soft: 1.6, stam: 8, wear: 5, crack: 0.72, fuel: { diesel: 9 }, skill: { mech: 3 }, needs: [] }
    },
    dynamite_kit: {
      name: '爆破器材組', cat: 'dig', price: 26000, dur: 500, icon: '💥',
      desc: '裝藥起爆，半徑兩格全開。需要爆破手與炸藥，塌方與傷亡風險最高。',
      tool: { pattern: 'blast', power: 130, soft: 1.3, stam: 16, wear: 6, crack: 0.85, use: { dynamite: 2 }, skill: { blast: 3 }, danger: 0.35, needs: [] }
    },

    /* --- 支援設備 --- */
    headlamp: { name: '頭燈', cat: 'support', price: 700, dur: 150, icon: '🔦', desc: '照明半徑 +1。吃電池，坑道作業必備。', light: 1, upkeep: { battery: 1 } },
    floodlight: { name: '探照燈', cat: 'support', price: 9000, dur: 300, icon: '💡', desc: '照明半徑 +3。要發電機供電。', light: 3, needs: ['generator'], upkeep: { diesel: 2 } },
    generator: { name: '柴油發電機', cat: 'support', price: 55000, dur: 600, icon: '🔌', desc: '供電給探照燈、切石機在山上運作。' },
    compressor: { name: '空壓機', cat: 'support', price: 68000, dur: 600, icon: '🌀', desc: '供風給風鎬。沒它風鎬只是廢鐵。' },
    pump: { name: '抽水機', cat: 'support', price: 32000, dur: 450, icon: '💧', desc: '排掉坑底積水，才挖得動水線以下。每回合吃柴油。', upkeep: { diesel: 3 } },
    timber: { name: '坑木支撐架', cat: 'support', price: 4500, dur: 999, icon: '🪵', desc: '在礦場架設支撐，大幅降低塌方風險。用一次消耗一組坑木。' },

    /* --- 安全裝備 --- */
    helmet: { name: '安全帽', cat: 'safety', price: 600, dur: 400, icon: '⛑', desc: '落石傷害 -35%。一人一頂才有效。', safety: 0.35 },
    rope: { name: '安全繩組', cat: 'safety', price: 2200, dur: 350, icon: '🪢', desc: '陡坡與坑壁作業墜落率 -40%。', safety: 0.40 },
    harness: { name: '全身吊帶', cat: 'safety', price: 5200, dur: 400, icon: '🦺', desc: '深坑救援可行，重傷轉輕傷機率 +30%。', safety: 0.30 },
    firstaid: { name: '急救箱', cat: 'safety', price: 3000, dur: 200, icon: '🧰', desc: '現場止血，受傷天數 -1，需消耗藥品。', safety: 0.2 },

    /* --- 運輸（決定每天扛得下山的公斤數） --- */
    basket: { name: '背簍', cat: 'transport', price: 300, dur: 200, icon: '🧺', desc: '人力背，載重 25kg。', carry: 25 },
    cart: { name: '手推車', cat: 'transport', price: 3500, dur: 300, icon: '🛒', desc: '載重 90kg，路況 2 以上才推得動。', carry: 90, road: 2 },
    mule: { name: '騾隊', cat: 'transport', price: 28000, dur: 999, icon: '🐴', desc: '載重 260kg，爛路照走，每天吃糧食。', carry: 260, road: 1, upkeep: { food: 2 } },
    pickup: { name: '小貨卡', cat: 'transport', price: 180000, dur: 800, icon: '🛻', desc: '載重 900kg，需要路況 2 以上。', carry: 900, road: 2, upkeep: { diesel: 12 } },
    truck: { name: '十輪大卡', cat: 'transport', price: 520000, dur: 1000, icon: '🚚', desc: '載重 3500kg，只走得了好路（路況 3）。', carry: 3500, road: 3, upkeep: { diesel: 30 } },

    /* --- 工房（相玉與加工） --- */
    flashlight: { name: '強光手電筒', cat: 'shop', price: 1200, dur: 300, icon: '🔦', desc: '打燈看種水。揭示【種】。', upkeep: { battery: 1 } },
    loupe: { name: '十倍放大鏡', cat: 'shop', price: 900, dur: 999, icon: '🔍', desc: '看裂看棉。揭示【裂】與【棉】。' },
    grinder: { name: '手持磨機', cat: 'shop', price: 7800, dur: 350, icon: '🪚', desc: '擦皮開窗。揭示【色】，開得漂亮還能抬價。消耗砂輪片。' },
    saw: { name: '切石機', cat: 'shop', price: 96000, dur: 500, icon: '🪓', desc: '一刀切開，全部揭曉。漲或垮，就這一刀。消耗切割片。' },
    polisher: { name: '拋光機', cat: 'shop', price: 34000, dur: 400, icon: '✨', desc: '把明料拋成成品，售價 +30%。消耗砂輪片。' },
    scale: { name: '電子秤＋卡尺', cat: 'shop', price: 2500, dur: 999, icon: '⚖️', desc: '精準過磅，玉商殺價空間 -8%。' },

    /* --- 營地 --- */
    tent: { name: '工寮帳篷', cat: 'camp', price: 8000, dur: 400, icon: '⛺', desc: '山上過夜不掉士氣，每天回復體力 +10。' },
    stove: { name: '爐具炊事組', cat: 'camp', price: 4200, dur: 400, icon: '🍲', desc: '熱食，士氣每天 +3，糧食消耗 -20%。' },
    radio: { name: '無線電', cat: 'camp', price: 6500, dur: 500, icon: '📻', desc: '意外時能叫支援，事故死亡率大幅下降。' },
    shotgun: { name: '土製獵槍', cat: 'camp', price: 18000, dur: 300, icon: '🔫', desc: '坑裡對天鳴槍威嚇（X 鍵），累癱的工人也會爬起來繼續挖。代價：全隊士氣重挫、名聲敗壞，被逼急的人會抓料往洞口逃。準星瞄到逃跑者再按 X 就是擊斃 — 料拿得回來，但命案的代價你要扛得起。' }
  };

  /* ---------- 消耗品 ---------- */
  const SUPPLY = {
    diesel: { name: '柴油', unit: '公升', price: 55, icon: '🛢' },
    battery: { name: '電池', unit: '組', price: 55, icon: '🔋' },
    grindwheel: { name: '砂輪片', unit: '片', price: 180, icon: '⭕' },
    blade: { name: '切割片', unit: '片', price: 520, icon: '🌀' },
    dynamite: { name: '炸藥', unit: '條', price: 1400, icon: '🧨' },
    wood: { name: '坑木', unit: '組', price: 600, icon: '🪵' },
    food: { name: '糧食', unit: '份', price: 130, icon: '🍚' },
    medicine: { name: '藥品', unit: '份', price: 850, icon: '💊' }
  };

  /* ---------- 工人 ---------- */
  const NAMES = [
    '阿吉', '老周', '岩溫', '召南', '波敏', '吳丹', '刀勇', '大牛', '阿罕', '小普',
    '賽龍', '玉旺', '阿吞', '老柯', '巖甩', '溫敏', '阿貴', '三炮', '德昌', '阿宰'
  ];

  const ROLES = {
    miner: { name: '礦工', key: 'mine', desc: '挖得快、耐操，手工具效率 +' },
    blaster: { name: '爆破手', key: 'blast', desc: '能操作爆破器材，炸得準、意外少' },
    mech: { name: '機械師', key: 'mech', desc: '能開挖土機，機具耐久消耗 -30%' },
    eye: { name: '相玉師', key: 'eye', desc: '不下坑，但估價誤差小、開窗切石成功率高' },
    porter: { name: '背工', key: 'porter', desc: '不採礦，載重 +40kg／人' }
  };

  const WEATHER = [
    { id: 'sunny', name: '晴', icon: '☀️', work: 1.0, danger: 1.0, desc: '好天氣，正常出工。' },
    { id: 'cloudy', name: '陰', icon: '☁️', work: 0.98, danger: 1.0, desc: '悶熱，但不影響作業。' },
    { id: 'rain', name: '雨', icon: '🌧', work: 0.82, danger: 1.4, desc: '路滑水漲，坑底出水變快。' },
    { id: 'storm', name: '暴雨', icon: '⛈', work: 0.55, danger: 2.2, desc: '土石鬆動，塌方風險暴增。' },
    { id: 'fog', name: '濃霧', icon: '🌫', work: 0.9, danger: 1.25, desc: '視線差，照明範圍 -1。' }
  ];

  global.DATA = { ZHONG, COLOR, SKIN, SITES, EQUIP, SUPPLY, NAMES, ROLES, WEATHER };
})(window);
