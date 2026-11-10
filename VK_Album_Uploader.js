// ==UserScript==
// @name         VK Album Uploader (прямой канал)
// @namespace    vk-album-uploader
// @version      2.4
// @description  Загрузка фото в альбом сообщества через VK API; Загружает гарантированно все подходящие файлы в один или три потока
// @match        https://vk.com/album-*
// @match        https://vk.ru/album-*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(async function () {
  'use strict';

  const CFG = {
    parallel: 3,
    strictOrder: true,
    pauseMs: 500,
    maxPauseMs: 10000,
    retryLimit: 3,
    tokenWaitMs: 60000,
  };

  const COLOR_OK = '#4caf50';
  const COLOR_FAIL = '#e53935';
  const COLOR_IDLE = '#607d8b';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const natCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  /* ---------- токен со страницы ---------- */
  const calib = { token: null };

  function normUrl(u) {
    if (!u) return '';
    return u.startsWith('//') ? 'https:' + u : u;
  }

  function bodyToParams(body) {
    try {
      if (typeof body === 'string' && body) return new URLSearchParams(body);
      if (body instanceof URLSearchParams) return body;
      if (body instanceof FormData) {
        const sp = new URLSearchParams();
        for (const [k, v] of body.entries()) {
          if (typeof v === 'string') sp.append(k, v);
        }
        return sp;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function findToken(sp, url) {
    if (sp) {
      const t0 = sp.get('access_token');
      if (t0) return t0;
      const m1 = sp.toString().match(/access_token=([A-Za-z0-9]{20,})/);
      if (m1) return m1[1];
      const raw = sp.get('_json');
      if (raw) {
        let dec = raw;
        try { dec = JSON.stringify(JSON.parse(raw)); } catch (e) { /* как есть */ }
        const m2 = dec.match(/access_token["']?\s*[:=]\s*["']?([A-Za-z0-9]{20,})/);
        if (m2) return m2[1];
      }
    }
    if (url) {
      const m3 = String(url).match(/access_token=([A-Za-z0-9]{20,})/);
      if (m3) return m3[1];
    }
    return null;
  }

  function rememberBody(sp, url) {
    if (!sp && !url) return;
    const t = findToken(sp, url);
    if (t && !calib.token) calib.token = t;
  }

  /* ---------- перехват сети: XHR и fetch ---------- */
  (function () {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__vkuMethod = String(method || 'GET').toUpperCase();
      this.__vkuUrl = String(url);
      return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (this.__vkuMethod === 'POST' && /\/method\//.test(this.__vkuUrl)) {
          rememberBody(bodyToParams(body), this.__vkuUrl);
        }
      } catch (e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };

    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      try {
        if (method === 'POST' && /\/method\//.test(url) && init && init.body) {
          rememberBody(bodyToParams(init.body), url);
        }
      } catch (e) { /* ignore */ }
      return origFetch.apply(this, arguments);
    };
  })();

  /* ---------- панель управления ---------- */
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed', 'right:12px', 'bottom:12px', 'z-index:99999',
    'background:#222528', 'color:#e8eaed', 'font:12px/1.5 monospace',
    'padding:8px 10px', 'border-radius:10px', 'width:340px',
    'box-shadow:0 6px 20px rgba(0,0,0,.45)',
  ].join(';');

  // компактная часть: обзор (первая кнопка), прогресс, кнопки, счётчик файлов
  // реальный input — прозрачный, поверх кнопки «Обзор»
  const pickWrap = document.createElement('div');
  pickWrap.style.cssText = 'position:relative;display:inline-block';
  pickWrap.innerHTML = `
    <button id="vku-pick">Обзор…</button>
    <input id="vku-files" type="file" multiple accept="image/*"
      style="position:absolute;left:0;top:0;width:100%;height:100%;opacity:0;cursor:pointer">`;

  const barWrap = document.createElement('div');
  barWrap.style.cssText = 'background:#333639;border-radius:4px;height:14px;overflow:hidden;position:relative;user-select:none';
  barWrap.innerHTML = `
    <div id="vku-bar" style="height:100%;background:${COLOR_IDLE};width:0%"></div>
    <div id="vku-bar-label" style="position:absolute;left:0;right:0;top:0;bottom:0;display:flex;align-items:center;justify-content:center;color:#111;font-size:10px;font-weight:bold">—</div>`;

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;align-items:center';
  btnRow.appendChild(pickWrap);
  btnRow.insertAdjacentHTML('beforeend', `
    <button id="vku-start">Старт</button>
    <button id="vku-stop">Пауза</button>
    <button id="vku-reset">Сброс</button>
    <button id="vku-toggle" style="margin-left:auto">Развернуть ▾</button>`);

  const pickedInfo = document.createElement('div');
  pickedInfo.style.cssText = 'margin-top:4px;color:#9aa0a6;font-size:11px';
  pickedInfo.textContent = 'файлы не выбраны';

  // разворачиваемая часть: галочка, диагностика, статус, лог
  const details = document.createElement('div');
  details.style.cssText = 'display:none;margin-top:8px';
  details.innerHTML = `
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
      <input id="vku-strict" type="checkbox" style="cursor:pointer">
      <span>Строгий порядок (по алфавиту, по одному)</span>
    </label>
    <div style="margin-top:6px">
      <button id="vku-diag">Диагностика</button>
    </div>
    <div id="vku-status" style="margin-top:6px">выбери фото и жми «Старт»</div>
    <div id="vku-log" style="margin-top:6px;max-height:220px;overflow-y:auto;white-space:pre-wrap"></div>`;

  panel.appendChild(barWrap);
  panel.appendChild(btnRow);
  panel.appendChild(pickedInfo);
  panel.appendChild(details);
  document.body.appendChild(panel);

  const statusEl = details.querySelector('#vku-status');
  const logEl = details.querySelector('#vku-log');
  const barEl = barWrap.querySelector('#vku-bar');
  const barLabel = barWrap.querySelector('#vku-bar-label');
  const strictBox = details.querySelector('#vku-strict');
  const toggleBtn = btnRow.querySelector('#vku-toggle');
  const fileInput = pickWrap.querySelector('#vku-files');
  const pickBtn = pickWrap.querySelector('#vku-pick');

  let running = false;
  let runToken = 0;

  function log(msg) {
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }
  function updateStatus(text) { statusEl.textContent = text; }
  function setBarColor(color) { barEl.style.background = color; }
  function updateProgress(done, total) {
    const pct = total ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
    barEl.style.width = pct + '%';
    barLabel.textContent = done + ' / ' + total;
  }
  function updatePickedInfo() {
    const n = fileInput.files.length;
    pickedInfo.textContent = n === 0
      ? 'файлы не выбраны'
      : 'выбрано файлов: ' + n;
  }
  fileInput.addEventListener('change', () => {
    updatePickedInfo();
    const n = fileInput.files.length;
    if (n) log('выбрано файлов: ' + n);
  });

  function setDetailsVisible(visible) {
    details.style.display = visible ? 'block' : 'none';
    toggleBtn.textContent = visible ? 'Свернуть ▴' : 'Развернуть ▾';
  }
  toggleBtn.onclick = () => {
    setDetailsVisible(details.style.display === 'none');
  };
  setDetailsVisible(false); // стартуем в компактном виде

  /* ---------- переключатель строгого порядка (с запоминанием) ---------- */
  try {
    const saved = sessionStorage.getItem('vku_strict');
    if (saved !== null) CFG.strictOrder = saved === '1';
  } catch (e) { /* ignore */ }
  strictBox.checked = CFG.strictOrder;
  strictBox.addEventListener('change', () => {
    CFG.strictOrder = strictBox.checked;
    try { sessionStorage.setItem('vku_strict', CFG.strictOrder ? '1' : '0'); } catch (e) { /* ignore */ }
    log('режим: ' + (CFG.strictOrder ? 'строгий порядок (по алфавиту, по одному)' : 'параллельный (быстрый, порядок не гарантирован)'));
  });

  /* ---------- учёт загруженных по именам файлов ---------- */
  function getDoneNames() {
    try { return new Set(JSON.parse(sessionStorage.getItem('vku_done') || '[]')); }
    catch (e) { return new Set(); }
  }
  function addDoneName(name) {
    const s = getDoneNames();
    s.add(name);
    try { sessionStorage.setItem('vku_done', JSON.stringify([...s])); } catch (e) { /* ignore */ }
  }

  btnRow.querySelector('#vku-stop').onclick = () => {
    running = false;
    log('пауза — текущая загрузка досохранится и всё остановится');
  };
  btnRow.querySelector('#vku-reset').onclick = () => {
    sessionStorage.removeItem('vku_done');
    updateStatus('прогресс сброшен');
    updateProgress(0, 0);
    barLabel.textContent = '—';
    barEl.style.width = '0%';
    setBarColor(COLOR_IDLE);
  };
  details.querySelector('#vku-diag').onclick = () => {
    log('диагностика: ' + JSON.stringify(snapshotDebug()));
    log('режим: ' + (CFG.strictOrder ? 'строгий порядок' : 'параллельный'));
    const t = calib.token;
    if (t) log('токен: длина ' + t.length + ', начало ' + t.slice(0, 4) + '…');
  };

  /* ---------- вспомогательные признаки ---------- */
  function idsFromHtml() {
    const ids = new Set();
    const re = /photo(-?\d+)_(\d+)/g;
    const html = document.documentElement.innerHTML;
    let m;
    while ((m = re.exec(html))) ids.add(m[1] + '_' + m[2]);
    return ids;
  }

  function counterFromHeader() {
    const re = /(\d[\d\s\u00a0]{0,9})\s*(?:фотограф\w*|photos?\b)/i;
    let best = null;
    for (const el of document.querySelectorAll('h1,h2,h3,h4,div,span,a')) {
      if (!el.offsetParent || el.children.length > 2) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 60) continue;
      const m = t.match(re);
      if (m) {
        const n = parseInt(m[1].replace(/[\s\u00a0]/g, ''), 10);
        if (Number.isFinite(n) && n > 0 && (best === null || n > best)) best = n;
      }
    }
    return best;
  }

  function imgCount() {
    let n = 0;
    for (const im of document.querySelectorAll('img')) {
      if (panel.contains(im)) continue;
      n += 1;
    }
    return n;
  }

  function snapshotDebug() {
    return {
      'id фото по всему DOM': idsFromHtml().size,
      'счётчик в шапке': counterFromHeader(),
      'картинок на странице': imgCount(),
      'токен': calib.token ? 'есть' : 'нет',
    };
  }

  /* ---------- альбом из адреса страницы ---------- */
  function parseAlbum() {
    const m = location.pathname.match(/album(-?\d+)_(\d+)/);
    if (!m) return null;
    return {
      ownerId: m[1],
      groupId: String(Math.abs(Number(m[1]))),
      albumId: m[2],
      isGroup: m[1].startsWith('-'),
    };
  }

  function albumParams(album) {
    const p = { album_id: album.albumId };
    if (album.isGroup) p.group_id = album.groupId;
    return p;
  }

  /* ---------- вызов VK API ---------- */
  async function vkApi(method, params) {
    const sp = new URLSearchParams();
    for (const k of Object.keys(params)) {
      if (params[k] !== undefined && params[k] !== null) sp.set(k, String(params[k]));
    }
    sp.set('access_token', calib.token);
    sp.set('v', '5.289');
    const r = await fetch('https://web.api.vk.ru/method/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: sp.toString(),
    });
    return r.json();
  }

  /* ---------- прямой канал ---------- */
  const FILE_FIELDS = ['file1', 'photo1', 'photo', 'file'];

  function photosListIsEmpty(j2) {
    if (!j2 || j2.photos_list === undefined || j2.photos_list === null) return true;
    const s = typeof j2.photos_list === 'string'
      ? j2.photos_list
      : JSON.stringify(j2.photos_list);
    return s.trim() === '' || s.trim() === '[]';
  }

  async function tryUploadFields(uploadUrl, blob, tag) {
    let lastResp = null;
    for (const fieldName of FILE_FIELDS) {
      const fd = new FormData();
      fd.append(fieldName, blob, tag);
      const r2 = await fetch(normUrl(uploadUrl), { method: 'POST', body: fd });
      const j2 = await r2.json();
      if (!photosListIsEmpty(j2)) {
        return j2;
      }
      lastResp = j2;
    }
    return lastResp;
  }

  async function reencode(file) {
    const bmp = await createImageBitmap(file);
    const long = Math.max(bmp.width, bmp.height);
    const k = long > 2560 ? 2560 / long : 1;
    const w = Math.round(bmp.width * k);
    const h = Math.round(bmp.height * k);
    const cnv = document.createElement('canvas');
    cnv.width = w;
    cnv.height = h;
    cnv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((res) => cnv.toBlob(res, 'image/jpeg', 0.92));
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  }

  async function directUpload(file, album) {
    let j1;
    try {
      j1 = await vkApi('photos.getUploadServer', albumParams(album));
    } catch (e) {
      throw new Error('шаг 1 (getUploadServer) сеть: ' + e);
    }
    if (j1.error) throw new Error('шаг 1 (getUploadServer): ' + JSON.stringify(j1.error).slice(0, 200));
    const uploadUrl = j1.response && j1.response.upload_url;
    if (!uploadUrl) throw new Error('шаг 1: нет upload_url — ' + JSON.stringify(j1).slice(0, 200));

    let j2;
    try {
      j2 = await tryUploadFields(uploadUrl, file, file.name);
    } catch (e) {
      throw new Error('шаг 2 (upload) сеть: ' + e);
    }
    if (photosListIsEmpty(j2)) {
      try {
        const small = await reencode(file);
        j2 = await tryUploadFields(uploadUrl, small, small.name);
      } catch (e) {
        throw new Error('шаг 2 (upload, копия) сеть: ' + e);
      }
    }
    if (photosListIsEmpty(j2)) {
      throw new Error('шаг 2 (upload): файл не принят — ' + JSON.stringify(j2).slice(0, 200));
    }

    let j3;
    try {
      j3 = await vkApi('photos.save', Object.assign(albumParams(album), {
        server: j2.server,
        photos_list: typeof j2.photos_list === 'string' ? j2.photos_list : JSON.stringify(j2.photos_list),
        hash: j2.hash,
      }));
    } catch (e) {
      throw new Error('шаг 3 (save) сеть: ' + e);
    }
    if (j3.error) {
      const code = j3.error.error_code;
      if (code === 9 || code === 6 || /too many/i.test(String(j3.error.error_msg || ''))) {
        CFG.pauseMs = Math.min(CFG.pauseMs * 2, CFG.maxPauseMs);
        log('… флуд-контроль: пауза между файлами теперь ' + CFG.pauseMs + ' мс');
      }
      throw new Error('шаг 3 (save): ' + JSON.stringify(j3.error).slice(0, 200));
    }
    const arr = j3.response;
    return Array.isArray(arr) ? arr.length : 1;
  }

  async function waitToken() {
    const deadline = Date.now() + CFG.tokenWaitMs;
    while (Date.now() < deadline && !calib.token) await sleep(1000);
    return Boolean(calib.token);
  }

  /* ---------- загрузка одного файла ---------- */
  async function uploadOne(item, runId) {
    const album = parseAlbum();
    if (!album) {
      log('✗ не вижу album-XXXX_YY в адресе — открой именно страницу альбома');
      return false;
    }

    if (!calib.token) {
      log('… жду токен из трафика страницы');
      const ok = await waitToken();
      if (!ok) {
        log('✗ токен так и не появился — перезагрузи страницу и попробуй через минуту');
        return false;
      }
      log('✓ токен перехвачен');
    }
    if (runId !== runToken) return false;

    try {
      await directUpload(item.file, album);
      return true;
    } catch (e) {
      log('✗ ' + item.file.name + ' (попытка ' + item.tries + '): ' + (e && e.message ? e.message : String(e)));
      return false;
    }
  }

  /* ---------- очередь ---------- */
  async function runQueue(allFiles) {
    const myToken = ++runToken;
    running = true;

    const workersCount = CFG.strictOrder ? 1 : CFG.parallel;
    if (CFG.strictOrder) log('режим строгого порядка: файлы грузятся по одному, по алфавиту');

    const queue = allFiles
      .slice()
      .sort((a, b) => natCollator.compare(a.name, b.name))
      .map((f) => ({ file: f, tries: 0 }));

    const total = queue.length;
    let finished = 0;
    const failed = [];

    updateProgress(0, total);
    setBarColor(COLOR_OK);

    async function worker() {
      while (running && myToken === runToken) {
        const item = queue.shift();
        if (!item) return;

        while (running && myToken === runToken) {
          item.tries += 1;
          updateStatus('готово: ' + finished + '/' + total
            + ' · осталось: ' + (total - finished)
            + ' · сейчас: ' + item.file.name);

          const ok = await uploadOne(item, myToken);
          if (myToken !== runToken) return;

          if (ok) {
            finished += 1;
            addDoneName(item.file.name);
            updateProgress(finished, total);
            setBarColor(COLOR_OK);
            log('✓ ' + item.file.name + ' (' + finished + '/' + total + ')');
            await sleep(CFG.pauseMs);
            break;
          }

          if (item.tries < CFG.retryLimit) {
            setBarColor(COLOR_FAIL);
            await sleep(5000);
          } else {
            finished += 1;
            failed.push(item.file.name);
            updateProgress(finished, total);
            setBarColor(COLOR_FAIL);
            log('✗✗ ' + item.file.name + ' — ' + CFG.retryLimit + ' попытки, пропускаю');
            break;
          }
        }
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(workersCount, queue.length); i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);

    if (myToken === runToken) {
      running = false;
      updateProgress(total, total);
      if (failed.length) {
        updateStatus('готово; не долетели: ' + failed.join(', '));
        setBarColor(COLOR_FAIL);
      } else {
        updateStatus('готово, все ' + total + ' на месте' + (CFG.strictOrder ? ', по алфавиту' : ''));
        setBarColor(COLOR_OK);
      }
      log('итог: загружено ' + (total - failed.length) + ' из ' + total
        + (failed.length ? '; не долетели: ' + failed.join(', ') : ''));
    }
  }

  /* ---------- «Старт» ---------- */
  btnRow.querySelector('#vku-start').onclick = () => {
    const picked = Array.from(fileInput.files);
    if (!picked.length) {
      updateStatus('сначала выбери файлы — кнопка «Обзор…»');
      return;
    }

    runToken += 1;
    running = false;

    const doneNames = getDoneNames();
    const todo = picked.filter((f) => !doneNames.has(f.name));
    const skipped = picked.length - todo.length;
    if (skipped > 0) log('пропускаю уже загруженные: ' + skipped + ' шт.');
    if (!todo.length) {
      updateStatus('все выбранные файлы уже загружены. «Сброс» — если нужно заново');
      return;
    }

    runQueue(todo);
  };

  /* ---------- стартовая диагностика ---------- */
  log('диагностика: ' + JSON.stringify(snapshotDebug()));
  const al = parseAlbum();
  log('альбом: ' + (al
    ? 'ownerId=' + al.ownerId + ', group=' + al.groupId + ', album=' + al.albumId
    : 'не распознан из адреса'));
  const doneN = getDoneNames().size;
  if (doneN > 0) {
    log('в памяти вкладки: ' + doneN + ' уже загруженных имён');
  }
})();
