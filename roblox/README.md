# 方塊對戰 Roblox 版

網頁版的 Roblox 移植：同樣的方塊競技場、揮劍 / 雪球 / 放方塊三種手段、三戰兩勝的回合制，
差別是變成 3D、而且是**線上多人對戰**（同一個伺服器裡的玩家互相打）。

## 手機上怎麼操作？

**移動搖桿是 Roblox 內建的** —— 手機／平板進遊戲後左下角自動出現虛擬搖桿，右下角有跳躍鍵，
不需要任何額外設定，也不用外接鍵盤。

這份程式另外加了三顆動作按鈕（用 `ContextActionService` 產生，手機顯示成觸控按鈕、電腦則對應鍵盤）：

| 動作 | 手機 | 電腦 |
| --- | --- | --- |
| 移動 / 跳躍 | 內建虛擬搖桿 + 跳躍鍵 | `W A S D` + `空白鍵` |
| 揮劍 | 「劍」按鈕（可長按連續揮） | `F` |
| 丟雪球 | 「雪」按鈕（可長按連射） | `G` |
| 放方塊 | 「磚」按鈕 | `R` |

## 安裝方式 A：直接貼進 Roblox Studio（不用裝任何工具）

1. Studio 開一個新的 Baseplate 專案。
2. 在 `ReplicatedStorage` 新增一個 **ModuleScript**，命名為 `GameConfig`，
   貼上 `src/ReplicatedStorage/GameConfig.luau` 的內容。
3. 在 `ServerScriptService` 新增一個 **Script**（伺服器腳本），命名為 `BattleServer`，
   貼上 `src/ServerScriptService/BattleServer.server.luau` 的內容。
4. 在 `StarterPlayer > StarterPlayerScripts` 新增一個 **LocalScript**，命名為 `BattleClient`，
   貼上 `src/StarterPlayer/StarterPlayerScripts/BattleClient.client.luau` 的內容。
5. 按 **Play**。要測對戰請用 `Test > Clients and Servers > 2 Players`，
   或發佈後用手機開遊戲、找朋友一起進來。

> 名字要完全一樣（`GameConfig` / `BattleServer` / `BattleClient`），
> 而且腳本類型要對：ModuleScript、Script、LocalScript。

## 安裝方式 B：Rojo

```bash
rojo serve roblox/default.project.json
```

然後在 Studio 用 Rojo 外掛連線即可。

## 規則

- 每回合 90 秒，先贏 **3 回合** 者勝；有人陣亡或時間到（血多者勝）就結束該回合。
- 場地會在每回合重建，而且**左右完全對稱**（`GameConfig.buildArenaPlan()` 只生成 +X 半邊再鏡射）。
- **掉出場外**扣 35 點血並送回出生點；血扣光才算輸掉該回合。
- 揮劍 13 傷害並擊退；**沒打到人時會敲掉前方玩家放的方塊**（地形本身打不壞）。
- 雪球 10 傷害，有重力拋物線，雪球數量會自己慢慢回補。
- 方塊放在身前的格線上，25 秒後自動消失，數量也會慢慢回補。

## 為什麼伺服器腳本管這麼多

客戶端只負責送出「我按了劍／雪球／方塊」，**所有冷卻時間、剩餘數量、命中判定與傷害都在伺服器算**
（`BattleServer.server.luau`），所以外掛改客戶端也沒辦法連發或無限雪球。

## 測試

場地藍圖是純資料（不碰任何 Roblox API），所以可以離開 Studio 直接跑：

```bash
luau roblox/tests/arena_test.luau
```

會檢查：所有方塊都有鏡射對稱、沒有重複方塊、尺寸合法、出生點下方確實有地板、
中央與兩側之間確實留有掉落用的缺口。
