/*
 * 預設片單（對應離線緩存裡的四個合集）
 * ------------------------------------------------------------------
 * 每一集的 BV 號、標題、長度都是從 B 站抓下來寫死的，開網頁就能直接播，
 * 不需要自己綁定。想改片單就直接改這個檔案：
 *
 * bvid  : 整個片單共用的視頻號（單一影片多分 P 時用）。
 * parts : 分 P / 集數。
 * episodes : 每一集。單一影片多分 P 用 { p, dur, title }；
 *            一個合集由多支影片組成時用 { bvid, dur, title }。
 * dur   : 影片長度（秒）。「連續播放」靠它倒數，抓不到就填 0（不自動跳下一集）。
 * cover : 封面圖網址，留空會依標題自動生成漸層封面。
 */
window.DEFAULT_LIBRARY = {
  title: '數學通道',
  collections: [
    {
      id: "tao-masterclass",
      title: "【大师课】[中英字幕]数学天才 陶哲轩 Terence Tao 不再恐惧数学 学会新思维",
      shortTitle: "陶哲轩 数学思维大师课",
      tag: "大师课",
      size: "354.2M",
      bvid: "BV1wa41187Wf",
      cover: "https://i0.hdslb.com/bfs/archive/26f29e2f4518563520023ca923643a84b0f0c87d.jpg",
      parts: 12,
      episodes: [
        { p: 1, dur: 252, title: "认识你的老师" },
        { p: 2, dur: 404, title: "陶哲轩的旅程" },
        { p: 3, dur: 465, title: "神秘的数学" },
        { p: 4, dur: 478, title: "数学在你的日常生活" },
        { p: 5, dur: 711, title: "选择要解决的问题" },
        { p: 6, dur: 575, title: "通过故事解决问题" },
        { p: 7, dur: 561, title: "转换的问题" },
        { p: 8, dur: 464, title: "游戏、作弊和谜题" },
        { p: 9, dur: 527, title: "数学与失败" },
        { p: 10, dur: 404, title: "困惑" },
        { p: 11, dur: 501, title: "从数字中寻找力量" },
        { p: 12, dur: 282, title: "勇往直前" }
      ]
    },
    {
      id: "four-dimensional-eye",
      title: "数学 · 四维之眼",
      shortTitle: "四维之眼",
      tag: "科普",
      size: "409.9M",
      bvid: "",
      cover: "",
      parts: 4,
      episodes: [

      ]
    },
    {
      id: "paramecium-calculus",
      title: "草履虫教学 · 草履虫都能听懂的微积分应用",
      shortTitle: "草履虫教学",
      tag: "微积分",
      size: "78.7M",
      bvid: "",
      cover: "https://archive.biliimg.com/bfs/archive/ae2f43ebc88bde69a29211ef4c58de81bb97ff25.jpg",
      parts: 3,
      episodes: [
        { bvid: "BV1RHVD6TE8y", dur: 644, title: "草履虫都能学会的微积分应用！——PID算法" },
        { bvid: "BV1aE9fBXE1R", dur: 1237, title: "我不允许有人14岁还不会微积分！！" },
        { bvid: "BV14Q5J6gEnW", dur: 836, title: "泰勒展开，到底要如何理解？" }
      ]
    },
    {
      id: "jiashu-highschool",
      title: "【加数】高中一课通",
      shortTitle: "高中一课通",
      tag: "高中数学",
      size: "346.6M",
      bvid: "",
      cover: "https://archive.biliimg.com/bfs/archive/51348f4f368a451d9080a90436d220bd4504d5eb.jpg",
      parts: 31,
      episodes: [
        { bvid: "BV1tW87zREjC", dur: 1022, title: "【加数】高中数学第一课：集合的基本概念" },
        { bvid: "BV1UG4fzYE55", dur: 529, title: "【加数】高中数学第二课！你需要掌握的逻辑用语" },
        { bvid: "BV1SNYDzoEy8", dur: 530, title: "【加数】高中数学第三课：基本不等式！" },
        { bvid: "BV1EheizqEse", dur: 752, title: "【加数】高中数学第三课：基本不等式！（2）" },
        { bvid: "BV1KKvPzbEtg", dur: 594, title: "基本不等式2.3" },
        { bvid: "BV17jamzfEKz", dur: 415, title: "【加数】高中数学第三课：基本不等式IV！" },
        { bvid: "BV1kRW3zmEJe", dur: 467, title: "基本不等式——(基础解题篇)" },
        { bvid: "BV1d2nGzwEg1", dur: 419, title: "【加数】基本不等式——进阶篇！" },
        { bvid: "BV1oAn2zbEeW", dur: 772, title: "【加数】高中数学第四课：初识函数！" },
        { bvid: "BV1oNxszjE99", dur: 555, title: "【加数】高中数学技能课：一元二次不等式！" },
        { bvid: "BV1sr4AzKEHC", dur: 618, title: "【加数】函数图像双基石——单调性 奇偶性" },
        { bvid: "BV1PXWpzSEs4", dur: 592, title: "【加数】高中数学第四课：函数值域求解！" },
        { bvid: "BV1Vv1KBXEtZ", dur: 493, title: "【加数】高中数学第四课：函数解析式的5种核心解法！" },
        { bvid: "BV1qW14BDEzf", dur: 601, title: "【加数】函数周期性——4种基本性质技能！" },
        { bvid: "BV1Xb2MBtEcJ", dur: 744, title: "【加数】幂函数  从零掌握核心内容！" },
        { bvid: "BV1xXCNBeE7H", dur: 624, title: "【加数】指数函数 从零掌握核心内容！" },
        { bvid: "BV1QnUjBXEgo", dur: 901, title: "【加数】对数函数 从零掌握基础运算！" },
        { bvid: "BV1RUSEBKE1Z", dur: 899, title: "【加数】对数函数 4种核心必考题型！" },
        { bvid: "BV1622LBFEv7", dur: 977, title: "【加数】三角函数 从零掌握基础核心！" },
        { bvid: "BV1fEmjBcESh", dur: 864, title: "【加数】三角函数 诱导公式记不住怎么办？" },
        { bvid: "BV1svqdB4EGB", dur: 1054, title: "【加数】三角函数 图像性质基础核心！" },
        { bvid: "BV18eBeBrELY", dur: 941, title: "【加数】三角恒等变换 4类核心题型！" },
        { bvid: "BV1WQr1B6EEZ", dur: 1536, title: "【加数】高一期末总复习！" },
        { bvid: "BV1mdFWzAEf8", dur: 1712, title: "【加数】平面向量——从0掌握！" },
        { bvid: "BV1ihcUzJEeJ", dur: 1067, title: "【加数】平面向量——5种核心题型！" },
        { bvid: "BV1i1DsBxELB", dur: 1283, title: "【加数】解三角形——从零掌握！" },
        { bvid: "BV1pY9eBTEBr", dur: 606, title: "【加数】复数——从零掌握！" },
        { bvid: "BV1nK7r6wE3H", dur: 992, title: "【加数】概率——从0掌握！" },
        { bvid: "BV1CxEz6YETr", dur: 613, title: "【加数】统计——从零掌握！" },
        { bvid: "BV1wouE6JETd", dur: 1196, title: "【加数】空间向量——从零掌握！" },
        { bvid: "BV1mJgH6NEH5", dur: 852, title: "【加数】基本不等式——从零掌握!" }
      ]
    }
  ]
};
