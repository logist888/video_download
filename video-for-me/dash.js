// Разбор MPEG-DASH (.mpd): SegmentTemplate (с SegmentTimeline), SegmentList, одиночный BaseURL.
export function parseIso(d) {
  if (!d) return 0;
  const m = d.match(/^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

const kids = (el, name) => [...el.children].filter((c) => c.localName === name);
const kid = (el, name) => kids(el, name)[0];
const withBase = (el, parent) => {
  const b = kid(el, "BaseURL");
  return b ? new URL(b.textContent.trim(), parent).href : parent;
};

export function fillTemplate(tpl, vars) {
  return tpl.replace(/\$(\w*)(?:%0(\d+)d)?\$/g, (m, name, w) => {
    if (name === "") return "$";
    if (!(name in vars)) return m;
    let v = String(vars[name]);
    if (w) v = v.padStart(+w, "0");
    return v;
  });
}

function buildSegments(rep, as, period, base, periodDur) {
  const repId = rep.getAttribute("id");
  const bandwidth = rep.getAttribute("bandwidth");
  const tpls = [kid(rep, "SegmentTemplate"), kid(as, "SegmentTemplate"), kid(period, "SegmentTemplate")].filter(Boolean);
  if (tpls.length) {
    const attr = (n) => {
      for (const t of tpls) { const v = t.getAttribute(n); if (v != null) return v; }
      return null;
    };
    const timeline = tpls.map((t) => kid(t, "SegmentTimeline")).find(Boolean);
    const vars0 = { RepresentationID: repId, Bandwidth: bandwidth };
    const timescale = +attr("timescale") || 1;
    const initTpl = attr("initialization");
    const media = attr("media");
    if (!media) return null;
    const start = attr("startNumber") != null ? +attr("startNumber") : 1;
    const url = (t, v) => new URL(fillTemplate(t, v), base).href;
    const list = [];
    if (timeline) {
      let time = 0, num = start;
      for (const S of kids(timeline, "S")) {
        if (S.getAttribute("t") != null) time = +S.getAttribute("t");
        const d = +S.getAttribute("d");
        let r = +(S.getAttribute("r") || 0);
        if (r < 0) r = Math.max(0, Math.ceil((periodDur * timescale - time) / d) - 1);
        for (let i = 0; i <= r; i++) {
          list.push(url(media, { ...vars0, Number: num, Time: time }));
          num++; time += d;
        }
      }
    } else {
      const dur = +attr("duration");
      if (!dur || !periodDur) return null;
      const count = Math.ceil((periodDur * timescale) / dur);
      for (let i = 0; i < count; i++) list.push(url(media, { ...vars0, Number: start + i, Time: i * dur }));
    }
    return { init: initTpl ? url(initTpl, vars0) : null, list };
  }
  const sl = [kid(rep, "SegmentList"), kid(as, "SegmentList"), kid(period, "SegmentList")].find(Boolean);
  if (sl) {
    const ini = kid(sl, "Initialization");
    return {
      init: ini?.getAttribute("sourceURL") ? new URL(ini.getAttribute("sourceURL"), base).href : null,
      list: kids(sl, "SegmentURL").map((s) => new URL(s.getAttribute("media") || "", base).href),
    };
  }
  // Один файл целиком (on-demand профиль): BaseURL на уровне Representation или SegmentBase
  if (kid(rep, "BaseURL") || kid(rep, "SegmentBase") || kid(as, "SegmentBase")) return { init: null, list: [base] };
  return null;
}

export function parseMpd(text, mpdUrl) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== "MPD") throw new Error("Это не DASH-манифест");
  if (mpd.getAttribute("type") === "dynamic") return { live: true, video: [], audio: [], drm: false };

  const total = parseIso(mpd.getAttribute("mediaPresentationDuration"));
  const mpdBase = withBase(mpd, mpdUrl);
  // Берём самый длинный период, чтобы пропустить рекламные вставки
  const periods = kids(mpd, "Period").map((p) => ({ el: p, dur: parseIso(p.getAttribute("duration")) || total }));
  if (!periods.length) throw new Error("В манифесте нет периодов");
  periods.sort((a, b) => b.dur - a.dur);
  const { el: period, dur: periodDur } = periods[0];
  const periodBase = withBase(period, mpdBase);

  const out = { live: false, drm: false, duration: periodDur, video: [], audio: [] };
  kids(period, "AdaptationSet").forEach((as, ai) => {
    const asBase = withBase(as, periodBase);
    const asDrm = kids(as, "ContentProtection").length > 0;
    kids(as, "Representation").forEach((rep, ri) => {
      const mime = rep.getAttribute("mimeType") || as.getAttribute("mimeType") || "";
      const kind = (as.getAttribute("contentType") || mime.split("/")[0] || "").toLowerCase();
      if (kind !== "video" && kind !== "audio") return;
      if (asDrm || kids(rep, "ContentProtection").length) { out.drm = true; return; }
      const seg = buildSegments(rep, as, period, withBase(rep, asBase), periodDur);
      if (!seg || !seg.list.length) return;
      out[kind].push({
        key: ai + ":" + ri,
        kind,
        mime,
        codecs: rep.getAttribute("codecs") || as.getAttribute("codecs") || "",
        bandwidth: +rep.getAttribute("bandwidth") || 0,
        width: +(rep.getAttribute("width") || as.getAttribute("width")) || 0,
        height: +(rep.getAttribute("height") || as.getAttribute("height")) || 0,
        lang: as.getAttribute("lang") || "",
        segments: seg,
      });
    });
  });
  out.video.sort((a, b) => b.bandwidth - a.bandwidth);
  out.audio.sort((a, b) => b.bandwidth - a.bandwidth);
  return out;
}

export const repLabel = (r) =>
  r.kind === "video"
    ? `${r.width && r.height ? r.width + "x" + r.height : "видео"} — ${Math.round(r.bandwidth / 8000)} KB/s`
    : `${r.lang || "аудио"} — ${Math.round(r.bandwidth / 8000)} KB/s`;

export const repExt = (r) =>
  /webm/.test(r.mime) ? "webm" : r.kind === "audio" ? "m4a" : "mp4";
