/* 仓位管家 · 公共前端工具
   原则：不做任何判断，只做渲染。所有结论来自后端的纯函数规则引擎。 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const LABEL_CN = { right: "右侧", base: "筑底", left: "左侧", undecided: "未定" };
const POOL_CN = { hold: "持有", ready: "就绪", pullback: "回撤关注", watch: "观察", archive: "归档" };
const PHASE_CN = { pending: "待突破", active: "进行中", realized: "已兑现", exhausted: "已衰竭" };
const DISPLAY_CN = { monitor: "监控态", review: "回顾态", dormant: "休眠态" };

/* 线上静态快照模式：站点根目录挂 data/data.js（window.PM_DATA）时启用。
   本机 Python 服务不加载 data.js → 走真实 fetch。同一份代码，两边行为一致。 */
const STATIC_MODE = (typeof window !== "undefined") && !!window.PM_DATA;

/* ---------------- 基础 ---------------- */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function n(v, d = 2) {
  if (v === null || v === undefined || v === "" || isNaN(v)) return "—";
  return Number(v).toFixed(d);
}
function sgn(v, d = 2, suffix = "%") {
  if (v === null || v === undefined || isNaN(v)) return "—";
  const x = Number(v);
  return (x > 0 ? "+" : "") + x.toFixed(d) + suffix;
}
/* 涨红跌绿（中国习惯，写死在这里，避免各处漂移） */
function pctClass(v) { return v == null || isNaN(v) ? "" : (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : ""); }
function chip(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return `<span class="chip flat">—</span>`;
  const x = Number(v);
  return `<span class="chip ${x > 0 ? "up" : x < 0 ? "down" : "flat"}">${sgn(x, d)}</span>`;
}
function lab(label, code) {
  const k = label || "undecided";
  /* 快照模式下不挂 data-lc：没有后端可写，徽章就不该看起来可点 */
  const ck = !!code && !STATIC_MODE;
  return `<span class="lab ${k}${ck ? " clickable" : ""}"${ck ? ` data-lc="${code}"` : ""}
    title="${ck ? "点击设定方向标签" : ""}">${LABEL_CN[k] || "未定"}</span>`;
}
/* 把页面上所有方向徽章接上"点击设定"入口。
   ⚠ /api/dashboard 的行里字段叫 label，/api/instruments 里叫 direction_label —— 这里归一。 */
function bindLabelPicker(data, reload) {
  if (STATIC_MODE) return;   // 快照模式没有可写的后端
  $$("[data-lc]").forEach(el => el.onclick = e => {
    e.stopPropagation(); e.preventDefault();
    const code = el.dataset.lc;
    const pool = [].concat(data.rows || [], data.index_band || [], data.items || []);
    const x = pool.find(r => r.code === code) || { code: code };
    pickLabel({
      code: x.code, name: x.name,
      direction_label: x.direction_label || x.label,
      pool: x.pool, sub_status: x.sub_status,
    }, reload);
  });
}
function pri(p) { return `<span class="pri p${p || 4}">P${p || 4}</span>`; }

/* 快照模式：把 /api/xxx 映射到 window.PM_DATA 的键 */
function _snap(path) {
  const D = window.PM_DATA || {};
  const p = path.split("?")[0];
  const qstr = path.indexOf("?") >= 0 ? path.slice(path.indexOf("?") + 1) : "";
  const code = new URLSearchParams(qstr).get("code") || "";
  switch (p) {
    case "/api/dashboard":   return D.dashboard;
    case "/api/report":      return D.report;
    case "/api/settings":    return D.settings;
    case "/api/instruments": return D.instruments_list;
    case "/api/sync_log":    return D.sync_log;
    case "/api/instrument":  return (D.instruments || {})[code];
    case "/api/klines":      return (D.klines || {})[code];
    case "/api/rounds":      return (D.rounds || {})[code];
    case "/api/suggest":     return (D.suggest || {})[code];
    default:                 return undefined;
  }
}

