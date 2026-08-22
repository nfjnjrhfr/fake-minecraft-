# fake-minecraft-

一支純前端的「詭異 Minecraft」動畫：`index.html`，打開瀏覽器就會跑，零相依套件。

## 這是什麼

一個下著雨的方塊世界，血月掛在天上，遠處有一個東西會出現、盯著你、然後消失。
偶爾它會離你很近。

- **像素渲染** — 內部只有 320×180 的畫布，放大時關掉平滑處理，得到方塊感
- **三層視差地形** — 用 value noise 生成的方塊剪影，配上頂緣的一線微光
- **那個東西** — 出現 / 凝視 / 消失的狀態機，白色發光的雙眼；約 18% 的機率會貼臉出現，然後閃白消失
- **故障特效** — RGB 色差、水平撕裂、顆粒雜訊、掃描線、暈影
- **F3 風格 HUD** — 偶爾亂碼；`players` 會在它出現時變成 `2/1`
- **聲音** — Web Audio 即時合成：失諧低頻嗡鳴、帶通白噪風聲、心跳（它出現時會變急）
- **低語** — 隨機淡入的字句

## 使用

```bash
# 直接開檔即可
open index.html

# 或起一個本機伺服器
npx http-server . -p 8080
```

右下角可切換聲音與全螢幕。系統若設定了 `prefers-reduced-motion`，會自動關掉閃白與強故障。

## 原始 README

> u8ujujujujujujujujujuujuujujujujuujujujujujjujjujujujuujjunjerivcfv dnds xdfbdehbhebhbdehbhbhrhbehebhderbhrvrdfgvfrfrevefvfegfhdevegdervgedryegehwrwehgerhwhrbhdbhdbdhbedbdiuheiuhur4ury4yeeyurheu4u44uyy56t4rueyrjdhjddbhdjebbhjejbhdwehjhejrhjedhjdjdndejndjnsdsjndsjndsjkkd. 67
