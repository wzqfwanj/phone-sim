#!/usr/bin/env bash
# =============================================================================
# deploy/deploy.sh —— phone-sim 一键更新脚本（本地执行）
#
# 适用环境：本地 Windows（Git Bash）、Linux、macOS；需要 bash、git、ssh、curl。
#
# 做什么：
#   1) 检查 Git 工作区干净，把当前分支推到 GitHub（应用机从 GitHub 拉取代码）
#   2) ssh dev 应用机：runuser -u phonesim -- git pull --ff-only → systemctl restart
#      → 本机健康检查 http://127.0.0.1:8140/api/health 返回 200
#   3) ssh aliyun 网关机：用 --resolve 指向本机 Caddy，验证 https://wkeeli.cn/phone/
#      与 .../api/health 返回 200（源 IP 127.0.0.1 免全站 Basic Auth）
#   4) 打印线上地址
#
# 前置条件：
#   - ~/.ssh/config 已配置：Host dev → 180.76.180.249，Host aliyun → 8.133.209.25
#   - 两台机器可直接 root 登录（免密或交互输入）
#   - 应用机已完成系统部署（见 deploy/DEPLOY.md）
#   - 在仓库根目录执行：bash deploy/deploy.sh
#
# 注意：本脚本只更新应用代码并验证，不改 Caddy 配置——子路径路由是一次性配置，
#       需要新增/修改路由时按 deploy/DEPLOY.md 第 4 节手工备份 + validate + reload。
# =============================================================================

set -euo pipefail

# 定位仓库根目录（脚本位于 <repo>/deploy/deploy.sh）
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

APP_HOST="${APP_HOST:-dev}"          # 应用机 ssh 别名
GW_HOST="${GW_HOST:-aliyun}"         # 网关机 ssh 别名
BRANCH="${BRANCH:-main}"             # 发布分支
APP_HEALTH="http://127.0.0.1:8140/api/health"
SITE_URL="https://wkeeli.cn/phone/"
GW_RESOLVE="--resolve wkeeli.cn:443:127.0.0.1"   # 网关机本机探测：绕过 DNS，源 IP 127.0.0.1 免认证

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] 失败：%s\n' "$*" >&2; exit 1; }

# ---------- 1. 本地预检 ----------
log "仓库：$REPO_DIR"
[ -f app.py ] || die "仓库根目录找不到 app.py，请在仓库根目录执行：bash deploy/deploy.sh"

for cmd in git ssh curl; do
  command -v "$cmd" >/dev/null 2>&1 || die "缺少命令：$cmd（请安装后重试）"
done

if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "Git 工作区不干净（上方为未提交改动）。请先提交或 stash，再重新发布。"
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$current_branch" = "$BRANCH" ] || \
  die "当前分支为 $current_branch，不是 $BRANCH；若要发布其它分支：BRANCH=$current_branch bash deploy/deploy.sh"

# ---------- 2. 推送到 GitHub ----------
log "推送 $BRANCH 到 GitHub ..."
git push origin "$BRANCH" || \
  die "git push 失败：检查网络与 GitHub 凭据（应用机是从 GitHub 拉取的，必须先推送成功）"
COMMIT="$(git rev-parse --short HEAD)"
log "已推送 commit $COMMIT"

# ---------- 3. 应用机更新与自检 ----------
log "更新应用机（$APP_HOST）：git pull + systemctl restart ..."
ssh "$APP_HOST" 'set -euo pipefail; runuser -u phonesim -- git -C /opt/phone-sim pull --ff-only; systemctl restart phone-sim' || \
  die "应用机更新失败。排查：ssh $APP_HOST 'journalctl -u phone-sim -n 100 --no-pager'"

log "等待应用机健康检查（$APP_HEALTH，最多 20 秒）..."
app_code=""
for _ in {1..20}; do
  app_code="$(ssh "$APP_HOST" "curl -s -o /dev/null -w '%{http_code}' '$APP_HEALTH'" || true)"
  [ "$app_code" = "200" ] && break
  sleep 1
done
[ "$app_code" = "200" ] || \
  die "应用机健康检查未返回 200（实际：${app_code:-无响应}）。排查：ssh $APP_HOST 'systemctl status phone-sim --no-pager -l; journalctl -u phone-sim -n 100 --no-pager'"
log "应用机 /api/health -> 200"

# ---------- 4. 网关机验证 ----------
log "验证网关机（$GW_HOST）：$SITE_URL ..."

site_code="$(ssh "$GW_HOST" "curl -sk -o /dev/null -w '%{http_code}' $GW_RESOLVE '$SITE_URL'" || true)"
[ "$site_code" = "200" ] || \
  die "网关机探测 $SITE_URL 未返回 200（实际：${site_code:-无响应}）。排查：ssh $GW_HOST 'caddy validate --config /etc/caddy/Caddyfile; journalctl -u caddy -n 100 --no-pager'"
log "/phone/ -> 200"

health_code="$(ssh "$GW_HOST" "curl -sk -o /dev/null -w '%{http_code}' $GW_RESOLVE '${SITE_URL}api/health'" || true)"
[ "$health_code" = "200" ] || \
  die "网关机探测 ${SITE_URL}api/health 未返回 200（实际：${health_code:-无响应}）。若 /phone/ 正常而 API 异常，通常是 Caddy 前缀未剥（应使用 handle_path）"
log "/phone/api/health -> 200"

static_code="$(ssh "$GW_HOST" "curl -sk -o /dev/null -w '%{http_code}' $GW_RESOLVE '${SITE_URL}style.css'" || true)"
[ "$static_code" = "200" ] || \
  die "网关机探测 ${SITE_URL}style.css 未返回 200（实际：${static_code:-无响应}）。检查 Caddy 是否用 handle_path（前缀未剥离会导致样式 404）"
log "/phone/style.css -> 200"

# ---------- 5. 公网登录门提示（非阻断） ----------
pub_code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$SITE_URL" || true)"
if [ "$pub_code" = "401" ]; then
  log "公网未登录访问 -> 401（全站 Basic Auth 生效，符合预期）"
else
  log "提示：公网未登录访问返回 ${pub_code:-无响应}；预期 401。若为 200 说明站点登录门配置可能变化，请人工确认。"
fi

# ---------- 6. 完成 ----------
log "发布完成，commit $COMMIT"
printf '\n线上地址：%s\n需全站 Basic Auth 登录（账号 wkeeli，密码由站点管理员维护）。\n' "$SITE_URL"