async function api(path, opts) {
  if (STATIC_MODE) {
    const v = _snap(path);
    if (v === undefined) throw new Error("线上快照未包含 " + path.split("?")[0]);
    return JSON.parse(JSON.stringify(v));   // 深拷贝：页面改坏了也污染不到别的快照
  }
  const r = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {}));
  if (!r.ok) throw new Error((await r.text()).slice(0, 300));
  const j = await r.json();
  if (j && j.error) throw new Error(j.error);
  return j;
}
async function post(path, body) {
  if (STATIC_MODE) {
    toast("线上是只读快照 —— 录入价位 / 画线 / 跑评估请在本机工作台操作", true);
    throw new Error("线上只读快照，写入被拒绝");
  }
  return api(path, { method: "POST", body: JSON.stringify(body || {}) });
}

let _toastT = null;
function toast(msg, isErr) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = "toast on" + (isErr ? " err" : "");
  clearTimeout(_toastT);
  _toastT = setTimeout(() => { el.className = "toast" + (isErr ? " err" : ""); }, isErr ? 6000 : 2600);
}

/* ---------------- 图形元件（可视化密度：每张卡至少一个图形元素） ---------------- */
function sparkline(vals, w = 200, h = 34, up) {
  if (!vals || vals.length < 2) return `<svg width="${w}" height="${h}"></svg>`;
  const mn = Math.min(...vals), mx = Math.max(...vals), sp = (mx - mn) || 1;
  const step = w / (vals.length - 1);
  const pts = vals.map((v, i) => [i * step, h - 2 - (v - mn) / sp * (h - 6)]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const rising = up !== undefined ? up : (vals[vals.length - 1] >= vals[0]);
  const col = rising ? "var(--up)" : "var(--down)";
  const area = d + ` L${w} ${h} L0 ${h} Z`;
  const gid = "sg" + Math.random().toString(36).slice(2, 8);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${col}" stop-opacity=".14"/>
      <stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${d}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

function ring(pct, size = 34, color) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const r = (size - 6) / 2, c = 2 * Math.PI * r;
  const col = color || (p >= 85 ? "var(--up)" : p <= 15 ? "var(--down)" : "var(--warn)");
  return `<div class="ring" style="width:${size}px;height:${size}px;flex:0 0 ${size}px">
    <svg width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--line)" stroke-width="3"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${col}" stroke-width="3"
        stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p / 100)}"/>
    </svg><span style="font-size:${size < 30 ? 9 : 10.5}px">${p.toFixed(0)}</span></div>`;
}

function bar(kind, val) {
  if (kind === "none" || val == null) return `<span class="tiny">─</span>`;
  if (kind === "completion") {
    const p = Math.max(0, Math.min(100, Number(val)));
    const cls = p >= 90 ? "up" : p >= 70 ? "warn" : "";
    return `<div class="pbar ${cls}" title="完成度 ${p.toFixed(1)}%"><i style="width:${p}%"></i></div>`;
  }
  if (kind === "up") {           // 距颈线的向上距离：越近越满
    const p = Math.max(0, Math.min(100, 100 - Math.abs(Number(val)) * 4));
    return `<div class="pbar warn" title="${sgn(val)}"><i style="width:${p}%"></i></div>`;
  }
  if (kind === "down") {         // 距买回区的向下距离
    const p = Math.max(0, Math.min(100, 100 - Math.abs(Number(val)) * 4));
    return `<div class="pbar green" title="${sgn(val)}"><i style="width:${p}%"></i></div>`;
  }
  return `<span class="tiny">─</span>`;
}

/* ---------------- 布局 ---------------- */
/* href 用相对路径 + .html：GitHub Pages 项目站挂在 /<repo>/ 子路径下，绝对路径会 404；
   相对路径下本机 Python 服务（页都在根）同样能跑。active 仍用原逻辑路径作 key。 */
const NAV = [
  { key: "/",          href: "index.html",    ic: "◱", tx: "看板" },
  { key: "/report",    href: "report.html",   ic: "☰", tx: "每日报告" },
  { key: "/breakout",  href: "breakout.html", ic: "▲", tx: "突破确立" },
  { key: "/top",       href: "top.html",      ic: "▼", tx: "头部确立" },
  { key: "/settings",  href: "settings.html", ic: "⚙", tx: "参数与运维" },
];
function mountNav(active, meta) {
  const side = $("#side");
  if (!side) return;
  const items = NAV.map(x => `<a href="${x.href}" class="${x.key === active ? "on" : ""}">
      <span class="ic">${x.ic}</span><span class="tx">${x.tx}</span></a>`).join("");
  const badge = STATIC_MODE ? `<div class="ro-badge">● 线上只读快照</div>` : "";
  side.innerHTML = `<div class="brand">
      <div class="dot">仓</div>
      <div><b>仓位管家</b><small>结构 · 价位 · 纪律</small></div>
    </div>
    <nav class="nav">${items}</nav>
    ${badge}
    <div class="side-foot" id="sideFoot"></div>`;
  mountRoBanner();
  if (meta) paintFoot(meta);
}

/* 只读横幅：把「这是快照、写入要去本机」写在最显眼处，避免误以为按钮坏了 */
function mountRoBanner() {
  if (!STATIC_MODE) return;
  const main = document.querySelector("main");
  if (!main || main.querySelector(".ro-bar")) return;
  const b = document.createElement("div");
  b.className = "ro-bar";
  b.innerHTML = `🔒 <b>只读快照</b> · 生成于 ${esc((window.PM_DATA || {}).generated_at || "—")}
    · 录入价位 / 画线 / 跑评估请在本机工作台操作，本页随下一次导出自动更新`;
  main.insertBefore(b, main.firstChild);
}

function paintFoot(m) {
  const f = $("#sideFoot");
  if (!f) return;
  m = m || {};
  const open = m.open_signals || 0;
  const stamp = STATIC_MODE
    ? ((window.PM_DATA || {}).generated_at || (m.build && m.build.t))
    : (m.build && m.build.t);
  f.innerHTML = `最新数据 <b>${esc(m.latest_bar || "—")}</b><br>
    未处理信号 <b style="color:${open ? "var(--up)" : "inherit"}">${open}</b><br>
    <span style="opacity:.7">${STATIC_MODE ? "快照生成" : "构建"} ${esc(stamp || "—")}</span>`;
}

/* ---------------- 通用片段 ---------------- */
function card(title, sub, body, right = "") {
  return `<div class="card">
    <div class="card-h"><h2>${esc(title)}</h2>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}
      ${right ? `<span class="right">${right}</span>` : ""}</div>${body}</div>`;
}
function emptyBox(t) { return `<div class="empty">${esc(t)}</div>`; }

function copyText(t) {
  navigator.clipboard.writeText(t).then(() => toast("已复制"), () => toast("复制失败", true));
}

/* 三态展示口径的可见提示：绝不把回顾态的东西说成"未触发"
   后端 display_mode() 直接返回中文（监控态/回顾态/休眠态），此处兼容中英两式 */
function displayTag(display) {
  const isReview = display === "回顾态" || display === "review";
  const isDormant = display === "休眠态" || display === "dormant";
  if (isReview) return `<span class="chip gray" title="轮次已结束，只做复盘">回顾态</span>`;
  if (isDormant) return `<span class="chip gray" title="等待激活或待选型">休眠态</span>`;
  return `<span class="chip flat" title="进行中且活跃">监控态</span>`;
}
/* 回顾态下不得再出现"未触发"字样 —— 这里给出该行应显示的措辞 */
function waitingText(display, raw, phaseCn) {
  if ((display === "回顾态" || display === "review") && /未触发/.test(raw || ""))
    return `轮次已结束（${phaseCn || ""}）`;
  return raw || "";
}

/* 取 ?code= 之类 */
function qs(k, def = "") {
  const u = new URLSearchParams(location.search);
  return u.get(k) || def;
}

/* ---------------- 通用弹窗 ---------------- */
function _modal() {
  let m = $("#modal");
  if (!m) {
    m = document.createElement("div");
    m.id = "modal"; m.className = "modal";
    m.innerHTML = '<div class="box" id="modalBox"></div>';
    document.body.appendChild(m);
    m.onclick = e => { if (e.target.id === "modal") m.className = "modal"; };
  }
  return m;
}
function openModal(html) { _modal(); $("#modalBox").innerHTML = html; $("#modal").className = "modal on"; }
function closeModal() { const m = $("#modal"); if (m) m.className = "modal"; }

const LABELS = [
  ["right", "右侧", "已站上颈线，规则全开"],
  ["base", "筑底", "标签压制 → 只留自动流转与哨兵"],
  ["left", "左侧", "标签压制 → 只留自动流转与哨兵"],
  ["undecided", "未定", "未设定，规则不压制"],
];
const POOLS = [["hold", "持有"], ["ready", "就绪"], ["pullback", "回撤关注"],
               ["watch", "观察"], ["archive", "归档"]];
const SUB_STATUS = [["", "（无）"], ["waiting", "候突破"], ["entered", "已入场"],
                    ["holding", "持有中"], ["reduced", "已减仓"], ["closed", "已了结"]];

/* 方向标签 + 池子：人工设定的战略层，压制系统判断 */
function pickLabel(inst, onDone) {
  const cur = inst.direction_label || "undecided";
  const curPool = inst.pool || "watch";
  const curSub = inst.sub_status || "";
  openModal(`
    <h3>设定方向标签 · ${esc(inst.name || inst.code)}</h3>
    <div class="sub">方向标签是战略层，<b>人工设定并压制系统判断</b>。系统唯一会做的是：
      当收盘进入你亲手划定的回撤区/起涨区时，自动把它流转为「筑底」。</div>
    <div class="field"><label>方向标签</label>
      <div class="lvlpick" id="lpLab" style="grid-template-columns:repeat(4,1fr)">
        ${LABELS.map(([k, cn, tip]) =>
          `<button data-k="${k}" class="${k === cur ? "on" : ""}" title="${esc(tip)}">${cn}</button>`).join("")}
      </div></div>
    <div class="field"><label>池子</label>
      <div class="lvlpick" id="lpPool">
        ${POOLS.map(([k, cn]) =>
          `<button data-k="${k}" class="${k === curPool ? "on" : ""}">${cn}</button>`).join("")}
      </div></div>
    <div class="field"><label>子状态</label>
      <div class="lvlpick" id="lpSub">
        ${SUB_STATUS.map(([k, cn]) =>
          `<button data-k="${k}" class="${k === curSub ? "on" : ""}">${cn}</button>`).join("")}
      </div></div>
    <div class="toolbar" style="justify-content:flex-end;margin-top:16px">
      <button class="btn" id="lpCancel">取消</button>
      <button class="btn primary" id="lpOk">保存</button>
    </div>`);
  let lab = cur, pool = curPool, sub = curSub;
  const bind = (sel, set) => $$(sel + " button").forEach(b => b.onclick = () => {
    set(b.dataset.k); $$(sel + " button").forEach(x => x.classList.toggle("on", x === b));
  });
  bind("#lpLab", v => lab = v); bind("#lpPool", v => pool = v); bind("#lpSub", v => sub = v);
  $("#lpCancel").onclick = closeModal;
  $("#lpOk").onclick = async () => {
    try {
      await post("/api/pool", { code: inst.code, direction_label: lab, pool: pool, sub_status: sub });
      closeModal(); toast("已保存（该标签会压制系统判断）"); onDone && onDone();
    } catch (e) { toast("保存失败：" + e.message, true); }
  };
}

/* ---------------- 只读快照：把写操作入口收起来 ---------------- */
if (STATIC_MODE && typeof document !== "undefined") {
  const mark = () => document.body && document.body.classList.add("readonly");
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mark);
  else mark();
}
