// Перехват медиазапросов и хранение списка найденных файлов по вкладкам.
const MIN_FILE_SIZE = 200 * 1024; // отсекаем мелкие фрагменты

const header = (d, name) =>
  (d.responseHeaders || []).find((h) => h.name.toLowerCase() === name)?.value || "";

function classify(d) {
  const ct = header(d, "content-type").toLowerCase();
  const url = d.url.split("#")[0];
  if (/\.m3u8(\?|$)/i.test(url) || /mpegurl/.test(ct)) return "hls";
  if (/\.mpd(\?|$)/i.test(url) || /dash\+xml/.test(ct)) return "dash";
  if (/^video\/(mp2t)/.test(ct)) return null; // сегменты HLS
  if (/^(video|audio)\//.test(ct) || /\.(mp4|webm|mov|mp3|m4a|ogg)(\?|$)/i.test(url)) return "file";
  return null;
}

function totalSize(d) {
  const range = header(d, "content-range");
  const m = range.match(/\/(\d+)$/);
  if (m) return Number(m[1]);
  return Number(header(d, "content-length")) || 0;
}

async function addItem(tabId, item) {
  const key = "tab_" + tabId;
  const data = await chrome.storage.session.get(key);
  const list = data[key] || [];
  if (list.some((i) => i.url === item.url)) return;
  list.push(item);
  await chrome.storage.session.set({ [key]: list });
  chrome.action.setBadgeText({ tabId, text: String(list.length) });
}

chrome.webRequest.onResponseStarted.addListener(
  async (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    const type = classify(d);
    if (!type) return;
    const size = totalSize(d);
    if (type === "file" && size && size < MIN_FILE_SIZE) return;
    let title = "";
    try { title = (await chrome.tabs.get(d.tabId)).title || ""; } catch {}
    addItem(d.tabId, { url: d.url, type, size, title, time: Date.now() });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Сброс списка при переходе на другую страницу
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) {
    chrome.storage.session.remove("tab_" + tabId);
    chrome.action.setBadgeText({ tabId, text: "" });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove("tab_" + tabId));
