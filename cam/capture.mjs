// ユキヨミ ライブカメラの定時撮影（私用）— Google Cloud Run ジョブで 7時・11時・15時（日本時間）に実行する
// 撮った画像は非公開の Cloud Storage バケットに保存し、自分のアカウントでだけ見られる閲覧ページ（index.html）を作る。
// 画像はどこにも公開しない。撮影対象は公開サイトの index.html にある SITES から読む（一覧を二重に持たないため）。
//   c.e = [top, h] … ページを幅360pxで開き、上から top〜top+h の範囲を撮る
//   c.y = [[YouTubeID, ラベル], …] … 配信のサムネイル画像を保存する
//   c.i = [[画像URL, ラベル], …] … カメラ画像のファイルを直接置いているものはそのまま保存する
//   c.s = "rusutsu" … 個別設定で撮るカメラ（下の SPECIAL）
// 環境変数: BUCKET（保存先。未設定ならローカルの out/ に書くだけ）、SITE_URL（撮影対象の読み出し元）
import { chromium } from "playwright";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";

const OUT = process.env.OUT || "out";
const BUCKET = process.env.BUCKET || "";
const SITE_URL = process.env.SITE_URL || "https://msmttng.github.io/yukiyomi/index.html";
const KEEP_DAYS = 7;
const W = 360;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const SPECIAL = {
  rusutsu: { top: 330, height: 390, width: 390, wait: 8000 },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const short = (e) => String(e && e.message ? e.message : e).split("\n")[0].slice(0, 200);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// 日本時間の撮影枠名（例 20261125-0700）と表示用の時刻
const jst = new Date(Date.now() + 9 * 3600e3);
const p2 = (n) => String(n).padStart(2, "0");
const SLOT = process.env.SLOT || `${jst.getUTCFullYear()}${p2(jst.getUTCMonth() + 1)}${p2(jst.getUTCDate())}-${p2(jst.getUTCHours())}${p2(jst.getUTCMinutes())}`;
const slotLabel = (s) => `${+s.slice(4, 6)}/${+s.slice(6, 8)} ${s.slice(9, 11)}:${s.slice(11, 13)}`;

// ---- 撮影対象を公開サイトの index.html から作る（取れなければ同梱の index.html） ----
let html = "";
try {
  const r = await fetch(SITE_URL + "?t=" + Date.now(), { headers: { "User-Agent": UA } });
  if (r.ok) html = await r.text();
} catch {}
if (!/const SITES = /.test(html)) html = await readFile(new URL("./index.html", import.meta.url), "utf8");
const SITES = JSON.parse(html.match(/const SITES = (\{.*?\});\n/s)[1]);
const R = [...html.matchAll(/^\s*\["([\w-]+)","([^"]+)","([^"]+)","([^"]+)",/gm)].map((m) => ({ id: m[1], name: m[2], pref: m[3], area: m[4] }));

const pages = []; // { key, url, top, height, width, wait }
const tubes = new Set();
const images = [];
const meta = {}; // key -> { rid, label, link }
for (const [rid, st] of Object.entries(SITES)) {
  (st.cams || []).forEach((c, i) => {
    if (c.e) { pages.push({ key: `${rid}-${i}`, url: c.u, top: c.e[0], height: c.e[1], width: W, wait: 7000 }); meta[`${rid}-${i}`] = { rid, label: c.l, link: c.u }; }
    if (c.s && SPECIAL[c.s]) { pages.push({ key: c.s, url: c.u, ...SPECIAL[c.s] }); meta[c.s] = { rid, label: c.l, link: c.u }; }
    (c.y || []).forEach(([id, lb]) => { tubes.add(id); meta[`yt-${id}`] ||= { rid, label: lb || c.l, link: `https://www.youtube.com/watch?v=${id}` }; });
    (c.i || []).forEach(([u, lb], n) => { images.push({ key: `${rid}-i${n}`, url: u }); meta[`${rid}-i${n}`] = { rid, label: lb || c.l, link: c.p || c.u }; });
  });
}
console.log(`slot ${SLOT} / pages ${pages.length} / youtube ${tubes.size} / images ${images.length}`);

await mkdir(OUT, { recursive: true });
const shots = {};

// ---- YouTube：配信のサムネイル（ライブ中は数分おきに更新される）を保存 ----
for (const id of tubes) {
  const key = `yt-${id}`;
  let saved = false, err = "";
  for (const name of ["hqdefault_live", "mqdefault_live", "hqdefault"]) {
    try {
      const r = await fetch(`https://i.ytimg.com/vi/${id}/${name}.jpg`, { headers: { "User-Agent": UA } });
      if (!r.ok) { err = `${name} ${r.status}`; continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 2000) { err = `${name} too small`; continue; }
      await writeFile(`${OUT}/${key}.jpg`, buf);
      shots[key] = { ok: true, at: now(), src: name };
      saved = true;
      console.log(`OK   ${key} (${name})`);
      break;
    } catch (e) { err = short(e); }
  }
  if (!saved) { shots[key] = { ok: false, at: now(), error: err }; console.log(`FAIL ${key}: ${err}`); }
}

// ---- 画像ファイル型：そのまま保存 ----
for (const t of images) {
  try {
    const r = await fetch(t.url + (t.url.includes("?") ? "&" : "?") + "t=" + Date.now(), { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2000) throw new Error("too small");
    await writeFile(`${OUT}/${t.key}.jpg`, buf);
    shots[t.key] = { ok: true, at: now(), modified: r.headers.get("last-modified") || undefined };
    console.log(`OK   ${t.key}`);
  } catch (e) { shots[t.key] = { ok: false, at: now(), error: short(e) }; console.log(`FAIL ${t.key}: ${short(e)}`); }
}

// ---- ページ型：開いて切り出して撮影（4枚ずつ並行） ----
const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
async function shoot(t) {
  const context = await browser.newContext({
    viewport: { width: t.width, height: Math.max(800, t.top + t.height + 300) },
    deviceScaleFactor: 1.5,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    userAgent: UA,
  });
  const page = await context.newPage();
  try {
    await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(t.wait);
    await page.evaluate(() => {
      document.querySelectorAll("video").forEach((v) => {
        try { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch {}
      });
    }).catch(() => {});
    // 後から読み込まれる画像のため、いったん下までスクロールして戻す
    await Promise.race([sleep(10000), page.evaluate(async () => {
      for (let y = 0; y < Math.min(document.documentElement.scrollHeight, 6000); y += 400) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 150)); }
      window.scrollTo(0, 0);
    }).catch(() => {})]);
    await sleep(2500);
    // 配信元に画像がない（skiday の「表示できる画像がありません」）ときは保存しない
    const txt = await Promise.race([sleep(5000).then(() => ""), page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => "")]);
    if (/表示できる画像がありません/.test(txt)) throw new Error("配信元に画像なし");
    // ページ内の YouTube・skiday の埋め込みを記録（撮影がうまくいかないカメラを差し替える手がかり）
    const found = new Set();
    const pick = (s) => {
      const y = String(s).match(/(?:youtube(?:-nocookie)?\.com\/(?:embed|live)\/|youtu\.be\/|[?&]v=)([\w-]{11})/);
      if (y) found.add("yt:" + y[1]);
      const k = String(s).match(/skiday\.app\/\w+\/\w+\/embed/);
      if (k) found.add("https://" + k[0]);
    };
    page.frames().forEach((f) => pick(f.url()));
    const attrs = await Promise.race([sleep(8000).then(() => []), page.evaluate(() =>
      [...document.querySelectorAll("iframe,a,[data-src],[data-video-id],[data-youtube-id]")].map((n) =>
        [n.getAttribute("src"), n.getAttribute("data-src"), n.getAttribute("href"), n.getAttribute("data-video-id") && "v=" + n.getAttribute("data-video-id"), n.getAttribute("data-youtube-id") && "v=" + n.getAttribute("data-youtube-id")].filter(Boolean).join(" ")
      )
    ).catch(() => [])]);
    attrs.forEach((a) => a.split(" ").forEach(pick));
    const bigImgs = await Promise.race([sleep(5000).then(() => []), page.evaluate(() =>
      [...document.images].filter((i) => i.naturalWidth >= 300).map((i) => `img:${i.naturalWidth}x${i.naturalHeight}@${Math.round(i.getBoundingClientRect().top + scrollY)} ${i.currentSrc.split("?")[0]}`).slice(0, 6)
    ).catch(() => [])]);
    bigImgs.forEach((x) => found.add(x));
    t.found = [...found].slice(0, 12);
    // skiday の積雪カメラは元画像をそのまま保存（余白や再生バーが入らない）
    if (/skiday\.app/.test(t.url)) {
      const src = await Promise.race([sleep(5000).then(() => ""), page.evaluate(() => {
        const im = [...document.images].filter((i) => /camera_images/.test(i.currentSrc) && i.naturalWidth >= 300).sort((a, b) => b.naturalWidth - a.naturalWidth)[0];
        return im ? im.currentSrc : "";
      }).catch(() => "")]);
      if (src) {
        const r = await fetch(src, { headers: { "User-Agent": UA } });
        if (r.ok) {
          await writeFile(`${OUT}/${t.key}.jpg`, Buffer.from(await r.arrayBuffer()));
          shots[t.key] = { ok: true, at: now(), found: t.found, via: "skiday-image" };
          console.log(`OK   ${t.key} (skiday image)`);
          return;
        }
      }
    }
    // 切り出し範囲の中で一番大きい画像・映像があれば、その部分だけを撮る
    const rect = await Promise.race([sleep(5000).then(() => null), page.evaluate(({ top, height, width }) => {
      let best = null, ba = 0;
      for (const el of document.querySelectorAll("img,video,canvas")) {
        const r = el.getBoundingClientRect(), y = r.top + scrollY;
        const w = Math.min(r.right, width) - Math.max(r.left, 0), hh = r.height;
        if (w < width * 0.5 || hh < 80) continue;
        const ov = Math.min(y + hh, top + height) - Math.max(y, top);
        if (ov < hh * 0.6) continue;
        if (w * hh > ba) { ba = w * hh; best = { x: Math.max(r.left, 0), y, w, h: Math.min(hh, top + height + 40 - y) }; }
      }
      return best;
    }, { top: t.top, height: t.height, width: t.width }).catch(() => null)]);
    if (rect && rect.h >= 60) {
      await page.screenshot({ path: `${OUT}/${t.key}.jpg`, type: "jpeg", quality: 70, fullPage: true,
        clip: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.w), height: Math.round(rect.h) } });
      shots[t.key] = { ok: true, at: now(), found: t.found, via: "element" };
      console.log(`OK   ${t.key} (element)`);
      return;
    }
    const sh = await page.evaluate(() => document.documentElement.scrollHeight);
    const height = Math.floor(Math.min(t.height, sh - t.top));
    if (!(height >= 1)) throw new Error(`clip height invalid (scrollHeight=${sh}, top=${t.top})`);
    await page.screenshot({
      path: `${OUT}/${t.key}.jpg`, type: "jpeg", quality: 70,
      clip: { x: 0, y: t.top, width: t.width, height }, fullPage: true,
    });
    shots[t.key] = { ok: true, at: now(), found: t.found, via: "crop" };
    console.log(`OK   ${t.key} (crop)`);
  } catch (e) {
    shots[t.key] = { ok: false, at: now(), error: short(e), found: t.found };
    console.log(`FAIL ${t.key}: ${short(e)}`);
  } finally {
    await context.close().catch(() => {});
  }
}
const queue = [...pages];
// 1ページ最大70秒で打ち切る（応答しないページで全体が止まらないように）
const guarded = (t) => Promise.race([shoot(t), sleep(70000).then(() => {
  if (!shots[t.key]) { shots[t.key] = { ok: false, at: now(), error: "timeout 70s", found: t.found }; console.log(`FAIL ${t.key}: timeout`); }
})]);
await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await guarded(queue.shift()); }));
// 一時的な失敗（時間切れなど）は1回だけ撮り直す。配信元に画像がないものは撮り直さない
const retry = pages.filter((t) => shots[t.key] && !shots[t.key].ok && !/配信元に画像なし/.test(shots[t.key].error || ""));
if (retry.length) console.log(`retry ${retry.length}`);
for (const t of retry) { delete shots[t.key]; await guarded(t); }
await Promise.race([browser.close(), sleep(15000)]);


