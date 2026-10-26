import { fetchText, parsePlaylist } from "./hls.js";
import { parseMpd, repExt } from "./dash.js";

const p = new URLSearchParams(location.search);
const url = p.get("u"), type = p.get("t"), baseName = p.get("n") || "video";
document.getElementById("name").textContent = baseName;

// Одна строка интерфейса на одну скачиваемую дорожку. У каждой своя кнопка:
// окно выбора файла требует отдельного клика пользователя.
function addRow(label, run) {
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `<div class="row"><b style="flex:1"></b><button class="primary">Выбрать файл и начать</button>
    <button class="danger" hidden>Отмена</button></div><p class="status"></p><progress value="0" max="1"></progress>`;
  el.querySelector("b").textContent = label;
  const [start, cancel] = el.querySelectorAll("button");
  const ctx = {
    aborted: false,
    ctrl: new AbortController(),
    status: (s) => (el.querySelector(".status").textContent = s),
    progress: (f) => (el.querySelector("progress").value = f),
  };
  cancel.onclick = () => { ctx.aborted = true; ctx.ctrl.abort(); };
  start.onclick = async () => {
    start.hidden = true;
    cancel.hidden = false;
    try {
      await run(ctx);
      ctx.status("Готово");
    } catch (e) {
      ctx.status(ctx.aborted ? "Отменено" : "Ошибка: " + e.message);
    }
    cancel.hidden = true;
  };
  document.getElementById("rows").append(el);
}

// Приёмник данных: запись прямо на диск (File System Access API) либо в память (запасной вариант).
async function openSink(suggestedName, ext) {
  if (window.showSaveFilePicker) {
    const h = await showSaveFilePicker({ suggestedName: suggestedName + "." + ext });
    const w = await h.createWritable();
    return { write: (b) => w.write(b), close: () => w.close(), abort: () => w.abort().catch(() => {}) };
  }
  const parts = [];
  return {
    write: async (b) => { parts.push(b); },
    close: async () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(parts));
      a.download = suggestedName + "." + ext;
      a.click();
    },
    abort: async () => {},
  };
}

async function fetchBuf(ctx, u, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(u, { signal: ctx.ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.arrayBuffer();
    } catch (e) {
      if (ctx.aborted || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

const keyCache = new Map();
async function decrypt(ctx, buf, seg) {
  const k = seg.key;
  if (!k) return buf;
  if (k.method !== "AES-128") throw new Error("Шифрование " + k.method + " не поддерживается");
  if (!keyCache.has(k.uri)) {
    keyCache.set(k.uri, crypto.subtle.importKey("raw", await fetchBuf(ctx, k.uri), "AES-CBC", false, ["decrypt"]));
  }
  const iv = new Uint8Array(16);
  if (k.iv) {
    const hex = k.iv.replace(/^0x/i, "").padStart(32, "0");
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    new DataView(iv.buffer).setUint32(12, seg.seq);
  }
  return crypto.subtle.decrypt({ name: "AES-CBC", iv }, await keyCache.get(k.uri), buf);
}

async function downloadFile(ctx) {
  const r = await fetch(url, { signal: ctx.ctrl.signal });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const total = Number(r.headers.get("content-length")) || 0;
  const ct = r.headers.get("content-type") || "";
  const ext = (url.split("?")[0].match(/\.(mp4|webm|mov|mp3|m4a|ogg)$/i)?.[1]) ||
    (/webm/.test(ct) ? "webm" : /audio/.test(ct) ? "m4a" : "mp4");
  const sink = await openSink(baseName, ext);
  try {
    const reader = r.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await sink.write(value);
      got += value.length;
      if (total) ctx.progress(got / total);
      ctx.status(`Скачано ${(got / 1e6).toFixed(1)} МБ` + (total ? ` из ${(total / 1e6).toFixed(1)}` : ""));
    }
    await sink.close();
  } catch (e) { await sink.abort(); throw e; }
}

// Общий конвейер для HLS и DASH: необязательный init-блок, затем сегменты по порядку.
async function writeSegments(ctx, name, ext, initBuf, segs) {
  if (!segs.length) throw new Error("Нет сегментов для загрузки");
  const sink = await openSink(name, ext);
  try {
    if (initBuf) await sink.write(await initBuf());
    const CONC = 6;
    const jobs = new Array(segs.length);
    const start = (i) => {
      if (i < segs.length && !jobs[i])
        jobs[i] = fetchBuf(ctx, segs[i].url).then((b) => decrypt(ctx, b, segs[i]));
    };
    for (let i = 0; i < Math.min(CONC, segs.length); i++) start(i);
    for (let i = 0; i < segs.length; i++) {
      const data = await jobs[i];
      jobs[i] = null; // освобождаем память
      start(i + CONC);
      await sink.write(data);
      ctx.progress((i + 1) / segs.length);
      ctx.status(`Сегмент ${i + 1} из ${segs.length}`);
    }
    await sink.close();
  } catch (e) { await sink.abort(); throw e; }
}

async function downloadHls(ctx) {
  let pl = parsePlaylist(await fetchText(url), url);
  if (pl.master) pl = parsePlaylist(await fetchText(pl.variants[0].url), pl.variants[0].url);
  const initBuf = pl.map
    ? async () => decrypt(ctx, await fetchBuf(ctx, pl.map.url), { key: pl.map.key, seq: 0 })
    : null;
  await writeSegments(ctx, baseName, pl.map ? "mp4" : "ts", initBuf, pl.segments);
}

if (type === "dash") {
  // Видео и аудио DASH лежат в отдельных дорожках. Склейка в один файл требует ffmpeg, см. README.
  (async () => {
    try {
      const m = parseMpd(await fetchText(url), url);
      const all = [...m.video, ...m.audio];
      for (const [key, suffix] of [[p.get("v"), "video"], [p.get("a"), "audio"]]) {
        if (!key) continue;
        const rep = all.find((r) => r.key === key && r.kind === suffix);
        if (!rep) continue;
        const initUrl = rep.segments.init;
        addRow(suffix === "video" ? "Видеодорожка" : "Аудиодорожка", (ctx) =>
          writeSegments(ctx, `${baseName}.${suffix}`, repExt(rep),
            initUrl ? () => fetchBuf(ctx, initUrl) : null,
            rep.segments.list.map((u) => ({ url: u, key: null }))));
      }
      if (!document.getElementById("rows").children.length) throw new Error("Дорожки не выбраны");
    } catch (e) {
      const el = document.createElement("p");
      el.textContent = "Ошибка: " + e.message;
      document.getElementById("rows").append(el);
    }
  })();
} else {
  addRow(baseName, type === "hls" ? downloadHls : downloadFile);
}
