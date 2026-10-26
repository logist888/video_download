import { fetchText, parsePlaylist, fmtTime, fmtSize } from "./hls.js";
import { parseMpd, repLabel } from "./dash.js";

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");

function openDownloader(url, type, name, extra = {}) {
  const q = new URLSearchParams({ u: url, t: type, n: name, ...extra });
  chrome.tabs.create({ url: chrome.runtime.getURL("downloader.html?" + q) });
}

function cleanName(title, type) {
  const base = (title || "video").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 100) || "video";
  return base;
}

async function render(item) {
  const card = document.createElement("div");
  card.className = "card";
  const name = cleanName(item.title, item.type);
  card.innerHTML = `<div class="row"><span class="badge">${item.type.toUpperCase()}</span>
    <span class="title" title="${name.replace(/"/g, "&quot;")}">${name}</span></div>
    <div class="meta"></div><div class="row"><select></select>
    <button class="primary">Скачать</button></div>`;
  const meta = card.querySelector(".meta");
  const sel = card.querySelector("select");
  const btn = card.querySelector("button");
  listEl.appendChild(card);

  if (item.type === "dash") {
    try {
      const m = parseMpd(await fetchText(item.url), item.url);
      if (m.live) throw new Error("прямые трансляции не поддерживаются");
      if (!m.video.length && !m.audio.length)
        throw new Error(m.drm ? "DRM, скачать нельзя" : "дорожки не найдены");
      meta.textContent = (m.duration ? fmtTime(m.duration) : "") + (m.drm ? " · часть дорожек с DRM пропущена" : "");
      const fill = (select, reps, none) => {
        if (none) select.add(new Option(none, ""));
        reps.forEach((r) => select.add(new Option(repLabel(r), r.key)));
        if (!reps.length && !none) select.hidden = true;
      };
      fill(sel, m.video, null);
      if (!m.video.length) sel.hidden = true;
      const asel = document.createElement("select");
      fill(asel, m.audio, m.video.length ? "— без аудио —" : null);
      if (!m.audio.length) asel.hidden = true;
      if (m.audio.length && m.video.length) asel.value = m.audio[0].key;
      const brow = btn.parentElement;
      for (const x of [sel, asel]) {
        const r = document.createElement("div");
        r.className = "row";
        r.style.marginBottom = "6px";
        r.append(x);
        card.insertBefore(r, brow);
      }
      btn.style.flex = "1";
      btn.onclick = () =>
        openDownloader(item.url, "dash", name, { v: m.video.length ? sel.value : "", a: asel.hidden ? "" : asel.value });
    } catch (e) {
      meta.textContent = "Ошибка: " + e.message;
      sel.hidden = btn.hidden = true;
    }
    return;
  }
  if (item.type === "file") {
    meta.textContent = fmtSize(item.size) || "размер неизвестен";
    sel.hidden = true;
    btn.onclick = () => openDownloader(item.url, "file", name);
    return;
  }
  // HLS
  try {
    const pl = parsePlaylist(await fetchText(item.url), item.url);
    let probe = pl;
    if (pl.master) {
      for (const v of pl.variants) {
        const o = document.createElement("option");
        o.value = v.url;
        o.textContent = `${v.resolution || "?"} — ${Math.round(v.bandwidth / 8000)} KB/s`;
        sel.appendChild(o);
      }
      probe = parsePlaylist(await fetchText(pl.variants[0].url), pl.variants[0].url);
    } else {
      sel.hidden = true;
    }
    meta.textContent = probe.duration ? fmtTime(probe.duration) : "";
    if (probe.segments?.some((s) => s.key && s.key.method !== "AES-128")) {
      meta.textContent += " · DRM, скачать нельзя";
      btn.disabled = true;
    }
    btn.onclick = () => openDownloader(pl.master ? sel.value : item.url, "hls", name);
  } catch (e) {
    meta.textContent = "Ошибка: " + e.message;
    sel.hidden = btn.hidden = true;
  }
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const key = "tab_" + tab.id;
const data = await chrome.storage.session.get(key);
const items = (data[key] || []).slice().reverse();
if (!items.length) emptyEl.hidden = false;
for (const it of items) await render(it);
