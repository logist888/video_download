// Общие функции разбора HLS-плейлистов.
export function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

export async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status + " для " + url);
  return r.text();
}

export function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error("Это не HLS-плейлист");
  const abs = (u) => new URL(u, baseUrl).href;

  if (lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"))) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
        const a = parseAttrs(lines[i].slice(18));
        const uri = lines.slice(i + 1).find((l) => !l.startsWith("#"));
        if (uri) variants.push({
          url: abs(uri),
          bandwidth: Number(a.BANDWIDTH) || 0,
          resolution: a.RESOLUTION || "",
        });
      }
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { master: true, variants };
  }

  const segments = [];
  let key = null, map = null, seq = 0, dur = 0, duration = 0;
  for (const l of lines) {
    if (l.startsWith("#EXT-X-MEDIA-SEQUENCE:")) seq = Number(l.split(":")[1]) || 0;
    else if (l.startsWith("#EXT-X-KEY:")) {
      const a = parseAttrs(l.slice(11));
      key = a.METHOD === "NONE" ? null : { method: a.METHOD, uri: a.URI && abs(a.URI), iv: a.IV };
    } else if (l.startsWith("#EXT-X-MAP:")) {
      const a = parseAttrs(l.slice(11));
      map = { url: abs(a.URI), key };
    } else if (l.startsWith("#EXTINF:")) dur = parseFloat(l.slice(8)) || 0;
    else if (!l.startsWith("#")) {
      segments.push({ url: abs(l), seq: seq++, key });
      duration += dur; dur = 0;
    }
  }
  return { master: false, segments, map, duration };
}

export const fmtTime = (s) => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return (h ? p(h) + ":" : "") + p(m) + ":" + p(x);
};
export const fmtSize = (b) =>
  !b ? "" : b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(1) + " MB";
