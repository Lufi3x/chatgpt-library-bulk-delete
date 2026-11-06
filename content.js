const LIBRARY_API = '/backend-api/files/library';
const BATCH_SIZE = 25; // delete-batch rejects more than 25 files with HTTP 422
const PAUSE_MS = 1000;
const MAX_RETRIES = 5;

const STRINGS = {
  tr: {
    open: 'Toplu sil',
    title: 'Toplu görsel silme',
    close: 'Kapat',
    language: 'Dil',
    scan: 'Görselleri tara',
    howMany: 'Kaç görsel silinsin?',
    all: 'Tümü',
    someCount: 'Belirli adet (en eskilerden başlar)',
    countLabel: 'Adet',
    before: 'Sadece şu tarihten eskiler (isteğe bağlı)',
    stop: 'Durdur',
    note: "Görseller Çöp Kutusu'na gider, 30 gün içinde geri alınabilir. Favoriler de silinir, eski sohbetlerde açılmayabilirler.",
    trash: (n, size) => `${n} görseli çöpe taşı (${size})`,
    confirm: (n) => `Emin misin? ${n} görsel silinecek`,
    found: (n, skipped) => `${n} görsel bulundu${skipped ? `, ${skipped} tanesi proje veya GPT dosyası olduğu için atlanacak` : ''}.`,
    scanning: (n) => `Taranıyor: ${n} görsel…`,
    stopping: 'Bu grup bitince duracak…',
    progress: (n, total) => `${n} / ${total} işlendi…`,
    failed: (message, n) => `Durdu: ${message} Durmadan önce ${n} görsel işlendi. Sonucu görmek için yeniden tara.`,
    done: (n, failed) => `${n} görsel çöpe taşındı${failed ? `, ${failed} tanesi silinemedi` : ''}. Listeyi görmek için sayfayı yenile.`,
    noSession: 'ChatGPT oturumu bulunamadı, giriş yapıp sayfayı yenile.',
    serverError: (status) => `Sunucu hatası: HTTP ${status}.`,
  },
  en: {
    open: 'Bulk delete',
    title: 'Bulk delete images',
    close: 'Close',
    language: 'Language',
    scan: 'Scan images',
    howMany: 'How many images?',
    all: 'All',
    someCount: 'A specific number (oldest first)',
    countLabel: 'Number',
    before: 'Only older than this date (optional)',
    stop: 'Stop',
    note: 'Images go to Trash and can be restored for 30 days. Favorites are included, and images may stop opening in old chats.',
    trash: (n, size) => `Move ${n} images to Trash (${size})`,
    confirm: (n) => `Are you sure? ${n} images will be deleted`,
    found: (n, skipped) => `Found ${n} images${skipped ? `, ${skipped} skipped because they belong to a project or GPT` : ''}.`,
    scanning: (n) => `Scanning: ${n} images…`,
    stopping: 'Stopping after this batch…',
    progress: (n, total) => `${n} / ${total} processed…`,
    failed: (message, n) => `Stopped: ${message} ${n} images were processed first. Scan again to see the result.`,
    done: (n, failed) => `Moved ${n} images to Trash${failed ? `, ${failed} could not be deleted` : ''}. Reload the page to see the list.`,
    noSession: 'ChatGPT session not found. Log in and reload the page.',
    serverError: (status) => `Server error: HTTP ${status}.`,
  },
};

const LANG_KEY = 'bulk-delete-lang';

function loadLang() {
  let saved = null;
  try { saved = localStorage.getItem(LANG_KEY); } catch {}
  if (STRINGS[saved]) return saved;
  return typeof navigator !== 'undefined' && navigator.language?.startsWith('tr') ? 'tr' : 'en';
}

let lang = loadLang();

function setLang(value) {
  lang = value;
  try { localStorage.setItem(LANG_KEY, value); } catch {}
}

function t(key, ...args) {
  const text = STRINGS[lang][key];
  return typeof text === 'function' ? text(...args) : text;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let cachedToken = null;

async function getToken(refresh = false) {
  if (cachedToken && !refresh) return cachedToken;
  const response = await fetch('/api/auth/session');
  const session = response.ok ? await response.json() : {};
  if (!session.accessToken) throw new Error(t('noSession'));
  cachedToken = session.accessToken;
  return cachedToken;
}

async function post(path, body) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(LIBRARY_API + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return response.json();

    const retryable = response.status === 401 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) throw new Error(t('serverError', response.status));
    if (response.status === 401) {
      await getToken(true);
    } else {
      const retryAfter = Number(response.headers.get('Retry-After'));
      await sleep(Number.isFinite(retryAfter) && response.headers.has('Retry-After') ? retryAfter * 1000 : 2000 * 2 ** attempt);
    }
  }
}

