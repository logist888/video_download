// Анализ HTML страницы: ищет ссылки на потоки, которые не видны в сетевых запросах
// (видео ещё не запущено, ссылка лежит в JSON внутри скрипта, страница загружена до установки расширения).
(() => {
  const EXT = "m3u8|mpd|mp4|webm|mov|m4a|mp3";
  const URL_RE = new RegExp(
    "https?:(?:\\\\?/){2}[^\\s\"'<>]+?\\.(?:" + EXT + ")(?:\\\\?\\?[^\\s\"'<>]*)?(?=[\"'<>\\s\\\\]|$)", "gi");
  const EXT_RE = new RegExp("\\.(" + EXT + ")(?:$|[?#])", "i");
  const MAX_HTML = 6 * 1024 * 1024;

  const sent = (window.__vfmSent ||= new Set());

  const normalize = (u) =>
    u.replace(/\\\//g, "/").replace(/\\u0026|\\u0x26/gi, "&").replace(/&amp;/g, "&").replace(/\\+$/, "");

  const typeOf = (u) => {
    const m = u.match(EXT_RE);
    if (!m) return null;
    const e = m[1].toLowerCase();
    return e === "m3u8" ? "hls" : e === "mpd" ? "dash" : "file";
  };

  function collect() {
    const found = new Set();
    const add = (raw) => {
      if (!raw) return;
      try {
        const u = new URL(normalize(String(raw).trim()), document.baseURI).href;
        if (/^https?:/.test(u) && typeOf(u)) found.add(u);
      } catch {}
    };

    // 1. Теги плеера
    document.querySelectorAll("video, audio, source").forEach((el) => {
      add(el.currentSrc); add(el.src); add(el.getAttribute("src"));
    });
    // 2. Мета-теги и ссылки
    document
      .querySelectorAll('meta[property^="og:video"], meta[property^="og:audio"], meta[name="twitter:player:stream"]')
      .forEach((m) => add(m.content));
    document.querySelectorAll("a[href]").forEach((a) => add(a.getAttribute("href")));
    // 3. Ссылки внутри HTML и скриптов (JSON-LD, конфиги плееров), в том числе с экранированием \/
    try {
      const html = document.documentElement.outerHTML;
      const text = html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html;
      for (const m of text.matchAll(URL_RE)) add(m[0]);
    } catch {}
    // 4. Уже выполненные запросы страницы (в том числе до установки расширения)
    try {
      performance.getEntriesByType("resource").forEach((e) => add(e.name));
    } catch {}
    return [...found];
  }

  function scan() {
    const fresh = collect().filter((u) => !sent.has(u));
    if (!fresh.length) return;
    fresh.forEach((u) => sent.add(u));
    try {
      chrome.runtime.sendMessage({ type: "found", items: fresh.map((url) => ({ url, type: typeOf(url) })) }).catch(() => {});
    } catch {} // расширение было обновлено, скрипт устарел
  }

  scan();
  if (window.__vfmObserver) return;
  window.__vfmObserver = true;
  setTimeout(scan, 3000); // поздно подгружаемые скрипты
  let timer;
  new MutationObserver((muts) => {
    const relevant = muts.some((m) =>
      [...m.addedNodes].some((n) => n.nodeType === 1 && /^(VIDEO|AUDIO|SOURCE|IFRAME|SCRIPT)$/.test(n.tagName)));
    if (!relevant) return;
    clearTimeout(timer);
    timer = setTimeout(scan, 1000);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
