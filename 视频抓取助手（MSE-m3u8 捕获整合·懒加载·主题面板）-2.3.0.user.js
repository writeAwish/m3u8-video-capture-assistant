// ==UserScript==
// @name         视频抓取助手（MSE/m3u8 捕获整合·懒加载·主题面板）
// @namespace    local.integrated.capture.ui
// @version      2.3.0
// @description  发现 m3u8 / 截获 MSE；分轨下载；UI按需求改造（懒加载、手柄拖动、主题小面板、透明度/毛玻璃、出屏纠偏、标题栏一致与扁平化）
// @author       Zhengyao & ChatGPT
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==


(function () {
  'use strict';

  /**********************
   * 全局状态
   **********************/
  const state = {
    uiReady: false,
    minimized: false,
    dragging: false,
    dragOffset: { x: 0, y: 0 },
    m3u8Set: new Set(),
    tracks: [],
    totalFragments: 0,
    foldMSE: false,
    foldM3U8: true, // m3u8 默认折叠
    // 主题/外观
    theme: loadLS('cap.theme', 'light'),   // light | dark | pinkblue | green | blue
    opacity: clamp(+loadLS('cap.opacity', '1'), 0.3, 1),  // 0.30~1.00；100% 完全不透明
    blurBase: clamp(+loadLS('cap.blurBase', '8'), 0, 20), // 毛玻璃基准强度（px）
    // 10x并静音状态
    speedMutedOn: false,
  };

  const dom = {};
  const isChromiumFS = typeof window.showSaveFilePicker === 'function';

  function loadLS(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
  function saveLS(k, v) { try { localStorage.setItem(k, String(v)); } catch {} }
  function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

  function getSafeTitle() {
    let t = document.title || 'video';
    try { t = window.top.document.title || t; } catch (e) {}
    return t.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'video';
  }
  function makeFilename(base, kind, mime) {
    const lower = (mime || '').toLowerCase();
    let ext = 'bin';
    if (lower.includes('mp4')) ext = 'mp4';
    else if (lower.includes('webm')) ext = 'webm';
    else if (lower.includes('mpeg')) ext = 'mpg';
    else if (lower.includes('ogg') || lower.includes('opus')) ext = 'ogg';
    return `${base}.${kind}.${ext}`;
  }
  function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    children.forEach(c => e.appendChild(c));
    return e;
  }
  function toast(msg) {
    const t = el('div');
    t.textContent = msg;
    t.style.cssText = `
      position: fixed; left: 50%; top: 20px; transform: translateX(-50%);
      background: rgba(0,0,0,.8); color: #fff; padding: 8px 12px; border-radius: 6px;
      z-index: 2147483647; font-size: 12px; pointer-events: none;
    `;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1500);
  }
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast('已复制到剪贴板'), () => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    const ta = el('textarea', { value: text });
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板'); } catch { alert('复制失败，请手动复制'); }
    ta.remove();
  }

  /**********************
   * UI（懒加载：首次捕获后才创建）
   **********************/
  function ensureUI() {
    if (state.uiReady) return;
    state.uiReady = true;

    // 样式
    const style = el('style');
    style.textContent = `
      :root { --cap-bg:#fff; --cap-fg:#111; --cap-border:rgba(0,0,0,.15); --cap-muted:#667085; --cap-card:rgba(0,0,0,.03); }

      #capture-helper { position: fixed; top: 16px; right: 16px; z-index: 2147483647; user-select: none;
                        --cap-bg-a: color-mix(in oklab, var(--cap-bg) var(--cap-alpha-pct,100%), transparent);
                        --cap-card-a: color-mix(in oklab, var(--cap-card) var(--cap-alpha-pct,100%), transparent); }

      #capture-helper .panel {
        display: inline-block;
        color: var(--cap-fg);
        border: 1px solid var(--cap-border);
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,.18);
        background: var(--cap-bg-a);
        backdrop-filter: blur(var(--cap-blur,0px));
        overflow: hidden;
      }
      #capture-helper.minimized .panel { width: auto; }
      #capture-helper.expanded .panel { width: 380px; }

      /* 主题：浅色=白（略灰），深色=黑（略白），粉蓝=粉色（不带蓝），新增绿/蓝 */
      #capture-helper.theme-light   { --cap-bg:#ffffff; --cap-fg:#111111; --cap-border:rgba(0,0,0,.15); --cap-muted:#667085; --cap-card:rgba(0,0,0,.06); }
      #capture-helper.theme-dark    { --cap-bg:#0a0d12; --cap-fg:#E6EDF3; --cap-border:rgba(255,255,255,.18); --cap-muted:#9FB0C0; --cap-card:rgba(255,255,255,.10); }
      #capture-helper.theme-pinkblue{ --cap-bg:#ffd6e7; --cap-fg:#0e4b91; --cap-border:rgba(14,75,145,.25); --cap-muted:#2f5d9d; --cap-card:rgba(14,75,145,.12); }
      #capture-helper.theme-green   { --cap-bg:#e5f7e8; --cap-fg:#115e2d; --cap-border:rgba(17,94,45,.25); --cap-muted:#2a6d45; --cap-card:rgba(17,94,45,.12); }
      #capture-helper.theme-blue    { --cap-bg:#e6f0ff; --cap-fg:#0e3a8a; --cap-border:rgba(14,58,138,.25); --cap-muted:#2f57a6; --cap-card:rgba(14,58,138,.12); }

      /* 头部标题栏（扁平化） */
      .ch-header { display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:8px; padding:10px 10px 8px 10px;
                   background: color-mix(in oklab, var(--cap-bg-a), var(--cap-fg) 6%); border-bottom:1px solid var(--cap-border); box-shadow:none; }
      .handle { width:14px; height:24px; cursor:grab; display:inline-flex; align-items:center; justify-content:center; }
      .handle::before { content:""; display:block; width:6px; height:18px; background:
        repeating-linear-gradient( to bottom, var(--cap-muted), var(--cap-muted) 2px, transparent 2px, transparent 4px ); }
      .handle.grabbing { cursor:grabbing; }

      .ch-title { white-space:nowrap; font-weight:700; font-size:14px; color:var(--cap-fg); }

      .ch-actions { display:grid; grid-template-columns:auto auto; grid-auto-rows:28px; gap:6px; align-items:start; }
      .btn { appearance:none; border:1px solid var(--cap-border); height:28px; padding:0 10px; border-radius:8px; background:var(--cap-card-a);
             color:var(--cap-fg); font-size:12px; font-weight:600; cursor:pointer; }
      /* 主题/外观两个按钮统一外观，且不加粗 */
      .btn.action { font-weight:400; }
      .btn:disabled{ opacity:.55; cursor:not-allowed; }

      /* 右上角：左“最小化”，右“关闭”；下方“10x并静音”横跨两列 */
      .btn-min { grid-column:1; grid-row:1; }
      .btn-close { grid-column:2; grid-row:1; }
      .btn-speed { grid-column:1/3; grid-row:2; }

      .ch-body { max-height:60vh; overflow:auto; padding:10px; }
      #capture-helper.minimized .ch-body { display:none; }

      /* 区块（列表）标题栏与主标题栏保持一致风格与扁平化 */
      .ch-section { margin-top:8px; border:1px solid var(--cap-border); border-radius:10px; overflow:hidden; background:var(--cap-bg-a); }
      .sec-head { display:flex; align-items:center; justify-content:space-between; padding:8px 10px; cursor:pointer;
                  background: color-mix(in oklab, var(--cap-bg-a), var(--cap-fg) 4%); border-bottom:1px solid color-mix(in oklab, var(--cap-border), var(--cap-fg) 10%);
                  box-shadow:none; }
      .sec-head h3{ margin:0; font-size:13px; color:var(--cap-fg); } /* 主题字色 */
      .sec-toggle{ font-size:12px; color:var(--cap-muted); }
      .sec-body{ padding:8px; display:block; }
      .sec-body.hidden{ display:none; }

      .row { background:var(--cap-card-a); padding:8px; border-radius:8px; margin-top:6px; border:1px solid var(--cap-border); }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size:12px; color:var(--cap-fg); word-break:break-all; }
      .tools { margin-top:6px; display:flex; gap:6px; flex-wrap:wrap; }
      .muted { opacity:.85; font-size:12px; color:var(--cap-muted); }
      .stat { font-size:12px; color:var(--cap-muted); margin-left:6px; }

      .footer { margin-top:10px; display:flex; gap:8px; align-items:center; justify-content:flex-end; }
      /* 底部两个按钮一致样式（不加粗） */
      .footer .btn { font-weight:600; }
      .footer .btn.action { font-weight:400; }

      /* 外观/主题面板：按钮下方新开小面板，不改变按钮布局位置 */
      .appearance, .theme { position:relative; }
      .appearance-panel, .theme-panel {
        margin-top:8px; border:1px solid var(--cap-border); border-radius:10px; background:var(--cap-bg-a);
        box-shadow:0 6px 18px rgba(0,0,0,.12); padding:10px; display:none;
      }
      .appearance-panel.open, .theme-panel.open { display:block; }
      .field{ display:flex; align-items:center; gap:8px; margin:8px 0; }
      .field label{ width:64px; text-align:right; font-size:12px; color:var(--cap-muted); }
      .field input[type="range"]{ flex:1; }

      /* 主题选项按钮风格（无下拉白底；对齐文字与按钮；不移动按钮本身） */
      .theme-options{ display:grid; grid-template-columns: repeat(5, 1fr); gap:6px; }
      .theme-opt{ height:28px; border-radius:8px; border:1px solid var(--cap-border); background:var(--cap-card-a); color:var(--cap-fg);
                  font-size:12px; cursor:pointer; text-align:center; }
      .theme-opt.selected{ outline:2px solid color-mix(in oklab, var(--cap-fg) 35%, transparent); }

      /* 扁平化：任何折叠/最小化状态都不引入阴影 */
      #capture-helper.minimized .ch-header,
      .sec-head { box-shadow:none; }
    `;
    document.documentElement.appendChild(style);

    // 容器
    const $root = el('section', { id: 'capture-helper', className: `expanded theme-${state.theme}` });
    const $panel = el('div', { className: 'panel' });

    // Header
    const $header = el('div', { className: 'ch-header' });
    const $handle = el('div', { className: 'handle', title: '拖动' });
    const $title = el('div', { className: 'ch-title', textContent: '视频抓取助手' });

    const $actions = el('div', { className: 'ch-actions' });
    const $btnMin = el('button', { className: 'btn btn-min', textContent: '最小化' });
    const $btnClose = el('button', { className: 'btn btn-close', textContent: '关闭' }); // 与其它按钮同主题色
    const $btnSpeedMute = el('button', { className: 'btn btn-speed', textContent: '10x并静音' });

    $actions.append($btnMin, $btnClose, $btnSpeedMute);
    $header.append($handle, $title, $actions);

    // Body：MSE（置顶） + m3u8（默认折叠）
    const $body = el('div', { className: 'ch-body' });

    // MSE section
    const $mseSec = el('div', { className: 'ch-section' });
    const $mseHead = el('div', { className: 'sec-head' });
    const $mseH3 = el('h3', { textContent: 'MSE 捕获（音视频分轨）' });
    const $mseTog = el('div', { className: 'sec-toggle', textContent: state.foldMSE ? '展开' : '折叠' });
    const $mseBody = el('div', { className: 'sec-body' });
    const $mseList = el('div');
    const $stat = el('div', { className: 'muted', textContent: '已捕获片段：0' });

    $mseHead.append($mseH3, $mseTog);
    $mseBody.append($stat, $mseList);
    $mseSec.append($mseHead, $mseBody);

    // m3u8 section（默认折叠）
    const $m3u8Sec = el('div', { className: 'ch-section' });
    const $m3u8Head = el('div', { className: 'sec-head' });
    const $m3u8H3 = el('h3', { textContent: 'm3u8 列表' });
    const $m3u8Tog = el('div', { className: 'sec-toggle', textContent: state.foldM3U8 ? '展开' : '折叠' });
    const $m3u8Body = el('div', { className: 'sec-body' });
    const $m3u8List = el('div');
    const $btnCopyAll = el('button', { className: 'btn', textContent: '复制全部链接' });

    $m3u8Head.append($m3u8H3, $m3u8Tog);
    $m3u8Body.append($btnCopyAll, $m3u8List);
    $m3u8Sec.append($m3u8Head, $m3u8Body);

    // Footer：主题按钮 + 外观设置按钮（两者外观一致 & 不加粗）
    const $footer = el('div', { className: 'footer' });

    // 主题按钮 + 面板（替代原下拉）
    const $themeWrap = el('div', { className: 'theme' });
    const $btnTheme = el('button', { className: 'btn action', textContent: '主题' });
    const $themePanel = el('div', { className: 'theme-panel' });
    const $opts = el('div', { className: 'theme-options' });

    const themes = [
      ['light', '浅色'],
      ['dark', '深色'],
      ['pinkblue', '粉蓝'],
      ['green', '绿色'],
      ['blue', '蓝色'],
    ];
    const optButtons = {};
    themes.forEach(([val, label]) => {
      const b = el('button', { className: 'theme-opt', textContent: label });
      if (state.theme === val) b.classList.add('selected');
      b.addEventListener('click', () => {
        state.theme = val;
        saveLS('cap.theme', state.theme);
        Object.values(optButtons).forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        applyThemeAndAppearance();
      });
      optButtons[val] = b;
      $opts.appendChild(b);
    });
    $themePanel.append($opts);
    $themeWrap.append($btnTheme);

    // 外观设置按钮 + 面板
    const $appearance = el('div', { className: 'appearance' });
    const $btnAppearance = el('button', { className: 'btn action', textContent: '外观设置' });
    const $apPanel = el('div', { className: 'appearance-panel' });

    const $f1 = el('div', { className: 'field' });
    const $f2 = el('div', { className: 'field' });
    const $lab1 = el('label', { textContent: '透明度' });
    const $lab2 = el('label', { textContent: '毛玻璃' });

    // 透明度：0.30~1.00（100% 完全不透明）
    const $rngOpacity = el('input', { type: 'range', min: '0.3', max: '1', step: '0.01', value: String(state.opacity) });
    // 毛玻璃基准强度（最终强度 = 基准强度 × (1 - 不透明度)）
    const $rngBlurBase = el('input', { type: 'range', min: '0', max: '20', step: '1', value: String(state.blurBase) });

    const $val1 = el('div', { className: 'muted', textContent: `${Math.round(state.opacity * 100)}%（100%为完全不透明）` });
    const $val2 = el('div', { className: 'muted', textContent: `${state.blurBase}px 基准（越透明越明显）` });

    $f1.append($lab1, $rngOpacity, $val1);
    $f2.append($lab2, $rngBlurBase, $val2);
    $apPanel.append($f1, $f2);

    $appearance.append($btnAppearance);

    $footer.append($themeWrap, $appearance);

    // 组装
    const $bodyTail = el('div'); // 占位，不与按钮同容器，避免按钮因面板开关而位移
    $body.append($mseSec, $m3u8Sec, $footer, $bodyTail);
    // 两个面板放在 footer 之后，避免改变 footer 行高和按钮位置
    $body.append($themePanel, $apPanel);

    const $panelChildren = [$header, $body];
    $panelChildren.forEach(n => $panel.appendChild(n));
    $root.append($panel);
    document.documentElement.appendChild($root);

    // 初始主题与外观
    applyThemeAndAppearance();

    // 折叠状态
    updateFold($mseBody, state.foldMSE, $mseTog);
    updateFold($m3u8Body, state.foldM3U8, $m3u8Tog);

    // 悬停提示（10x并静音）
    function updateSpeedBtnTitle() {
      const cur = state.speedMutedOn ? '10x且静音' : '1x且有声';
      const next = state.speedMutedOn ? '1x且有声' : '10x且静音';
      $btnSpeedMute.title = `当前：${cur}；点击切换：${next}`;
    }
    updateSpeedBtnTitle();

    // 交互：最小化/关闭/10x并静音
    $btnMin.addEventListener('click', () => {
      state.minimized = !state.minimized;
      $root.classList.toggle('minimized', state.minimized);
      $root.classList.toggle('expanded', !state.minimized);
      $btnMin.textContent = state.minimized ? '还原' : '最小化';
      if (!state.minimized) keepPanelInViewport($root);
    });

    $btnClose.addEventListener('click', () => {
      $root.remove();
      window.removeEventListener('beforeunload', tryCloseWriters, { capture: true });
    });

    $btnSpeedMute.addEventListener('mouseenter', updateSpeedBtnTitle);
    $btnSpeedMute.addEventListener('click', () => {
      state.speedMutedOn = !state.speedMutedOn;
      const rate = state.speedMutedOn ? 10 : 1;
      const muted = state.speedMutedOn;
      document.querySelectorAll('video').forEach(v => { try { v.playbackRate = rate; v.muted = muted; } catch (e) {} });
      $btnSpeedMute.textContent = state.speedMutedOn ? '恢复正常' : '10x并静音';
      updateSpeedBtnTitle();
    });

    // 只允许手柄拖动（可部分拖出屏幕）
    const boundMargin = 30;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    function onMove(e) {
      if (!state.dragging) return;
      const dx = (e.clientX || (e.touches && e.touches[0].clientX) || 0) - startX;
      const dy = (e.clientY || (e.touches && e.touches[0].clientY) || 0) - startY;
      const w = $root.offsetWidth;
      const h = $root.offsetHeight;
      const maxLeft = window.innerWidth - boundMargin;
      const minLeft = -(w - boundMargin);
      const maxTop = window.innerHeight - boundMargin;
      const minTop = -(h - boundMargin);
      let nextLeft = startLeft + dx;
      let nextTop = startTop + dy;
      nextLeft = Math.max(minLeft, Math.min(maxLeft, nextLeft));
      nextTop = Math.max(minTop, Math.min(maxTop, nextTop));
      $root.style.left = `${nextLeft}px`;
      $root.style.top = `${nextTop}px`;
      $root.style.right = 'auto';
      $root.style.bottom = 'auto';
    }
    function onUp() {
      state.dragging = false;
      $handle.classList.remove('grabbing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
    }
    $handle.addEventListener('mousedown', (e) => {
      state.dragging = true; $handle.classList.add('grabbing');
      const rect = $root.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY; startLeft = rect.left; startTop = rect.top;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    $handle.addEventListener('touchstart', (e) => {
      state.dragging = true; $handle.classList.add('grabbing');
      const rect = $root.getBoundingClientRect();
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY; startLeft = rect.left; startTop = rect.top;
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
    }, { passive: true });

    // 折叠切换
    $mseHead.addEventListener('click', () => {
      state.foldMSE = !state.foldMSE; updateFold($mseBody, state.foldMSE, $mseTog);
    });
    $m3u8Head.addEventListener('click', () => {
      state.foldM3U8 = !state.foldM3U8; updateFold($m3u8Body, state.foldM3U8, $m3u8Tog);
    });

    // m3u8 工具
    $btnCopyAll.addEventListener('click', () => {
      if (!state.m3u8Set.size) return toast('暂无 m3u8 链接');
      copyToClipboard(Array.from(state.m3u8Set).join('\n'));
    });

    // 主题/外观面板开关（不改变按钮位置）
    let themeOpen = false, apOpen = false;
    $btnTheme.addEventListener('click', () => {
      themeOpen = !themeOpen;
      $themePanel.classList.toggle('open', themeOpen);
      if (themeOpen) keepPanelInViewport($root);
    });
    $btnAppearance.addEventListener('click', () => {
      apOpen = !apOpen;
      $apPanel.classList.toggle('open', apOpen);
      if (apOpen) keepPanelInViewport($root);
    });

    // 外观设置：透明度 & 毛玻璃
    $rngOpacity.addEventListener('input', () => {
      state.opacity = clamp(+$rngOpacity.value, 0.3, 1);
      $val1.textContent = `${Math.round(state.opacity * 100)}%（100%为完全不透明）`;
      saveLS('cap.opacity', state.opacity);
      applyThemeAndAppearance();
    });
    $rngBlurBase.addEventListener('input', () => {
      state.blurBase = clamp(+$rngBlurBase.value, 0, 20);
      $val2.textContent = `${state.blurBase}px 基准（越透明越明显）`;
      saveLS('cap.blurBase', state.blurBase);
      applyThemeAndAppearance();
    });

    // 暴露 & 事件
    Object.assign(dom, { $root, $panel, $body, $mseList, $m3u8List, $stat });
    window.addEventListener('beforeunload', tryCloseWriters, { capture: true });

    // 初始渲染
    render();
  }

  function updateFold(bodyEl, folded, togEl) {
    bodyEl.classList.toggle('hidden', folded);
    togEl.textContent = folded ? '展开' : '折叠';
  }

  // 应用主题与外观：背景按不透明度混合；文字恒清晰；毛玻璃随“越透明越明显”
  function applyThemeAndAppearance() {
    const r = dom.$root || document.getElementById('capture-helper');
    if (r) {
      r.style.setProperty('--cap-alpha-pct', `${Math.round(state.opacity * 100)}%`);
      const effBlur = Math.round(state.blurBase * (1 - state.opacity) * 10) / 10;
      r.style.setProperty('--cap-blur', `${effBlur}px`);
      r.classList.remove('theme-light', 'theme-dark', 'theme-pinkblue', 'theme-green', 'theme-blue');
      r.classList.add(`theme-${state.theme}`);
    }
  }

  // 展开时纠偏：若面板有部分越界，将其移回屏内，优先保证左上角手柄可见
  function keepPanelInViewport(rootEl){
    const rect = rootEl.getBoundingClientRect();
    let left = rect.left, top = rect.top;
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    const overflowX = (left + rect.width) - window.innerWidth;
    const overflowY = (top + rect.height) - window.innerHeight;
    if (overflowX > 0) left = Math.max(0, left - overflowX);
    if (overflowY > 0) top = Math.max(0, top - overflowY);
    rootEl.style.left = `${left}px`;
    rootEl.style.top = `${top}px`;
    rootEl.style.right = 'auto';
    rootEl.style.bottom = 'auto';
  }

  function tryCloseWriters() {
    state.tracks.forEach(t => { if (t.streaming && t.writerClose) t.writerClose(); });
  }

  /**********************
   * 渲染（不改动功能）
   **********************/
  function render() {
    if (!state.uiReady) return;

    // 渲染 m3u8
    const $m3u8List = dom.$m3u8List;
    $m3u8List.innerHTML = '';
    if (!state.m3u8Set.size) {
      $m3u8List.appendChild(el('div', { className: 'muted', textContent: '（未发现 m3u8 请求）' }));
    } else {
      Array.from(state.m3u8Set).forEach(url => {
        const row = el('div', { className: 'row' });
        const codeEl = el('code', { textContent: url });
        const tools = el('div', { className: 'tools' });
        const bCopy = el('button', { className: 'btn', textContent: '复制' });
        const bOpen = el('button', { className: 'btn', textContent: '在新窗口打开' });
        bCopy.addEventListener('click', () => copyToClipboard(url));
        bOpen.addEventListener('click', () => window.open(url, '_blank'));
        tools.append(bCopy, bOpen);
        row.append(codeEl, tools);
        $m3u8List.appendChild(row);
      });
    }

    // 渲染 MSE
    const $mseList = dom.$mseList;
    $mseList.innerHTML = '';
    if (!state.tracks.length) {
      $mseList.appendChild(el('div', { className: 'muted', textContent: '（尚未捕获到 MSE 片段）' }));
    } else {
      state.tracks.forEach(track => {
        const row = el('div', { className: 'row' });
        const title = el('div', { innerHTML: `<b>${track.kind.toUpperCase()}</b> <span class="stat">${track.mime}</span>` });
        const stat = el('div', { className: 'muted', textContent: `已捕获片段：${track.sumFragments}` });

        const tools = el('div', { className: 'tools' });
        const bDownload = el('button', { className: 'btn', textContent: '下载当前轨' });
        const bStream = el('button', { className: 'btn', textContent: isChromiumFS ? (track.streaming ? '停止并关闭' : '开始流式保存') : '流式保存不可用', disabled: !isChromiumFS });
        const bClear = el('button', { className: 'btn', textContent: '清空此轨缓存' });

        bDownload.addEventListener('click', () => {
          if (!track.bufferList.length) return toast('此轨尚无缓存片段');
          const blob = new Blob(track.bufferList, { type: track.mime.split(';')[0] || 'application/octet-stream' });
          const name = makeFilename(getSafeTitle(), track.kind, track.mime);
          const a = el('a', { href: URL.createObjectURL(blob), download: name });
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        });

        bStream.addEventListener('click', async () => {
          if (!isChromiumFS) return;
          if (!track.streaming) {
            try {
              const name = makeFilename(getSafeTitle(), track.kind, track.mime);
              const handle = await window.showSaveFilePicker({
                suggestedName: name,
                types: [{ description: 'Media', accept: { [track.mime.split(';')[0]]: ['.' + name.split('.').pop()] } }],
              });
              const writable = await handle.createWritable();
              track.streaming = true;
              track.writer = writable;
              track.writeQueue = Promise.resolve();

              const pending = track.bufferList.slice();
              track.bufferList.length = 0;
              pending.forEach(buf => {
                track.writeQueue = track.writeQueue.then(() => writable.write(new Uint8Array(buf)));
              });

              track.writerClose = () => {
                const w = track.writer;
                track.writer = null;
                track.streaming = false;
                bStream.textContent = '开始流式保存';
                if (w) {
                  track.writeQueue = (track.writeQueue || Promise.resolve()).then(() => w.close()).catch(()=>{});
                }
              };

              bStream.textContent = '停止并关闭';
              toast('已开始流式保存（更省内存）');
            } catch (e) {
              alert('无法开始流式保存：' + e.message);
            }
          } else {
            if (track.writerClose) track.writerClose();
          }
        });

        bClear.addEventListener('click', () => {
          track.bufferList.length = 0;
          track.sumFragments = 0;
          render();
        });

        tools.append(bDownload, bStream, bClear);
        row.append(title, stat, tools);
        $mseList.appendChild(row);

        track.onStat = () => { stat.textContent = `已捕获片段：${track.sumFragments}`; };
      });
    }

    if (dom.$stat) dom.$stat.textContent = `已捕获片段：${state.totalFragments}`;
  }

  /**********************
   * 捕获逻辑（保持不变）
   **********************/
  (function hookRequests() {
    const OriginXHR = window.XMLHttpRequest;
    const open = OriginXHR.prototype.open;
    function checkAndRecord(url) {
      try {
        const u = String(url);
        if (u.toLowerCase().includes('.m3u8')) {
          if (!state.uiReady) ensureUI();
          state.m3u8Set.add(u);
          render();
        }
      } catch {}
    }
    window.XMLHttpRequest = function () {
      const xhr = new OriginXHR();
      const origOpen = xhr.open;
      xhr.open = function (method, url, ...rest) {
        checkAndRecord(url);
        return origOpen.call(this, method, url, ...rest);
      };
      return xhr;
    };
    window.XMLHttpRequest.UNSENT = 0;
    window.XMLHttpRequest.OPENED = 1;
    window.XMLHttpRequest.HEADERS_RECEIVED = 2;
    window.XMLHttpRequest.LOADING = 3;
    window.XMLHttpRequest.DONE = 4;
    window.XMLHttpRequest.toString = () => 'function XMLHttpRequest() { [native code] }';
    OriginXHR.prototype.open = open;

    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = (typeof input === 'string') ? input : (input && input.url);
        if (url) checkAndRecord(url);
      } catch {}
      return origFetch.apply(this, arguments);
    };
    window.fetch.toString = () => 'function fetch() { [native code] }';
  })();

  (function hookMSE() {
    if (!('MediaSource' in window) || !window.MediaSource.prototype) return;

    const _addSourceBuffer = window.MediaSource.prototype.addSourceBuffer;
    const _endOfStream = window.MediaSource.prototype.endOfStream;

    window.MediaSource.prototype.addSourceBuffer = function (mime) {
      if (!state.uiReady) ensureUI();

      const sb = _addSourceBuffer.call(this, mime);
      const origAppend = sb.appendBuffer;

      const lower = (mime || '').toLowerCase();
      let kind = 'other';
      if (lower.startsWith('audio/')) kind = 'audio';
      if (lower.startsWith('video/')) kind = 'video';
      if (kind === 'other') {
        if (lower.includes('mp4a') || lower.includes('vorbis') || lower.includes('opus')) kind = 'audio';
        if (lower.includes('avc1') || lower.includes('hev1') || lower.includes('vp9') || lower.includes('av01')) kind = 'video';
      }

      const track = {
        mime, kind,
        bufferList: [],
        sumFragments: 0,
        streaming: false,
        writer: null,
        writeQueue: Promise.resolve(),
        writerClose: null,
        onStat: null,
      };
      state.tracks.push(track);
      render();

      sb.appendBuffer = function (buffer) {
        try {
          state.totalFragments++;
          track.sumFragments++;
          if (track.streaming && track.writer) {
            const chunk = new Uint8Array(buffer);
            track.writeQueue = track.writeQueue.then(() => track.writer.write(chunk)).catch(()=>{});
          } else {
            track.bufferList.push(buffer);
          }
          track.onStat && track.onStat();
          dom.$stat && (dom.$stat.textContent = `已捕获片段：${state.totalFragments}`);
        } catch {}
        return origAppend.call(this, buffer);
      };
      return sb;
    };
    window.MediaSource.prototype.addSourceBuffer.toString = function () { return 'function addSourceBuffer() { [native code] }'; };

    window.MediaSource.prototype.endOfStream = function () {
      try {
        state.tracks.forEach(t => { if (t.streaming && t.writerClose) t.writerClose(); });
        if (state.uiReady) toast('资源捕获结束');
      } catch {}
      return _endOfStream.call(this);
    };
    window.MediaSource.prototype.endOfStream.toString = function () { return 'function endOfStream() { [native code] }'; };
  })();

  // 懒加载：首次发现可捕获资源时创建 UI
  // ensureUI(); // 不预创建

})();