async function listImages(onProgress = () => {}) {
  const items = [];
  let cursor = null;
  do {
    const page = await post('', {
      cursor,
      limit: 50,
      categories: ['image'],
      source: null,
      include_hidden_files: false,
      include_saved_entities: true,
      include_sites: false,
      trashed_only: false,
    });
    items.push(...page.items);
    cursor = page.cursor;
    onProgress(items.length);
  } while (cursor);
  return items;
}

// Only the user's own files, never project or custom GPT files that something else depends on.
function isDeletable(item) {
  return item.access_kind === 'owned' && !item.is_project && !item.gizmo_id;
}

// Oldest first, so that a limited delete keeps the user's most recent images.
function selectItems(items, beforeDate, limit = Infinity) {
  const cutoff = beforeDate ? new Date(`${beforeDate}T00:00:00`).getTime() : Infinity;
  const time = (item) => new Date(item.record_creation_time).getTime();
  return items
    .filter((item) => isDeletable(item) && time(item) < cutoff)
    .sort((a, b) => time(a) - time(b))
    .slice(0, limit);
}

async function trashItems(items, { onProgress = () => {}, shouldStop = () => false, pause = PAUSE_MS } = {}) {
  let deleted = 0;
  let failed = 0;
  for (let i = 0; i < items.length && !shouldStop(); i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const result = await post('/files/delete-batch', {
      files: batch.map((item) => ({
        library_file_id: item.id,
        file_id: item.file_id,
        parent_directory_id: item.directory_id,
        file_name: item.file_name,
      })),
    });
    const ok = (result.files || []).filter((file) => file.success).length;
    deleted += ok;
    failed += batch.length - ok;
    onProgress(deleted + failed);
    if (i + BATCH_SIZE < items.length) await sleep(pause);
  }
  return { deleted, failed };
}

