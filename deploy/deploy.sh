#!/usr/bin/env bash
# =============================================================================
# deploy/deploy.sh —— phone-sim 一键发布脚本（本地执行）
#
# 部署模型（应用机无法访问 GitHub，因此不使用 git clone / git pull）：
#   本地仓库 --git archive--> tar.gz --scp--> 应用机 /tmp --解压覆盖--> /opt/phone-sim --restart--> 服务
#   /opt/phone-sim 是普通目录（不是 git 仓库）；应用机不需要安装 git，也不需要访问 GitHub。
#   只覆盖代码目录，不动 /var/lib/phone-sim（数据）与 /etc/phone-sim.env（配置）。
#
# 适用环境：本地 Windows（Git Bash）、Linux、macOS；需要 git、ssh、scp、tar、curl。
#
# 做什么：
#   1) 预检：仓库根目录有 app.py；命令 git/ssh/scp/tar/curl 存在；工作区干净；当前分支 = BRANCH（默认 main）
#   2) 把当前分支推到 GitHub（远端备份；失败即中止）
#   3) git archive 打包 HEAD 为 tar.gz（临时文件放 .tmp-deploy/，脚本结束由 trap 清理）
#   4) scp 上传到应用机 /tmp/phone-sim.tar.gz
#   5) ssh dev 应用机（root）：清空并重建 /opt/phone-sim → 解压 → chown phonesim → 去掉组/其他写位 → 重启服务
#   6) 健康检查轮询 http://127.0.0.1:8140/api/health 期望 200（最多 20 次 × 1s）
#   7) ssh aliyun 网关机用 --resolve 验证 /phone/、/phone/api/health、/phone/style.css 期望 200
#   8) 公网 https://wkeeli.cn/phone/ 期望 401（全站 Basic Auth 生效，非阻断提示）
#
# 前置条件：
#   - ~/.ssh/config 已配置 Host dev → 180.76.180.249、Host aliyun → 8.133.209.25，可直接 root 登录
#   - 应用机已完成一次性系统部署（用户 phonesim、/etc/phone-sim.env、systemd 单元），见 deploy/DEPLOY.md
#   - 在仓库根目录执行：bash deploy/deploy.sh
#
# 注意：本脚本不修改 systemd 单元与 Caddy 配置——它们是一次性配置；若仓库中的
#       deploy/phone-sim.service 或 deploy/caddy-phone-sim.conf 有变更，请按 DEPLOY.md 手工同步。
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

TMP_DIR="$REPO_DIR/.tmp-deploy"
TMP_TGZ="$TMP_DIR/phone-sim-$(date +%s).tar.gz"
cleanup() {
  rm -f "$TMP_TGZ"
  rmdir "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] 失败：%s\n' "$*" >&2; exit 1; }

# ---------- 1. 本地预检 ----------
log "仓库：$REPO_DIR"
[ -f app.py ] || die "仓库根目录找不到 app.py，请在仓库根目录执行：bash deploy/deploy.sh"

for cmd in git ssh scp tar curl; do
  command -v "$cmd" >/dev/null 2>&1 || die "缺少命令：$cmd（请安装后重试）"
done

if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "Git 工作区不干净（上方为未提交改动）。脚本只发布 HEAD 快照，请先提交或 stash 再发布。"
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$current_branch" = "$BRANCH" ] || \
  die "当前分支为 $current_branch，不是 $BRANCH；若要发布其它分支：BRANCH=$current_branch bash deploy/deploy.sh"

# ---------- 2. 推送到 GitHub（远端备份；失败即中止） ----------
log "推送 $BRANCH 到 GitHub ..."
# 本机经本地代理访问 GitHub，偶发 TLS 握手失败，因此最多重试 3 次
push_ok=0
for attempt in 1 2 3; do
  if git push origin "$BRANCH"; then
    push_ok=1
    break
  fi
  log "第 $attempt 次推送失败，3 秒后重试..."
  sleep 3
done
[ "$push_ok" = "1" ] || \
  die "git push 连续失败：请检查 GitHub 凭据与代理（本仓库 local http.proxy 指向 127.0.0.1:7897）。不要跳过推送，先修复网络/认证。"
COMMIT="$(git rev-parse --short HEAD)"
log "已推送 commit $COMMIT"

# ---------- 3. 打包 HEAD 快照 ----------
mkdir -p "$TMP_DIR"
log "打包 HEAD 为 tar.gz（git archive）..."
git archive --format=tar.gz -o "$TMP_TGZ" HEAD || \
  die "git archive 失败：确认 HEAD 有效（git log -1）"
[ -s "$TMP_TGZ" ] || die "打包产物为空：$TMP_TGZ"
log "包大小：$(wc -c < "$TMP_TGZ" | tr -d ' ') 字节"

# ---------- 4. 上传到应用机 ----------
log "上传到应用机（$APP_HOST:/tmp/phone-sim.tar.gz）..."
scp -q "$TMP_TGZ" "$APP_HOST:/tmp/phone-sim.tar.gz" || \
  die "scp 上传失败：确认 ssh $APP_HOST 可登录、应用机 /tmp 可写且空间充足"

# ---------- 5. 应用机解压覆盖并重启（只动代码目录） ----------
log "应用机解压覆盖 /opt/phone-sim 并重启 phone-sim ..."
ssh "$APP_HOST" 'set -euo pipefail
rm -rf /opt/phone-sim
mkdir -p /opt/phone-sim
tar -xzf /tmp/phone-sim.tar.gz -C /opt/phone-sim
chown -R phonesim:phonesim /opt/phone-sim
chmod -R go-w /opt/phone-sim
rm -f /tmp/phone-sim.tar.gz
systemctl restart phone-sim' || \
  die "应用机更新失败。排查：ssh $APP_HOST 'journalctl -u phone-sim -n 100 --no-pager; systemctl status phone-sim --no-pager -l'"

# ---------- 6. 应用机健康检查（最多 20 秒） ----------
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

# ---------- 7. 网关机验证 ----------
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

# ---------- 8. 公网登录门提示（非阻断） ----------
pub_code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$SITE_URL" || true)"
if [ "$pub_code" = "401" ]; then
  log "公网未登录访问 -> 401（全站 Basic Auth 生效，符合预期）"
else
  log "提示：公网未登录访问返回 ${pub_code:-无响应}；预期 401。若为 200 说明站点登录门配置可能变化，请人工确认。"
fi

# ---------- 9. 完成 ----------
log "发布完成，commit $COMMIT"
printf '\n线上地址：%s\n需全站 Basic Auth 登录（账号 wkeeli，密码由站点管理员维护）。\n' "$SITE_URL"
