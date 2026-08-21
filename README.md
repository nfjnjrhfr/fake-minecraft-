# fake-minecraft-

`banlist`：給**自己的伺服器**用的封鎖名單管理工具。

只做一件事：管理你自己伺服器上的玩家／IP 封鎖名單（誰被封、為什麼、封到什麼時候），
資料存在你自己機器上的一個 JSON 檔。它**不會**去攻擊、干擾或封鎖別人的網路、
別人的裝置或第三方服務——那些才是違法的，這個工具不做。
純 Python 3 標準函式庫，沒有任何外部相依。

## 安裝

不用安裝，clone 下來就能用：

```bash
python3 -m banlist --help
```

想要有 `banlist` 指令的話：

```bash
pip install -e .
```

## 快速上手

```bash
# 封鎖玩家 7 天
python3 -m banlist ban Griefer123 -r "破壞出生點" --for 7d

# 封鎖一整段 IP（支援 CIDR），2 小時
python3 -m banlist ban 203.0.113.0/24 -r "代理洗頻" --for 2h

# 永久封鎖（不加 --for 就是永久）
python3 -m banlist ban Cheater -r "外掛" --uuid 069a79f4-44e9-4726-a5be-fca90e38aaf5

# 看名單
python3 -m banlist list

# 查某個人／某個 IP 有沒有被封（有被封 exit code = 1）
python3 -m banlist check 203.0.113.55

# 解除封鎖、清掉過期紀錄、看操作紀錄
python3 -m banlist unban Griefer123
python3 -m banlist purge
python3 -m banlist log -n 20
```

## 指令一覽

| 指令 | 說明 |
| --- | --- |
| `ban <對象>` | 新增／更新封鎖。`-r` 原因、`--for` 期限、`--until` 到期時間、`--by` 執行者、`--uuid` 玩家 UUID |
| `unban <對象>` | 解除封鎖；不在名單上時 exit code = 1 |
| `list` | 列出名單。`--state active\|expired\|all`、`--ip` / `--player`、`--json` |
| `check <對象>...` | 查詢是否被封鎖；**有命中時 exit code = 1**，方便寫進伺服器腳本 |
| `purge` | 刪掉已過期的紀錄 |
| `log` | 查看操作紀錄（誰在什麼時候封了誰） |
| `export` | 匯出 `--format json\|csv\|minecraft` |
| `import <檔案>` | 匯入，可直接吃 Minecraft 的 `banned-players.json` / `banned-ips.json` |

共用參數：`-f/--file` 指定名單檔（預設 `banlist.json`，也可用環境變數 `BANLIST_FILE`）。

## 幾個設計重點

- **玩家名稱不分大小寫**：`Steve`、`steve`、`STEVE` 視為同一人。
- **IP 支援 CIDR 網段**：封 `10.0.0.0/24` 之後，`check 10.0.0.99` 會命中。
- **期限寫法**：`45s`、`30m`、`2h`、`7d`、`1w`，也可以組合成 `1h30m`；不寫＝永久。
  到期後 `check` 就不會命中，實際紀錄留到你 `purge` 為止。
- **原子寫檔**：先寫暫存檔再 `os.replace`，中途被 Ctrl-C 也不會弄壞名單。
- **操作紀錄**：每次 ban / unban / purge / import 都會留下時間、執行者與原因（保留最近 1000 筆）。

## 跟 Minecraft 伺服器搭配

匯出成伺服器看得懂的格式，直接丟進伺服器資料夾：

```bash
python3 -m banlist export --format minecraft --out /path/to/server
# 會產生 banned-players.json 與 banned-ips.json
```

反向也可以，把現有伺服器名單接管過來：

```bash
python3 -m banlist import /path/to/server/banned-players.json --format minecraft
python3 -m banlist import /path/to/server/banned-ips.json --format minecraft
```

在腳本裡擋人的用法：

```bash
if ! python3 -m banlist check "$PLAYER" --quiet; then
    echo "此帳號已被封鎖"
    exit 1
fi
```

## 測試

```bash
python3 -m unittest discover -s tests -v
```

## 專案結構

```
banlist/
  duration.py   期限字串解析（7d、1h30m、forever）
  models.py     BanEntry：一筆封鎖紀錄、比對與到期判斷
  store.py      BanStore：JSON 儲存、查詢、操作紀錄
  formats.py    JSON / CSV / Minecraft 格式互轉
  cli.py        指令列介面
tests/
  test_banlist.py
```
