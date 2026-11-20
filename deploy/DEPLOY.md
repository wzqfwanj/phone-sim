# 部署手册 —— 安卓手机模拟器（phone-sim）

本应用是**零第三方依赖**的 Python 标准库 HTTP 服务：应用机用 systemd 常驻，网关机用 Caddy
把 `https://wkeeli.cn/phone/` 经 `handle_path` 反向代理到应用机 `8140` 端口。本文所有命令都可直接复制执行。

## 拓扑与事实基线

```
浏览器 ──https──> 网关机 aliyun 8.133.209.25（Caddy，站点 https://wkeeli.cn）
                        │  handle_path /phone/*（剥掉 /phone 前缀）
                        └──http──> 应用机 dev 180.76.180.249:8140（systemd 服务 phone-sim）

本地部署机（Windows Git Bash）──git archive 打包 + scp──> 应用机 /opt/phone-sim（普通目录，非 git 仓库）
```

> 重要：应用机**无法访问 GitHub**（实测直连与代理均失败），因此不使用 `git clone` / `git pull`。
> 代码统一由部署机打包上传；应用机不需要安装 git，也不需要访问 GitHub。以下所有「同步代码」都指这条链路。

| 项目 | 值 |
| --- | --- |
| 应用机 | `ssh dev` → 180.76.180.249，root 登录，Ubuntu，python3.12 |
| 代码目录 | `/opt/phone-sim`（普通目录，由部署机 `git archive` 快照同步覆盖，**不是 git 仓库**） |
| 运行用户 | `phonesim`（系统用户，nologin，home 为 `/opt/phone-sim`） |
| 环境文件 | `/etc/phone-sim.env`（root:root，0600） |
| 数据目录 | `/var/lib/phone-sim`（由 systemd `StateDirectory` 创建，SQLite 文件 `notes.db`） |
| 服务名 / 端口 | `phone-sim` / `0.0.0.0:8140` |
| 网关机 | `ssh aliyun` → 8.133.209.25，root，Caddy 2.x |
| Caddyfile | `/etc/caddy/Caddyfile`，站点块 `wkeeli.cn { ... }` |
| 线上地址 | <https://wkeeli.cn/phone/>（全站 Basic Auth 保护，服务器本机 127.0.0.1 免认证） |

> 认证约定：应用内部**不实现登录**，全部交给站级 Basic Auth；`/phone/` 与站点上 `/job/` 等子路径行为一致。
> 本应用没有任何会话密钥或密码，**不需要** `openssl rand` 生成 SECRET。

## 0 前置条件

- 仓库已在 GitHub 公开：<https://github.com/wzqfwanj/phone-sim>，本地 `git push` 可用
  （本仓库已配置 local `http.proxy` 指向 `127.0.0.1:7897`）。
- 部署机（本地 Windows Git Bash）具备：`git`、`ssh`、`scp`、`tar`、`curl`。
- 本地已配置 ssh 别名：`ssh dev`、`ssh aliyun` 可直接 root 登录。
- 应用机：**无需访问 GitHub、无需安装 git**；python3 ≥ 3.10（实际 3.12），`8140` 端口未被占用，
  `/tmp` 可写（部署时 scp 压缩包落在这里）。
- 网关机能出站访问 `180.76.180.249:8140`（安全组/防火墙放行即可；应用机不需要对公网暴露 8140）。
- 网关机：Caddy 2.x 正在运行，`wkeeli.cn` 证书正常，站点块顶部已有全站 Basic Auth。

部署前先确认环境：

```bash
# 应用机：只检查 python3、tar（解压用）与端口，不需要 git
ssh dev 'python3 -V; command -v tar; ss -lntp | grep ":8140" || echo "8140 空闲"; df -h /tmp | tail -1'
# 网关机：Caddy 与站点配置
ssh aliyun 'caddy version; ls -l /etc/caddy/Caddyfile'
```

## 1 应用机：建运行用户与初始目录

应用机只负责跑服务；代码由部署机（本地仓库）打包上传，因此这里**不需要 git、不需要访问 GitHub**。

```bash
ssh dev

# 系统用户：无 shell、无密码；home 指向代码目录
id phonesim >/dev/null 2>&1 || \
  useradd --system --home-dir /opt/phone-sim --shell /usr/sbin/nologin --no-create-home phonesim

# 初始目录：首次发布时由 deploy.sh 解压覆盖；先建好并归 phonesim
install -d -o phonesim -g phonesim -m 0755 /opt/phone-sim

# 解压工具（Ubuntu 自带）
tar --version | head -1
```

> 代码同步不在这一节完成：完成第 2、3 节的一次性配置后，在本地仓库根目录执行
> `bash deploy/deploy.sh` 完成首次发布（`git push` → `git archive` 打包 → `scp` 上传 →
> 应用机解压覆盖 → `chown` → 重启）。首次发布前 `/opt/phone-sim` 是空目录、服务尚未启动，属正常。