const ok = Object.values(shots).filter((s) => s.ok).length;
console.log(`done: ${ok}/${Object.keys(shots).length} ok`);

// ---- 閲覧ページ（自分用） ----
function viewer(slot, base, slots) {
  const byRid = {};
  for (const [key, m] of Object.entries(meta)) (byRid[m.rid] ||= []).push(key);
  let body = "", lastPref = "", lastArea = "";
  for (const r of R) {
    const keys = byRid[r.id];
    if (!keys) continue;
    if (r.pref !== lastPref) { body += `<h2>${esc(r.pref)}</h2>`; lastPref = r.pref; lastArea = ""; }
    if (r.area !== lastArea) { body += `<h3>${esc(r.area)}</h3>`; lastArea = r.area; }
    body += `<section><h4>${esc(r.name)}</h4><div class="g">`;
    for (const k of keys) {
      const m = meta[k], s = shots[k];
      const img = s && s.ok ? `<img loading="lazy" src="${base}${k}.jpg" alt="">` : `<div class="ng">撮影できませんでした</div>`;
      body += `<a class="t" href="${esc(m.link)}" target="_blank" rel="noopener">${img}<span>${esc(m.label)}</span></a>`;
    }
    body += `</div></section>`;
  }
  const nav = slots.map((s) => s === slot ? `<b>${slotLabel(s)}</b>` : `<a href="${base === "" ? "../" + s + "/" : "archive/" + s + "/"}index.html">${slotLabel(s)}</a>`).join(" ");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>ユキヨミ 撮影画像（自分用）</title><style>
body{font-family:-apple-system,"Hiragino Sans",sans-serif;margin:0;background:#f4f7fb;color:#123}
header{position:sticky;top:0;background:#0b3d6e;color:#fff;padding:10px 14px;z-index:1}
header b{font-size:17px}header small{display:block;opacity:.85;margin-top:2px}
nav{padding:8px 14px;font-size:13px;line-height:1.9;background:#fff;border-bottom:1px solid #dde}nav a{color:#0b5cad;margin-right:6px}nav b{margin-right:6px}
main{padding:0 12px 40px}h2{margin:18px 0 4px;font-size:18px}h3{margin:12px 0 4px;font-size:14px;color:#456}
section{background:#fff;border-radius:10px;padding:8px 10px;margin:8px 0;box-shadow:0 1px 3px #0001}h4{margin:2px 0 8px;font-size:15px}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px}
@media(min-width:900px){.g{grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}}
.t{display:block;text-decoration:none;color:#123;font-size:12px}.t img,.ng{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:6px;background:#dfe6ee;display:block}
.ng{display:flex;align-items:center;justify-content:center;color:#789}.t span{display:block;margin-top:3px}
footer{font-size:11px;color:#678;padding:0 14px 30px}
</style></head><body><header><b>ユキヨミ 撮影画像（自分用）</b><small>${slotLabel(slot)} 撮影 ・ ${ok} 枚 ・ 画像をタップするとライブカメラを開きます</small></header>
<nav>${nav}</nav><main>${body}</main><footer>各カメラの画像の権利は配信元にあります。このページは私的な閲覧専用で、公開していません。</footer></body></html>`;
}

if (!BUCKET) {
  await writeFile(`${OUT}/index.json`, JSON.stringify({ slot: SLOT, generatedAt: now(), shots }, null, 2), "utf8");
  await writeFile(`${OUT}/index.html`, viewer(SLOT, "", [SLOT]), "utf8");
  process.exit(ok === 0 ? 1 : 0);
}

// ---- Cloud Storage へ保存（非公開バケット） ----
const { Storage } = await import("@google-cloud/storage");
const bucket = new Storage().bucket(BUCKET);
const NOCACHE = "private, max-age=0, no-cache";
const files = (await readdir(OUT)).filter((f) => f.endsWith(".jpg"));
const pool = [...files];
await Promise.all(Array.from({ length: 8 }, async () => {
  while (pool.length) {
    const f = pool.shift();
    await bucket.upload(`${OUT}/${f}`, { destination: `archive/${SLOT}/${f}`, metadata: { contentType: "image/jpeg", cacheControl: "private, max-age=86400" } });
  }
}));
// 残っている撮影枠（新しい順）。古いものはバケットの自動削除ルールでも消える
const [, , apiResp] = await bucket.getFiles({ prefix: "archive/", delimiter: "/", autoPaginate: false });
const cutoff = Date.now() + 9 * 3600e3 - KEEP_DAYS * 86400e3;
let slots = (apiResp.prefixes || []).map((p) => p.split("/")[1]).filter((s) => /^\d{8}-\d{4}$/.test(s));
slots = [...new Set([...slots, SLOT])].filter((s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) >= cutoff - 86400e3).sort().reverse();
const put = (name, text, type) => bucket.file(name).save(text, { contentType: type, metadata: { cacheControl: NOCACHE }, resumable: false });
await put(`archive/${SLOT}/index.json`, JSON.stringify({ slot: SLOT, generatedAt: now(), shots }, null, 2), "application/json; charset=utf-8");
await put(`archive/${SLOT}/index.html`, viewer(SLOT, "", slots), "text/html; charset=utf-8");
await put(`index.html`, viewer(SLOT, `archive/${SLOT}/`, slots), "text/html; charset=utf-8");
console.log(`uploaded ${files.length} images to gs://${BUCKET}/archive/${SLOT}/`);
process.exit(ok === 0 ? 1 : 0);
