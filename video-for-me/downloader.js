import { fetchText, parsePlaylist } from "./hls.js";

const p = new URLSearchParams(location.search);
const url = p.get("u"), type = p.get("t"), baseName = p.get("n") || "video";
const $ = (id) => document.getElementById(id);
const status = (s) => ($("status").textContent = s);
$("name").textContent = baseName;

let aborted = false;
const ctrl = new AbortController();
$("cancel").onclick = () => { aborted = true; ctrl.abort(); };

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

async function fetchBuf(u, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(u, { signal: ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.arrayBuffer();
    } catch (e) {
      if (aborted || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

const keyCache = new Map();
async function decrypt(buf, seg) {
  const k = seg.key;
  if (!k) return buf;
  if (k.method !== "AES-128") throw new Error("Шифрование " + k.method + " не поддерживается");
  if (!keyCache.has(k.uri)) {
    keyCache.set(k.uri, crypto.subtle.importKey("raw", await fetchBuf(k.uri), "AES-CBC", false, ["decrypt"]));
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

async function downloadFile() {
  const r = await fetch(url, { signal: ctrl.signal });
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
      if (total) $("bar").value = got / total;
      status(`Скачано ${(got / 1e6).toFixed(1)} МБ` + (total ? ` из ${(total / 1e6).toFixed(1)}` : ""));
    }
    await sink.close();
  } catch (e) { await sink.abort(); throw e; }
}

async function downloadHls() {
  let pl = parsePlaylist(await fetchText(url), url);
  if (pl.master) pl = parsePlaylist(await fetchText(pl.variants[0].url), pl.variants[0].url);
  const segs = pl.segments;
  if (!segs.length) throw new Error("Плейлист пуст");
  const ext = pl.map ? "mp4" : "ts";
  const sink = await openSink(baseName, ext);
  try {
    if (pl.map) await sink.write(await decrypt(await fetchBuf(pl.map.url), { key: pl.map.key, seq: 0 }));
    const CONC = 6;
    const jobs = new Array(segs.length);
    const start = (i) => {
      if (i < segs.length && !jobs[i])
        jobs[i] = fetchBuf(segs[i].url).then((b) => decrypt(b, segs[i]));
    };
    for (let i = 0; i < Math.min(CONC, segs.length); i++) start(i);
    for (let i = 0; i < segs.length; i++) {
      const data = await jobs[i];
      jobs[i] = null; // освобождаем память
      start(i + CONC);
      await sink.write(data);
      $("bar").value = (i + 1) / segs.length;
      status(`Сегмент ${i + 1} из ${segs.length}`);
    }
    await sink.close();
  } catch (e) { await sink.abort(); throw e; }
}

$("start").onclick = async () => {
  $("start").hidden = true;
  $("cancel").hidden = false;
  try {
    await (type === "hls" ? downloadHls() : downloadFile());
    status("Готово");
  } catch (e) {
    status(aborted ? "Отменено" : "Ошибка: " + e.message);
  }
  $("cancel").hidden = true;
};