## 2 应用机：环境变量文件

```bash
cat >/etc/phone-sim.env <<'EOF'
# phone-sim 运行环境（systemd EnvironmentFile，root:root 0600）
HOST=0.0.0.0
PORT=8140
DATA_DIR=/var/lib/phone-sim
APP_TZ=Asia/Shanghai
EOF
chown root:root /etc/phone-sim.env
chmod 600 /etc/phone-sim.env
```

| 变量 | 取值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址；只允许网关机访问时可考虑改成内网地址 |
| `PORT` | `8140` | 监听端口，与 Caddyfile 中 `reverse_proxy` 保持一致 |
| `DATA_DIR` | `/var/lib/phone-sim` | SQLite 数据目录；开发默认 `./data` |
| `APP_TZ` | `Asia/Shanghai` | 后端时间/日期时区 |

说明：该文件由 systemd（root）在启动时读取并注入进程，应用进程本身以 `phonesim` 运行。
文件内**没有**密码或密钥，仅路径与端口配置。

## 3 应用机：systemd 安装与自检

在**本地仓库根目录**执行（先用 scp 把 unit 传到应用机——此时 `/opt/phone-sim` 还是空目录，
不能从那里 `install`）：

```bash
scp deploy/phone-sim.service dev:/etc/systemd/system/phone-sim.service
ssh dev 'set -e; chmod 0644 /etc/systemd/system/phone-sim.service; systemctl daemon-reload; systemctl enable phone-sim'

# 首次发布：打包上传 + 解压 + 启动（脚本最后会 health check；细节见第 7 节）
bash deploy/deploy.sh
```

> 先 `enable` 而不是 `enable --now`：unit 的 `ExecStart` 依赖 `/opt/phone-sim/app.py`，
> 要等首次发布（`deploy/deploy.sh`）把代码同步上去后，服务才能启动；脚本会在解压覆盖后
> `systemctl restart phone-sim` 并轮询健康检查。

自检：

```bash
systemctl is-active phone-sim                         # 期望 active
ls -ld /var/lib/phone-sim                             # 期望 phonesim:phonesim 0750
ss -lntp | grep ':8140'                               # 期望 python3 监听 0.0.0.0:8140

# 本机 HTTP 自检
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8140/api/health   # 期望 200
curl -s http://127.0.0.1:8140/api/device                                     # 期望返回设备信息 JSON
```

- `/var/lib/phone-sim` 由 `StateDirectory=phone-sim` 自动创建；`notes.db` 在首次写入备忘录时生成。
- `UMask=0077` 使数据文件仅 `phonesim` 可读写。
- 可选加固检查：`systemd-analyze security phone-sim --no-pager | head -20`。

## 4 网关机：Caddy 子路径路由

### 4.1 备份配置

```bash
ssh aliyun
cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)
ls -l /etc/caddy/Caddyfile.bak.*
```

### 4.2 插入片段

把本仓库 [`deploy/caddy-phone-sim.conf`](./caddy-phone-sim.conf) 中「复制以下块」之后的内容，原样粘贴进
`/etc/caddy/Caddyfile` 的 `wkeeli.cn { ... }` 站点块内。

位置要求（Caddy 的 handle 按**书写顺序**匹配）：

- 必须在兜底的 `reverse_proxy localhost:5000` **之前**，否则永远命中不到；
- 实际建议紧跟已有的 `/resume` handle 块之后。

示意（不是完整文件）：

```caddyfile
wkeeli.cn {
	# ... 既有全局配置（含全站 Basic Auth）...
	# handle /resume/* { ... }

	# ---- phone-sim 子路径：/phone/ ----
	redir /phone /phone/ 308
	handle_path /phone/* {
		reverse_proxy http://180.76.180.249:8140 {
			header_up X-Forwarded-Prefix /phone
		}
	}

	# ... 其它 handle ...
	reverse_proxy localhost:5000   # 兜底，必须保持在最后
}
```

关键点：

- 用 `handle_path` 而不是 `handle`：应用前端用相对路径（`style.css`、`api/health`），
  `handle_path` 会先剥掉 `/phone` 前缀，`/phone/style.css` 才会变成 `/style.css`；用 `handle` 会 404。
- 不要重复写 `basic_auth`：站点块顶部已有全站 Basic Auth，`/phone/` 自动覆盖；本机 127.0.0.1 免认证。
- 不要加额外 `header`：站级 CSP 已是 `default-src 'self'`，本应用零外链，兼容。
- 片段中没有任何账号/密码明文。

### 4.3 校验并重载

```bash
caddy validate --config /etc/caddy/Caddyfile    # 必须通过再 reload
systemctl reload caddy
systemctl status caddy --no-pager
```

回滚：

