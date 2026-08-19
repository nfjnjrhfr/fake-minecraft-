/*
 * 預設片單（對應離線緩存裡的四個合集）
 * ------------------------------------------------------------------
 * bvid  : B 站視頻號，例如 "BV1xx411c7mD"。留空則在介面上顯示「未綁定」，
 *         可以直接在網頁裡貼上連結綁定（存在瀏覽器本機）。
 * parts : 分 P 數量。沒有填 episodes 時會自動產生 P1 ~ P{parts}。
 * episodes : 想自訂每一集的標題（或一個合集由多個不同 BV 組成）時使用，
 *         格式 [{ title: "集合的基本概念", bvid: "BV...", p: 1 }, ...]
 * cover : 封面圖網址，留空會用標題自動生成漸層封面。
 */
window.DEFAULT_LIBRARY = {
  title: '數學通道',
  collections: [
    {
      id: 'tao-masterclass',
      title: '【大师课】[中英字幕]数学天才 陶哲轩 Terence Tao 不再恐惧数学 学会新思维',
      shortTitle: '陶哲轩 数学思维大师课',
      tag: '大师课',
      size: '354.2M',
      bvid: '',
      parts: 12,
      cover: '',
      episodes: []
    },
    {
      id: 'four-dimensional-eye',
      title: '数学 · 四维之眼',
      shortTitle: '四维之眼',
      tag: '科普',
      size: '409.9M',
      bvid: '',
      parts: 4,
      cover: '',
      episodes: []
    },
    {
      id: 'paramecium-calculus',
      title: '草履虫教学 · 草履虫都能听懂的微积分应用（生活中的微积分 — PID 算法）',
      shortTitle: '草履虫教学',
      tag: '微积分',
      size: '78.7M',
      bvid: '',
      parts: 3,
      cover: '',
      episodes: []
    },
    {
      id: 'jiashu-highschool',
      title: '【加数】高中一课通',
      shortTitle: '高中一课通',
      tag: '高中数学',
      size: '346.6M',
      bvid: '',
      parts: 31,
      cover: '',
      episodes: [
        { title: '集合的基本概念 1.0 —— 奇旅初体验', p: 1 }
      ]
    }
  ]
};
