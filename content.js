const LIBRARY_API = '/backend-api/files/library';
const BATCH_SIZE = 50;
const PAUSE_MS = 1000;
const MAX_RETRIES = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let cachedToken = null;

async function getToken(refresh = false) {
  if (cachedToken && !refresh) return cachedToken;
  const response = await fetch('/api/auth/session');
  const session = response.ok ? await response.json() : {};
  if (!session.accessToken) throw new Error('ChatGPT oturumu bulunamadı, giriş yapıp sayfayı yenile.');
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
    if (!retryable || attempt >= MAX_RETRIES) throw new Error(`Sunucu hatası: HTTP ${response.status}`);
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

function selectItems(items, beforeDate) {
  const cutoff = beforeDate ? new Date(`${beforeDate}T00:00:00`).getTime() : Infinity;
  return items.filter((item) => isDeletable(item) && new Date(item.record_creation_time).getTime() < cutoff);
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
  button:focus-visible, input:focus-visible { outline: 2px solid #111; outline-offset: 2px; }
  button:disabled { opacity: .5; cursor: default; }
  #open { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; }
  #panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 300px; max-width: calc(100vw - 32px);
    display: grid; gap: 10px; padding: 14px; color: #111; background: #fff; border: 1px solid #c9c9c9; border-radius: 12px; }
  [hidden] { display: none !important; }
  header { display: flex; justify-content: space-between; align-items: center; }
  strong { font-weight: 600; }
  label { display: grid; gap: 4px; }
  input { padding: 6px 8px; border: 1px solid #c9c9c9; border-radius: 8px; color: #111; background: #fff; }
  progress { width: 100%; }
  small { font-size: 12px; color: #555; }
  #trash { background: #b42318; border-color: #b42318; color: #fff; }
</style>
<button id="open" type="button">Toplu sil</button>
<section id="panel" aria-label="Toplu görsel silme" hidden>
  <header><strong>Toplu görsel silme</strong><button id="close" type="button" aria-label="Kapat">×</button></header>
  <button id="scan" type="button">Görselleri tara</button>
  <label id="filter" hidden>Şu tarihten eskiler (boş bırakırsan hepsi)<input id="before" type="date"></label>
  <button id="trash" type="button" hidden></button>
  <button id="stop" type="button" hidden>Durdur</button>
  <progress id="bar" hidden></progress>
  <div id="status" role="status" aria-live="polite"></div>
  <small>Görseller Çöp Kutusu'na gider, 30 gün içinde geri alınabilir. Favoriler de silinir, eski sohbetlerde açılmayabilirler.</small>
</section>`;

function mountPanel() {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = PANEL_HTML;
  document.body.append(host);

  const $ = (id) => root.getElementById(id);
  let all = [];
  let selected = [];
  let armed = false;
  let stopRequested = false;

  // ChatGPT is a single-page app, so a content script is not re-run when the user navigates to the library.
  setInterval(() => { host.hidden = !location.pathname.startsWith('/library'); }, 1000);
  host.hidden = !location.pathname.startsWith('/library');

  const setStatus = (text) => { $('status').textContent = text; };

  function refreshSelection() {
    selected = selectItems(all, $('before').value);
    armed = false;
    const size = formatSize(selected.reduce((sum, item) => sum + item.file_size_bytes, 0));
    $('trash').textContent = `${selected.length} görseli çöpe taşı (${size})`;
    $('trash').disabled = selected.length === 0;
    const skipped = all.filter((item) => !isDeletable(item)).length;
    setStatus(`${all.length} görsel bulundu${skipped ? `, ${skipped} tanesi proje veya GPT dosyası olduğu için atlanacak` : ''}.`);
  }

  $('open').onclick = () => { $('open').hidden = true; $('panel').hidden = false; };
  $('close').onclick = () => { $('panel').hidden = true; $('open').hidden = false; };
  $('before').oninput = refreshSelection;

  $('scan').onclick = async () => {
    $('scan').disabled = true;
    $('trash').hidden = true;
    $('filter').hidden = true;
    try {
      all = await listImages((count) => setStatus(`Taranıyor: ${count} görsel…`));
      $('filter').hidden = false;
      $('trash').hidden = false;
      refreshSelection();
    } catch (error) {
      setStatus(error.message);
    }
    $('scan').disabled = false;
  };

  $('stop').onclick = () => {
    stopRequested = true;
    $('stop').disabled = true;
    setStatus('Bu grup bitince duracak…');
  };

  $('trash').onclick = async () => {
    if (!armed) {
      armed = true;
      $('trash').textContent = `Emin misin? ${selected.length} görsel silinecek`;
      return;
    }
    armed = false;
    stopRequested = false;
    const total = selected.length;
    let processed = 0;
    let result = null;
    let failure = null;
    for (const id of ['scan', 'trash', 'before']) $(id).disabled = true;
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
          if (!stopRequested) setStatus(`${count} / ${total} işlendi…`);
        },
      });
    } catch (error) {
      failure = error.message;
    }
    $('trash').hidden = true;
    $('filter').hidden = true;
    $('stop').hidden = true;
    for (const id of ['scan', 'trash', 'before']) $(id).disabled = false;
    all = [];
    setStatus(failure
      ? `Durdu: ${failure} Durmadan önce ${processed} görsel işlendi. Sonucu görmek için yeniden tara.`
      : `${result.deleted} görsel çöpe taşındı${result.failed ? `, ${result.failed} tanesi silinemedi` : ''}. Listeyi görmek için sayfayı yenile.`);
  };
}

if (typeof document !== 'undefined') mountPanel();
if (typeof module !== 'undefined') module.exports = { listImages, selectItems, trashItems, formatSize };