```bash
cp -a /etc/caddy/Caddyfile.bak.YYYYMMDDHHMMSS /etc/caddy/Caddyfile
systemctl reload caddy
```

## 5 线上验证

按「从里到外」顺序验证，出问题时能快速定位是哪一层。

```bash
# 1) 应用机本机（服务自身）
ssh dev "curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8140/api/health"    # 期望 200

# 2) 网关机本机（--resolve 绕过 DNS、指向本机 Caddy；源 IP 127.0.0.1 免 Basic Auth）
ssh aliyun "curl -sk -o /dev/null -w '%{http_code}\n' --resolve wkeeli.cn:443:127.0.0.1 https://wkeeli.cn/phone/"              # 期望 200
ssh aliyun "curl -sk -o /dev/null -w '%{http_code}\n' --resolve wkeeli.cn:443:127.0.0.1 https://wkeeli.cn/phone/api/health"   # 期望 200
# 静态资源前缀是否被正确剥离（这一步能抓出把 handle_path 误写成 handle 的问题）
ssh aliyun "curl -sk -o /dev/null -w '%{http_code}\n' --resolve wkeeli.cn:443:127.0.0.1 https://wkeeli.cn/phone/style.css"    # 期望 200

# 3) 本地 Windows 公网：未登录应被全站登录门拦住
curl -s -o /dev/null -w '%{http_code}\n' https://wkeeli.cn/phone/                     # 期望 401（正常现象）
```

> **401 不是故障**：它说明站级 Basic Auth 在 Caddy 层生效。网关机本机用 `--resolve` 探测时源 IP 是
> 127.0.0.1，因此免认证、返回 200；从公网访问必须先登录。

浏览器验证（登录后）：

1. 打开 <https://wkeeli.cn/phone/>，输入全站账号 `wkeeli` 与由站点管理员维护的密码。
2. 应看到锁屏（时间/日期）→ 上滑或点击解锁 → 桌面 4 个内置应用图标。
3. 依次检查：计算器 `1+2=3`、备忘录新增与删除、时钟秒表、通知栏下拉与快捷开关、三键导航。
4. DevTools → Network：不应出现任何指向外部域名（CDN、字体、图片）的请求。
5. 窗口缩到 375px 宽：不应出现横向滚动条。

## 6 日志与排错

```bash
# 应用机
journalctl -u phone-sim -n 200 --no-pager
journalctl -u phone-sim -f
systemctl status phone-sim --no-pager -l
systemctl cat phone-sim                 # 确认实际生效的 unit 内容

# 网关机
journalctl -u caddy -n 200 --no-pager
journalctl -u caddy -f
```

### 常见问题

| 现象 | 最可能原因 | 处理 |
| --- | --- | --- |
| 页面能打开但界面无样式、CSS/JS 404 | Caddy 写成了 `handle`，前缀没被剥掉 | 改成 `handle_path /phone/*`；用 `.../phone/style.css` 验证应返回 200 |
| 502 Bad Gateway | `phone-sim` 没启动 / 端口不对 / 网关到应用机 8140 不通 | `systemctl status phone-sim --no-pager -l`；`ss -lntp \| grep 8140`；应用机 `curl 127.0.0.1:8140/api/health`；核对 Caddyfile 中 IP:端口 |
| 401 Unauthorized（curl 或浏览器弹登录框） | 全站 Basic Auth 生效 | 正常现象；浏览器输入 `wkeeli` 账号；网关机本机 curl 加 `--resolve` 即免认证 |
| 访问 `/phone` 不带斜杠时异常 | 缺少 308 补斜杠 | 补上 `redir /phone /phone/ 308`，且放在 `handle_path` 之前 |
| 备忘录保存报错 / 500 / `unable to open database file` | `/var/lib/phone-sim` 不存在或权限不对 | `ls -ld /var/lib/phone-sim`；`chown -R phonesim:phonesim /var/lib/phone-sim`；确认 unit 有 `StateDirectory=phone-sim` 且 `DATA_DIR=/var/lib/phone-sim` |
| 服务启动即退出，日志报 `Address already in use` | 8140 被旧进程占用 | `ss -lntp \| grep 8140` 找到进程并停止，再 `systemctl restart phone-sim` |
| 服务读不到环境变量 / 端口仍是默认值 | 环境文件路径或权限不对 | 路径须与 unit 的 `EnvironmentFile` 完全一致；`systemctl cat phone-sim` 核对 |
| 时钟/日期不对 | 时区未按预期 | 检查 `/etc/phone-sim.env` 的 `APP_TZ`；`timedatectl` 查看系统时区 |
| `caddy validate` 失败 | 片段插入位置或大括号不平衡 | 看 validate 输出的行号修正；必要时用备份回滚后再插入 |
| 升级后页面还是旧样式 | 浏览器/代理缓存 | 强制刷新（Ctrl+F5）或清缓存后重试 |

