/* ============================================================
   安卓手机模拟器 · 交互逻辑（原生 JavaScript，无框架 / 无依赖 / 无构建）
   ------------------------------------------------------------
   为什么需要 JS：本页要模拟一台可操作的手机（锁屏滑动、应用切换、
   计算器运算、备忘录增删、时钟秒表、通知栏），这些交互无法只用
   HTML/CSS 完成，因此按《前端约束》「确需交互时再加原生 JS」引入，
   只用一个本地 app.js，不引用任何外部脚本或资源。
   ============================================================ */

(function () {
  "use strict";

  var $ = function (sel, root) {
    return (root || document).querySelector(sel);
  };

  var pad = function (n) {
    return String(n).padStart(2, "0");
  };

  var WEEK = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

  // ---------------------------------------------------------- SVG 图标

  var SVG_OPEN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

  var ICONS = {
    calculator:
      SVG_OPEN +
      '<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M8.5 8h7"/>' +
      '<path d="M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 15.5h.01M12 15.5h.01M15.5 15.5h.01"/></svg>',
    notes:
      SVG_OPEN +
      '<path d="M6.5 3.5h8l4 4v13h-12z"/><path d="M14.5 3.5v4.5h4.5"/>' +
      '<path d="M9.5 12h6M9.5 15.5h6"/></svg>',
    clock: SVG_OPEN + '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.2 2"/></svg>',
    settings:
      SVG_OPEN +
      '<path d="M4 7h7M15.5 7H20M4 12h3M11 12h9M4 17h7M15.5 17H20"/>' +
      '<circle cx="13" cy="7" r="1.9"/><circle cx="7.5" cy="12" r="1.9"/><circle cx="13" cy="17" r="1.9"/></svg>',
    extra:
      SVG_OPEN +
      '<rect x="4.5" y="4.5" width="15" height="15" rx="3"/><path d="M9 12h6"/></svg>',
    wifi:
      SVG_OPEN +
      '<path d="M2.5 8.5a15 15 0 0 1 19 0M5.8 12a10 10 0 0 1 12.4 0M9.2 15.4a5 5 0 0 1 5.6 0"/>' +
      '<circle cx="12" cy="18.8" r="1.1" fill="currentColor" stroke="none"/></svg>',
    bluetooth:
      SVG_OPEN +
      '<path d="M9 7.5l6 4.5-6 4.5M9 16.5l6-4.5-6-4.5M12 3.5v17"/></svg>',
    dnd: SVG_OPEN + '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12h7"/></svg>',
    plane: SVG_OPEN + '<path d="M21 3.5 3.5 10.5l6.5 2.5 2.5 6.5L21 3.5z"/></svg>',
  };

  // ---------------------------------------------------------- 应用与状态

  var APPS = [
    { id: "calculator", name: "计算器", icon: ICONS.calculator, mount: mountCalculator },
    { id: "notes", name: "备忘录", icon: ICONS.notes, mount: mountNotes },
    { id: "clock", name: "时钟", icon: ICONS.clock, mount: mountClock },
    { id: "settings", name: "设置", icon: ICONS.settings, mount: mountSettings },
  ];

  var EXTRA_APPS = ["相机", "相册", "音乐", "电话", "短信", "浏览器", "文件", "地图"];

  var QUICK = [
    { id: "wifi", label: "Wi-Fi", icon: ICONS.wifi },
    { id: "bluetooth", label: "蓝牙", icon: ICONS.bluetooth },
    { id: "dnd", label: "勿扰", icon: ICONS.dnd },
    { id: "plane", label: "飞行模式", icon: ICONS.plane },
  ];

  var state = {
    locked: true,
    app: null,
    drawer: false,
    shade: false,
    quick: { wifi: true, bluetooth: false, dnd: false, plane: false },
    device: null,
    notes: [],
    notesLoaded: false,
    stopwatch: { running: false, base: 0, started: 0 },
  };

  var appCleanup = null;
  var suppressClickUntil = 0;
  var toastTimer = 0;

  // ---------------------------------------------------------- 工具函数

  function apiGet(path) {
    return fetch(path, { headers: { Accept: "application/json" } }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function apiSend(method, path, body) {
    var init = { method: method, headers: { Accept: "application/json" } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
          return data;
        });
    });
  }

  function escapeHTML(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function fmtFullDate(d) {
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + WEEK[d.getDay()];
  }

  function relTime(iso) {
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return "";
    var diff = Date.now() - t;
    if (diff < 0) diff = 0;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    var d = new Date(t);
    if (d.toDateString() === new Date().toDateString()) {
      return "今天 " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }
    return d.getMonth() + 1 + "月" + d.getDate() + "日";
  }

  function toast(message) {
    var el = $("#toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("is-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove("is-show");
    }, 2000);
  }

  // ---------------------------------------------------------- 时钟 / 秒表

  function swElapsed() {
    var sw = state.stopwatch;
    return sw.base + (sw.running ? Date.now() - sw.started : 0);
  }

  function fmtStopwatch(ms) {
    var cs = Math.floor(ms / 10) % 100;
    var sec = Math.floor(ms / 1000) % 60;
    var min = Math.floor(ms / 60000);
    return pad(min) + ":" + pad(sec) + "." + pad(cs);
  }

  function tick() {
    var now = new Date();
    var hm = pad(now.getHours()) + ":" + pad(now.getMinutes());

    var sbTime = $("#sbTime");
    if (sbTime) sbTime.textContent = hm;

    var lockTime = $("#lockTime");
    if (lockTime) lockTime.textContent = hm;
    var lockDate = $("#lockDate");
    if (lockDate) lockDate.textContent = fmtFullDate(now);

    var hwTime = $("#hwTime");
    if (hwTime) hwTime.textContent = hm;
    var hwDate = $("#hwDate");
    if (hwDate) hwDate.textContent = fmtFullDate(now);

    var clockNow = $("#clockNow");
    if (clockNow) clockNow.textContent = hm + ":" + pad(now.getSeconds());
    var clockDate = $("#clockDate");
    if (clockDate) clockDate.textContent = fmtFullDate(now);

    var swTime = $("#swTime");
    if (swTime) swTime.textContent = fmtStopwatch(swElapsed());

    var shadeDate = $("#shadeDate");
    if (shadeDate) shadeDate.textContent = fmtFullDate(now);
  }

  // ---------------------------------------------------------- 层与导航

  function setLock(locked) {
    state.locked = locked;
    var lockEl = $("#lock");
    if (!lockEl) return;
    lockEl.classList.toggle("is-unlocked", !locked);
    if (locked) {
      closeApp();
      closeDrawer();
      closeShade();
    }
  }

  function unlock() {
    if (!state.locked) return;
    setLock(false);
  }

  function openDrawer() {
    if (state.locked) return;
    state.drawer = true;
    $("#drawer").classList.add("is-open");
    $("#drawer").setAttribute("aria-hidden", "false");
  }

  function closeDrawer() {
    state.drawer = false;
    $("#drawer").classList.remove("is-open");
    $("#drawer").setAttribute("aria-hidden", "true");
  }

  function openShade() {
    if (state.locked) return;
    state.shade = true;
    renderShade();
    $("#shade").classList.add("is-open");
    $("#shade").setAttribute("aria-hidden", "false");
  }

  function closeShade() {
    state.shade = false;
    $("#shade").classList.remove("is-open");
    $("#shade").setAttribute("aria-hidden", "true");
  }

  function openApp(id) {
    if (state.locked) return;
    var app = null;
    for (var i = 0; i < APPS.length; i += 1) {
      if (APPS[i].id === id) app = APPS[i];
    }
    if (!app) return;
    closeDrawer();
    closeShade();
    if (appCleanup) {
      appCleanup();
      appCleanup = null;
    }
    state.app = app.id;
    $("#appTitle").textContent = app.name;
    var body = $("#appBody");
    body.innerHTML = "";
    body.scrollTop = 0;
    $("#appview").classList.add("is-open");
    $("#appview").setAttribute("aria-hidden", "false");
    appCleanup = app.mount(body) || null;
  }

  function closeApp() {
    if (appCleanup) {
      appCleanup();
      appCleanup = null;
    }
    state.app = null;
    $("#appBody").innerHTML = "";
    $("#appview").classList.remove("is-open");
    $("#appview").setAttribute("aria-hidden", "true");
  }

  function navBack() {
    if (state.shade) return closeShade();
    if (state.drawer) return closeDrawer();
    if (state.app) return closeApp();
    toast("已在桌面");
  }

  function navHome() {
    closeShade();
    closeDrawer();
    closeApp();
    unlock();
  }

  function navRecents() {
    toast("最近任务暂未实现（最小模拟器）");
  }

  // ---------------------------------------------------------- 桌面 / 抽屉

  function iconHTML(id, name, icon) {
    return (
      '<button class="app-icon" type="button" data-app="' +
      id +
      '" aria-label="打开' +
      name +
      '">' +
      '<span class="glyph">' +
      icon +
      "</span>" +
      '<span class="label">' +
      name +
      "</span></button>"
    );
  }

  function renderIcons() {
    var homeGrid = $("#homeGrid");
    if (homeGrid) {
      homeGrid.innerHTML = APPS.map(function (app) {
        return iconHTML(app.id, app.name, app.icon);
      }).join("");
    }
    var drawerGrid = $("#drawerGrid");
    if (drawerGrid) {
      var builtin = APPS.map(function (app) {
        return iconHTML(app.id, app.name, app.icon);
      }).join("");
      var extras = EXTRA_APPS.map(function (name) {
        return (
          '<button class="app-icon is-extra" type="button" data-extra="' +
          name +
          '" aria-label="' +
          name +
          '（未内置）">' +
          '<span class="glyph">' +
          ICONS.extra +
          "</span>" +
          '<span class="label">' +
          name +
          "</span></button>"
        );
      }).join("");
      drawerGrid.innerHTML = builtin + extras;
    }
  }

  // ---------------------------------------------------------- 通知栏

  function renderShade() {
    var qsGrid = $("#qsGrid");
    var notifList = $("#notifList");
    if (!qsGrid || !notifList) return;

    qsGrid.innerHTML = QUICK.map(function (item) {
      var on = state.quick[item.id];
      return (
        '<button class="qs-item' +
        (on ? " is-on" : "") +
        '" type="button" data-quick="' +
        item.id +
        '" aria-pressed="' +
        on +
        '"><span>' +
        item.icon +
        "</span><span>" +
        item.label +
        "</span></button>"
      );
    }).join("");

    var device = state.device || {};
    var notesText = state.notesLoaded
      ? "共 " + state.notes.length + " 条备忘录，数据保存在本机后端"
      : "打开备忘录查看（需要后端在线）";
    notifList.innerHTML =
      '<div class="notif"><b>系统</b><p>' +
      escapeHTML(device.model || "wkeeli Phone 1") +
      " · " +
      escapeHTML(device.os || "Android 14（模拟）") +
      " 已就绪</p></div>" +
      '<div class="notif"><b>备忘录</b><p>' +
      escapeHTML(notesText) +
      "</p></div>" +
      '<div class="notif"><b>电池</b><p>电量 ' +
      (device.battery != null ? device.battery : 86) +
      "%（模拟数据）</p></div>";
  }

  function toggleQuick(id) {
    var q = state.quick;
    if (id === "plane") {
      q.plane = !q.plane;
      if (q.plane) {
        q.wifi = false;
        q.bluetooth = false;
        toast("飞行模式已开启（模拟）");
      } else {
        q.wifi = true;
        toast("飞行模式已关闭（模拟）");
      }
    } else {
      if (q.plane) {
        toast("飞行模式下不可用，请先关闭飞行模式");
        return;
      }
      q[id] = !q[id];
    }
    renderShade();
  }

  // ---------------------------------------------------------- 应用：计算器

  function mountCalculator(root) {
    var keys = [
      ["ac", "AC", "is-fn"],
      ["back", "⌫", "is-fn"],
      ["pct", "%", "is-fn"],
      ["op:div", "÷", "is-op"],
      ["7", "7", ""],
      ["8", "8", ""],
      ["9", "9", ""],
      ["op:mul", "×", "is-op"],
      ["4", "4", ""],
      ["5", "5", ""],
      ["6", "6", ""],
      ["op:sub", "−", "is-op"],
      ["1", "1", ""],
      ["2", "2", ""],
      ["3", "3", ""],
      ["op:add", "+", "is-op"],
      ["neg", "±", "is-fn"],
      ["0", "0", ""],
      ["dot", ".", ""],
      ["eq", "=", "is-eq"],
    ];

    root.innerHTML =
      '<div class="calc">' +
      '<div class="calc-display"><p class="calc-expr" id="calcExpr"></p>' +
      '<p class="calc-value" id="calcValue">0</p></div>' +
      '<div class="calc-keys">' +
      keys
        .map(function (key) {
          return (
            '<button class="calc-key ' +
            key[2] +
            '" type="button" data-k="' +
            key[0] +
            '">' +
            key[1] +
            "</button>"
          );
        })
        .join("") +
      "</div></div>";

    var exprEl = $("#calcExpr", root);
    var valueEl = $("#calcValue", root);

    var SYMBOL = { add: "+", sub: "−", mul: "×", div: "÷" };
    var display = "0";
    var acc = null;
    var op = null;
    var waiting = false;
    var errored = false;
    var expr = "";

    function paint() {
      exprEl.textContent = expr;
      valueEl.textContent = display;
    }

    function reset() {
      display = "0";
      acc = null;
      op = null;
      waiting = false;
      errored = false;
      expr = "";
      paint();
    }

    function showError() {
      display = "错误";
      expr = "";
      acc = null;
      op = null;
      waiting = true;
      errored = true;
      paint();
    }

    function fmtNum(n) {
      if (!isFinite(n)) return "错误";
      var rounded = Math.round(n * 1e10) / 1e10;
      var text = String(rounded);
      if (text.length > 14) return n.toExponential(6);
      return text;
    }

    function compute(a, b, symbol) {
      if (symbol === "add") return a + b;
      if (symbol === "sub") return a - b;
      if (symbol === "mul") return a * b;
      if (symbol === "div") return b === 0 ? NaN : a / b;
      return b;
    }

    function guard() {
      if (!errored) return;
      reset();
    }

    function inputDigit(digit) {
      guard();
      if (waiting) {
        display = digit;
        waiting = false;
      } else if (display === "0") {
        display = digit;
      } else if (display.replace(/[-.]/g, "").length < 12) {
        display += digit;
      }
      paint();
    }

    function inputDot() {
      guard();
      if (waiting) {
        display = "0.";
        waiting = false;
      } else if (display.indexOf(".") === -1) {
        display += ".";
      }
      paint();
    }

    function applyOp(nextOp) {
      guard();
      if (op !== null && !waiting) {
        var result = compute(acc, parseFloat(display), op);
        if (!isFinite(result)) return showError();
        acc = result;
        display = fmtNum(result);
      } else if (acc === null || !waiting) {
        acc = parseFloat(display);
      }
      op = nextOp;
      waiting = true;
      expr = fmtNum(acc) + " " + SYMBOL[nextOp];
      paint();
    }

    function equals() {
      if (errored || op === null) {
        if (!errored) {
          expr = display + " =";
          paint();
        }
        return;
      }
      if (waiting) return;
      var right = parseFloat(display);
      var result = compute(acc, right, op);
      expr = fmtNum(acc) + " " + SYMBOL[op] + " " + fmtNum(right) + " =";
      if (!isFinite(result)) return showError();
      display = fmtNum(result);
      acc = null;
      op = null;
      waiting = true;
      paint();
    }

    function backspace() {
      if (errored) return reset();
      if (waiting) return;
      display = display.length > 1 ? display.slice(0, -1) : "0";
      if (display === "-") display = "0";
      paint();
    }

    function percent() {
      guard();
      var value = parseFloat(display);
      if (!isFinite(value)) return showError();
      display = fmtNum(value / 100);
      waiting = true;
      paint();
    }

    function negate() {
      guard();
      if (display === "0") return;
      display = display.charAt(0) === "-" ? display.slice(1) : "-" + display;
      paint();
    }

    function handleKey(code) {
      if (code.indexOf("op:") === 0) applyOp(code.slice(3));
      else if (code === "eq") equals();
      else if (code === "ac") reset();
      else if (code === "back") backspace();
      else if (code === "pct") percent();
      else if (code === "neg") negate();
      else if (code === "dot") inputDot();
      else if (/^[0-9]$/.test(code)) inputDigit(code);
    }

    root.addEventListener("click", function (event) {
      var button = event.target.closest("[data-k]");
      if (!button) return;
      handleKey(button.getAttribute("data-k"));
    });

    function onKeyDown(event) {
      var key = event.key;
      if (!root.isConnected) return;
      if (/^[0-9]$/.test(key)) {
        inputDigit(key);
      } else if (key === "." || key === ",") {
        inputDot();
      } else if (key === "+") {
        applyOp("add");
      } else if (key === "-") {
        applyOp("sub");
      } else if (key === "*" || key === "x" || key === "X") {
        applyOp("mul");
      } else if (key === "/") {
        applyOp("div");
      } else if (key === "Enter" || key === "=") {
        equals();
      } else if (key === "Backspace") {
        backspace();
      } else if (key === "Escape") {
        reset();
      } else if (key === "%") {
        percent();
      } else {
        return;
      }
      event.preventDefault();
    }

    document.addEventListener("keydown", onKeyDown);
    paint();

    return function () {
      document.removeEventListener("keydown", onKeyDown);
    };
  }

  // ---------------------------------------------------------- 应用：备忘录

  function mountNotes(root) {
    root.innerHTML =
      '<div class="notes">' +
      '<div class="notes-compose">' +
      '<textarea id="noteInput" maxlength="200" rows="2" placeholder="写点什么，保存到后端…"></textarea>' +
      '<div class="notes-compose-row"><span class="notes-count" id="noteCount">0 / 200</span>' +
      '<button class="btn primary" id="noteSave" type="button">保存</button></div>' +
      "</div>" +
      '<div class="notes-list" id="noteList"><p class="notes-empty">加载中…</p></div>' +
      "</div>";

    var input = $("#noteInput", root);
    var countEl = $("#noteCount", root);
    var saveBtn = $("#noteSave", root);
    var list = $("#noteList", root);

    function updateCount() {
      countEl.textContent = input.value.length + " / 200";
    }

    function paintList() {
      if (!root.isConnected) return;
      if (!state.notes.length) {
        list.innerHTML =
          '<p class="notes-empty">还没有备忘录<br />在上面写一句，点「保存」即存入后端</p>';
        return;
      }
      list.innerHTML = state.notes
        .map(function (note) {
          return (
            '<div class="note">' +
            '<div class="note-main"><p class="note-text">' +
            escapeHTML(note.text) +
            '</p><p class="note-time">' +
            relTime(note.created_at) +
            "</p></div>" +
            '<button class="note-del" type="button" data-del="' +
            note.id +
            '" aria-label="删除备忘录">×</button></div>'
          );
        })
        .join("");
    }

    function loadNotes() {
      return apiGet("api/notes")
        .then(function (data) {
          state.notes = data.notes || [];
          state.notesLoaded = true;
          if (root.isConnected) paintList();
          if (state.shade) renderShade();
        })
        .catch(function () {
          state.notesLoaded = false;
          if (root.isConnected) {
            list.innerHTML =
              '<p class="notes-empty">无法连接后端<br />请在项目目录执行 <code>python app.py</code> 后刷新</p>';
          }
        });
    }

    input.addEventListener("input", updateCount);

    saveBtn.addEventListener("click", function () {
      var text = input.value.trim();
      if (!text) {
        toast("先写点什么再保存");
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = "保存中…";
      apiSend("POST", "api/notes", { text: text })
        .then(function (data) {
          if (data.note) state.notes.unshift(data.note);
          state.notesLoaded = true;
          input.value = "";
          updateCount();
          paintList();
          if (state.shade) renderShade();
          toast("已保存");
        })
        .catch(function (err) {
          toast("保存失败：" + err.message);
        })
        .then(function () {
          saveBtn.disabled = false;
          saveBtn.textContent = "保存";
        });
    });

    list.addEventListener("click", function (event) {
      var button = event.target.closest("[data-del]");
      if (!button) return;
      var id = button.getAttribute("data-del");
      apiSend("DELETE", "api/notes/" + id)
        .then(function () {
          state.notes = state.notes.filter(function (note) {
            return String(note.id) !== String(id);
          });
          paintList();
          if (state.shade) renderShade();
          toast("已删除");
        })
        .catch(function (err) {
          toast("删除失败：" + err.message);
        });
    });

    paintList();
    loadNotes();

    return function () {};
  }

  // ---------------------------------------------------------- 应用：时钟

  function mountClock(root) {
    root.innerHTML =
      '<div class="clock-app">' +
      '<p class="clock-now" id="clockNow">--:--:--</p>' +
      '<p class="clock-date" id="clockDate">--</p>' +
      '<hr class="hr" />' +
      '<p class="sw-label">秒表</p>' +
      '<p class="sw-time" id="swTime">00:00.00</p>' +
      '<div class="sw-actions">' +
      '<button class="btn primary" id="swToggle" type="button">开始</button>' +
      '<button class="btn" id="swReset" type="button">重置</button>' +
      "</div></div>";

    var toggle = $("#swToggle", root);
    var reset = $("#swReset", root);
    var sw = state.stopwatch;

    function paintToggle() {
      toggle.textContent = sw.running ? "暂停" : "开始";
    }

    toggle.addEventListener("click", function () {
      if (sw.running) {
        sw.base = swElapsed();
        sw.running = false;
        sw.started = 0;
      } else {
        sw.running = true;
        sw.started = Date.now();
      }
      paintToggle();
      tick();
    });

    reset.addEventListener("click", function () {
      sw.running = false;
      sw.base = 0;
      sw.started = 0;
      paintToggle();
      tick();
    });

    paintToggle();
    tick();

    return function () {};
  }

  // ---------------------------------------------------------- 应用：设置

  function mountSettings(root) {
    root.innerHTML =
      '<div class="settings">' +
      '<ul class="set-group">' +
      '<li class="set-row"><span>型号</span><span data-set-field="model">—</span></li>' +
      '<li class="set-row"><span>系统版本</span><span data-set-field="os">—</span></li>' +
      '<li class="set-row"><span>分辨率</span><span data-set-field="resolution">—</span></li>' +
      '<li class="set-row"><span>电池</span><span data-set-field="battery">—</span></li>' +
      '<li class="set-row"><span>存储</span><span data-set-field="storage">—</span></li>' +
      '<li class="set-row"><span>网络</span><span data-set-field="network">—</span></li>' +
      '<li class="set-row"><span>后端</span><span data-set-field="backend">—</span></li>' +
      "</ul>" +
      '<div class="set-action">' +
      '<button class="btn" type="button" data-set-action="lock">锁定屏幕</button>' +
      '<button class="btn" type="button" data-set-action="reload">重新加载</button>' +
      "</div>" +
      '<p class="set-note">网页版安卓界面模拟器：只模拟系统界面与内置应用，不运行真实 APK。' +
      "界面为灰阶单主题；备忘录通过本机 Python 后端（SQLite）持久化。</p>" +
      "</div>";

    function fill() {
      if (!root.isConnected) return;
      var device = state.device || {};
      var fields = {
        model: device.model || "—",
        os: device.os || "—",
        resolution: device.resolution || "—",
        battery: device.battery != null ? device.battery + "%（模拟）" : "—",
        storage: device.storage || "—",
        network: device.network || "—",
        backend: device.server_time ? "在线" : "未连接",
      };
      Object.keys(fields).forEach(function (key) {
        var el = root.querySelector('[data-set-field="' + key + '"]');
        if (el) el.textContent = fields[key];
      });
    }

    root.addEventListener("click", function (event) {
      var button = event.target.closest("[data-set-action]");
      if (!button) return;
      var action = button.getAttribute("data-set-action");
      if (action === "lock") {
        closeApp();
        setLock(true);
      } else if (action === "reload") {
        window.location.reload();
      }
    });

    if (state.device) {
      fill();
    } else {
      apiGet("api/device")
        .then(function (data) {
          state.device = data;
          fill();
        })
        .catch(function () {});
    }

    return function () {};
  }

  // ---------------------------------------------------------- 手势

  function attachSwipe(el, onEnd) {
    if (!el) return;
    var startY = null;
    var moved = false;

    el.addEventListener("pointerdown", function (event) {
      if (event.button != null && event.button !== 0) return;
      startY = event.clientY;
      moved = false;
    });

    el.addEventListener("pointermove", function (event) {
      if (startY === null) return;
      if (Math.abs(event.clientY - startY) > 8) moved = true;
    });

    el.addEventListener("pointerup", function (event) {
      if (startY === null) return;
      var dy = event.clientY - startY;
      startY = null;
      if (moved && Math.abs(dy) > 24) suppressClickUntil = Date.now() + 350;
      onEnd(dy, moved);
    });

    el.addEventListener("pointercancel", function () {
      startY = null;
    });
  }

  function bindGestures() {
    attachSwipe($("#lock"), function (dy, moved) {
      if (moved && dy < -30) return unlock();
      if (!moved) return unlock();
      if (dy >= 0) toast("上滑解锁");
    });

    attachSwipe($("#home"), function (dy, moved) {
      if (moved && dy < -45) openDrawer();
    });

    attachSwipe($("#statusbar"), function (dy, moved) {
      if (state.locked) return;
      if (!moved || dy > 18) openShade();
    });

    attachSwipe($("#drawer"), function (dy, moved) {
      if (moved && dy > 50) closeDrawer();
    });

    attachSwipe($("#shade"), function (dy, moved) {
      if (moved && dy < -40) closeShade();
    });
  }

  // ---------------------------------------------------------- 事件绑定

  function bindEvents() {
    document.addEventListener(
      "click",
      function (event) {
        if (Date.now() < suppressClickUntil) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      true
    );

    document.addEventListener("click", function (event) {
      var shortcut = event.target.closest("[data-app]");
      if (shortcut) return openApp(shortcut.getAttribute("data-app"));

      var extra = event.target.closest("[data-extra]");
      if (extra) return toast(extra.getAttribute("data-extra") + " 未内置（最小模拟器）");

      var quick = event.target.closest("[data-quick]");
      if (quick) return toggleQuick(quick.getAttribute("data-quick"));

      var action = event.target.closest("[data-act]");
      if (!action) return;
      var name = action.getAttribute("data-act");
      if (name === "open-drawer") openDrawer();
      else if (name === "close-drawer") closeDrawer();
      else if (name === "app-back") closeApp();
      else if (name === "close-shade") closeShade();
      else if (name === "nav-back") navBack();
      else if (name === "nav-home") navHome();
      else if (name === "nav-recents") navRecents();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (state.shade) closeShade();
      else if (state.drawer) closeDrawer();
      else if (state.app) closeApp();
    });

    var shade = $("#shade");
    if (shade) {
      shade.addEventListener("click", function (event) {
        if (event.target === shade) closeShade();
      });
    }

    var statusbar = $("#statusbar");
    if (statusbar) {
      statusbar.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openShade();
        }
      });
    }
  }

  // ---------------------------------------------------------- 数据加载

  function refreshDevice() {
    return apiGet("api/device")
      .then(function (data) {
        state.device = data;
        var battery = $("#sbBattery");
        if (battery && data.battery != null) battery.textContent = data.battery + "%";
        if (state.shade) renderShade();
      })
      .catch(function () {});
  }

  function refreshNotes() {
    return apiGet("api/notes")
      .then(function (data) {
        state.notes = data.notes || [];
        state.notesLoaded = true;
        if (state.shade) renderShade();
      })
      .catch(function () {
        state.notesLoaded = false;
      });
  }

  // ---------------------------------------------------------- 深链（截图/调试用）

  function applyDeepLink() {
    var params = new URLSearchParams(window.location.search);
    if (params.get("lock") === "1") {
      setLock(true);
      return;
    }
    var view = params.get("view");
    if (!view) return;
    // 截图 / 调试直达：跳过过渡动画，直接落到目标界面
    document.documentElement.classList.add("is-instant");
    unlock();
    if (view === "drawer") openDrawer();
    else if (view === "shade") openShade();
    else if (view === "home") return;
    else openApp(view);
  }

  // ---------------------------------------------------------- 启动

  function boot() {
    renderIcons();
    renderShade();
    bindGestures();
    bindEvents();
    tick();
    setInterval(tick, 250);
    refreshDevice();
    refreshNotes();
    applyDeepLink();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