function formatSize(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

const PANEL_HTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font: 14px/1.4 system-ui, sans-serif; }
  button { cursor: pointer; border: 1px solid #c9c9c9; border-radius: 8px; background: #fff; color: #111; padding: 8px 12px; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #111; outline-offset: 2px; }
  button:disabled { opacity: .5; cursor: default; }
  #open { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; }
  #panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 300px; max-width: calc(100vw - 32px);
    max-height: calc(100vh - 32px); overflow-y: auto;
    display: grid; gap: 10px; padding: 14px; color: #111; background: #fff; border: 1px solid #c9c9c9; border-radius: 12px; }
  [hidden] { display: none !important; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  header div { display: flex; align-items: center; gap: 6px; flex: none; }
  strong { font-weight: 600; }
  label { display: grid; gap: 4px; }
  fieldset { display: grid; gap: 6px; margin: 0; padding: 0; border: 0; }
  legend { padding: 0 0 4px; }
  label.radio { display: flex; align-items: center; gap: 6px; }
  input:not([type=radio]), select { padding: 6px 8px; border: 1px solid #c9c9c9; border-radius: 8px; color: #111; background: #fff; }
  input:not([type=radio]) { width: 100%; }
  progress { width: 100%; }
  small { font-size: 12px; color: #555; }
  #trash { background: #b42318; border-color: #b42318; color: #fff; }
</style>
<button id="open" type="button" data-t="open"></button>
<section id="panel" hidden>
  <header>
    <strong data-t="title"></strong>
    <div>
      <select id="lang"><option value="tr">Türkçe</option><option value="en">English</option></select>
      <button id="close" type="button">×</button>
    </div>
  </header>
  <button id="scan" type="button" data-t="scan"></button>
  <div id="options" style="display: grid; gap: 10px">
    <fieldset>
      <legend data-t="howMany"></legend>
      <label class="radio"><input type="radio" name="mode" id="modeAll" checked><span data-t="all"></span></label>
      <label class="radio"><input type="radio" name="mode" id="modeCount"><span data-t="someCount"></span></label>
      <label id="countRow" hidden><span data-t="countLabel"></span><input id="count" type="number" min="1" step="1" inputmode="numeric"></label>
    </fieldset>
    <label><span data-t="before"></span><input id="before" type="date"></label>
  </div>
  <button id="trash" type="button" hidden></button>
  <button id="stop" type="button" data-t="stop" hidden></button>
  <progress id="bar" hidden></progress>
  <div id="status" role="status" aria-live="polite"></div>
  <small data-t="note"></small>
</section>`;

function mountPanel() {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = PANEL_HTML;
  document.body.append(host);

  const $ = (id) => root.getElementById(id);
  const controls = ['scan', 'trash', 'before', 'count', 'modeAll', 'modeCount'];
  let all = [];
  let selected = [];
  let scanned = false;
  let armed = false;
  let stopRequested = false;
  let renderStatus = () => '';

  // ChatGPT is a single-page app, so a content script is not re-run when the user navigates to the library.
  setInterval(() => { host.hidden = !location.pathname.startsWith('/library'); }, 1000);
  host.hidden = !location.pathname.startsWith('/library');

  // Kept as a function so that the current message can be redrawn when the language changes.
  const setStatus = (render) => {
    renderStatus = render;
    $('status').textContent = render();
  };

  function renderTrash() {
    const size = formatSize(selected.reduce((sum, item) => sum + item.file_size_bytes, 0));
    $('trash').textContent = armed ? t('confirm', selected.length) : t('trash', selected.length, size);
  }

  function renderTexts() {
    for (const element of root.querySelectorAll('[data-t]')) element.textContent = t(element.dataset.t);
    $('panel').lang = lang;
    $('panel').setAttribute('aria-label', t('title'));
    $('close').setAttribute('aria-label', t('close'));
    $('lang').setAttribute('aria-label', t('language'));
    $('lang').value = lang;
    renderTrash();
    $('status').textContent = renderStatus();
  }

  function refreshSelection() {
    const countMode = $('modeCount').checked;
    $('countRow').hidden = !countMode;
    if (!scanned) return;
    selected = selectItems(all, $('before').value, countMode ? Math.max(0, Math.floor(Number($('count').value) || 0)) : Infinity);
    armed = false;
    renderTrash();
    $('trash').disabled = selected.length === 0;
    const skipped = all.filter((item) => !isDeletable(item)).length;
    const found = all.length;
    setStatus(() => t('found', found, skipped));
  }

  $('lang').onchange = () => { setLang($('lang').value); renderTexts(); };
  $('open').onclick = () => { $('open').hidden = true; $('panel').hidden = false; };
  $('close').onclick = () => { $('panel').hidden = true; $('open').hidden = false; };
  for (const id of ['before', 'count', 'modeAll', 'modeCount']) $(id).oninput = refreshSelection;

  $('scan').onclick = async () => {
    $('scan').disabled = true;
    $('trash').hidden = true;
    scanned = false;
    try {
      all = await listImages((count) => setStatus(() => t('scanning', count)));
      scanned = true;
      $('trash').hidden = false;
      refreshSelection();
    } catch (error) {
      setStatus(() => error.message);
    }
    $('scan').disabled = false;
  };

  $('stop').onclick = () => {
    stopRequested = true;
    $('stop').disabled = true;
    setStatus(() => t('stopping'));
  };

  $('trash').onclick = async () => {
    if (!armed) {
      armed = true;
      renderTrash();
      return;
    }
    armed = false;
    stopRequested = false;
    const total = selected.length;
    let processed = 0;
    let result = null;
    let failure = null;
    for (const id of controls) $(id).disabled = true;
    $('stop').hidden = false;
    $('stop').disabled = false;
    $('bar').hidden = false;
    $('bar').max = total;
    $('bar').value = 0;
    try {
      result = await trashItems(selected, {
        shouldStop: () => stopRequested,
        onProgress: (count) => {
          processed = count;
          $('bar').value = count;
          if (!stopRequested) setStatus(() => t('progress', count, total));
        },
      });
    } catch (error) {
      failure = error.message;
    }
    $('trash').hidden = true;
    scanned = false;
    $('stop').hidden = true;
    for (const id of controls) $(id).disabled = false;
    all = [];
    selected = [];
    setStatus(() => (failure ? t('failed', failure, processed) : t('done', result.deleted, result.failed)));
  };

  renderTexts();
}

if (typeof document !== 'undefined') mountPanel();
if (typeof module !== 'undefined') module.exports = { STRINGS, listImages, selectItems, trashItems, formatSize };