## 7 升级

发布流程（在本地仓库根目录、Git Bash 中执行）：

```bash
bash deploy/deploy.sh
```

脚本做的事：预检（工作区干净、分支为 main）→ `git push origin main` →
`git archive --format=tar.gz -o .tmp-deploy/... HEAD` → `scp` 到 `dev:/tmp/phone-sim.tar.gz` →
应用机 `rm -rf /opt/phone-sim && mkdir -p /opt/phone-sim` → `tar -xzf` 解压 →
`chown -R phonesim:phonesim /opt/phone-sim` → `chmod -R go-w /opt/phone-sim` →
`systemctl restart phone-sim` → 本机健康检查 → 网关机 `--resolve` 验证 `/phone/` →
公网 401 提示。任一环节失败脚本以非 0 退出并打印对应排查命令。

等价的纯手工命令（脚本失败时可用于逐步排查）：

```bash
# 1) 本地打包当前提交（HEAD）；未提交的改动不会被打进包
git archive --format=tar.gz -o /tmp/phone-sim.tar.gz HEAD

# 2) 上传到应用机
scp /tmp/phone-sim.tar.gz dev:/tmp/phone-sim.tar.gz

# 3) 应用机解压覆盖 + 权限 + 重启（不动 /var/lib/phone-sim 与 /etc/phone-sim.env）
ssh dev 'set -euo pipefail
rm -rf /opt/phone-sim
mkdir -p /opt/phone-sim
tar -xzf /tmp/phone-sim.tar.gz -C /opt/phone-sim
chown -R phonesim:phonesim /opt/phone-sim
chmod -R go-w /opt/phone-sim
rm -f /tmp/phone-sim.tar.gz
systemctl restart phone-sim
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8140/api/health'   # 期望 200

# 4) 清理本地临时包
rm -f /tmp/phone-sim.tar.gz
```

要点：

- 应用机不装 git、不访问 GitHub；`/opt/phone-sim` 是普通目录，代码以本地仓库 `HEAD` 快照为准。
- 前端是原生 HTML/CSS/JS，**没有构建步骤**，解压覆盖 + 重启即生效。
- 只覆盖代码目录：`/var/lib/phone-sim`（SQLite 数据）与 `/etc/phone-sim.env`（配置）不受影响。
- 仅更新代码时不需要动 Caddy；只有新增/修改子路径路由才需要第 4 节的备份 + validate + reload。
- 若本仓库的 `deploy/phone-sim.service` 有变更，按第 3 节重新 scp 安装 unit 并 `systemctl daemon-reload`。

## 8 数据备份

全部业务数据只有一个 SQLite 文件：`/var/lib/phone-sim/notes.db`（备忘录）。

不要在服务运行时直接 `cp` 正在写入的 db 文件（可能得到不一致快照），用 SQLite 在线备份 API。
应用机自带 python3，无需安装 `sqlite3` CLI：

```bash
ssh dev
runuser -u phonesim -- python3 - <<'PY'
import datetime, pathlib, sqlite3

src_path = pathlib.Path('/var/lib/phone-sim/notes.db')
dst_path = pathlib.Path('/tmp') / f"phone-sim-notes-{datetime.date.today():%Y%m%d}.db"
if not src_path.exists():
    raise SystemExit(f'{src_path} 不存在：还没有任何备忘录写入')

src = sqlite3.connect(src_path)
dst = sqlite3.connect(dst_path)
src.backup(dst)          # SQLite 在线备份，得到一致快照
dst.close()
src.close()
print(dst_path)
PY
```

取回本地（在本地 Windows 执行）：

```bash
scp dev:/tmp/phone-sim-notes-20260101.db .
```

恢复（先停服务，避免并发写入）：

```bash
ssh dev
systemctl stop phone-sim
install -o phonesim -g phonesim -m 0600 /tmp/phone-sim-notes-20260101.db /var/lib/phone-sim/notes.db
systemctl start phone-sim
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8140/api/health   # 期望 200
```

备份文件默认权限 `0600`（`phonesim` 所有），root 可读，因此 `scp` 以 root 登录即可取回。

---

部署/更新相关文件：

| 文件 | 用途 |
| --- | --- |
| [`deploy/phone-sim.service`](./phone-sim.service) | systemd 单元：用户、环境文件、StateDirectory、基础加固 |
| [`deploy/caddy-phone-sim.conf`](./caddy-phone-sim.conf) | 网关 Caddyfile 片段（`/phone/` 子路径反代） |
| [`deploy/deploy.sh`](./deploy.sh) | 本地一键发布脚本：`git push` → `git archive` 打包 → `scp` → 应用机解压覆盖 → 重启（Git Bash / Linux / macOS） |
| [`../README.md`](../README.md) | 项目介绍、本地运行、接口与配置 |
