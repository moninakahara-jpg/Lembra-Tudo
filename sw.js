// Lembra Tudo service worker: offline cache + background checks for due items.
const CACHE = "lembra-tudo-v9";
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
const DAY = 86400000;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  // Network first so updates arrive; cache as fallback for offline use.
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match("./index.html"))));
});

// Minimal IndexedDB access (the page mirrors its data here so the worker can read it).
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("lembra-tudo", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", mode);
      const req = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

function daysLeft(date) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(date + "T00:00:00") - t) / DAY);
}

const TXT = {
  pt: { al: { h1: "em 1 hora", d0: "hoje", d1: "amanhã", d2: "em 2 dias", d7: "em 1 semana" }, at: "às", tap: "Toque para abrir o Lembra Tudo.",
        ago: n => `venceu há ${n} dia${n > 1 ? "s" : ""}`, today: "vence hoje", tomorrow: "vence amanhã", inD: n => `vence em ${n} dias` },
  es: { al: { h1: "en 1 hora", d0: "hoy", d1: "mañana", d2: "en 2 días", d7: "en 1 semana" }, at: "a las", tap: "Toca para abrir Lembra Tudo.",
        ago: n => `venció hace ${n} día${n > 1 ? "s" : ""}`, today: "vence hoy", tomorrow: "vence mañana", inD: n => `vence en ${n} días` },
  en: { al: { h1: "in 1 hour", d0: "today", d1: "tomorrow", d2: "in 2 days", d7: "in 1 week" }, at: "at", tap: "Tap to open Lembra Tudo.",
        ago: n => `expired ${n} day${n > 1 ? "s" : ""} ago`, today: "is due today", tomorrow: "is due tomorrow", inD: n => `is due in ${n} days` },
  zh: { al: { h1: "1小时后", d0: "今天", d1: "明天", d2: "2天后", d7: "1周后" }, at: "", tap: "点按打开 Lembra Tudo。",
        ago: n => `已过期${n}天`, today: "今天到期", tomorrow: "明天到期", inD: n => `还有${n}天到期` }
};

async function checkDue() {
  const items = (await idb("readonly", s => s.get("items"))) || [];
  const sent = (await idb("readonly", s => s.get("sent"))) || {};
  const todayKey = new Date().toISOString().slice(0, 10);
  // Compromissos: cada alerta escolhido (até 3) dispara uma vez, no horário dele.
  const now = new Date();
  const AL = { h1: 60, d1: 1440, d2: 2880, d7: 10080 };
  const lang = (await idb("readonly", st => st.get("lang"))) || "pt";
  const T = TXT[lang] || TXT.pt;
  const LBL = T.al;
  let count = 0;
  for (const it of items.filter(i => !i.example && i.type === "appt")) {
    const start = new Date(it.date + "T" + (it.time || "09:00") + ":00");
    if (start < now) continue;
    for (const k of (it.alerts || []).slice(0, 3)) {
      let at;
      if (k === "d0") { at = new Date(start); at.setHours(8, 0, 0, 0); if (at > start) at = start; }
      else at = new Date(start.getTime() - (AL[k] || 0) * 60000);
      const key = it.id + ":" + k + ":" + it.date + "T" + (it.time || "");
      if (now >= at && !sent[key]) {
        await self.registration.showNotification(`${it.name} ${LBL[k] || ""} ${T.at} ${it.time || "09:00"}`.replace(/\s+/g, " "), {
          body: T.tap, icon: "icon-192.png", badge: "icon-192.png", tag: "lt-" + key, data: { url: "./" }
        });
        sent[key] = todayKey; count++;
      }
    }
  }
  const due = items.filter(i => !i.example && i.type !== "appt" && daysLeft(i.date) <= (i.warn ?? 7) && sent[i.id] !== todayKey);
  for (const it of due) {
    const d = daysLeft(it.date);
    const when = d < 0 ? T.ago(-d) : d === 0 ? T.today : d === 1 ? T.tomorrow : T.inD(d);
    await self.registration.showNotification(`${it.name} ${when}`, {
      body: T.tap,
      icon: "icon-192.png", badge: "icon-192.png", tag: "lt-" + it.id, data: { url: "./" }
    });
    sent[it.id] = todayKey;
  }
  await idb("readwrite", s => s.put(sent, "sent"));
  return due.length + count;
}

// Android Chrome (installed app): the browser wakes the worker about once a day.
self.addEventListener("periodicsync", e => { if (e.tag === "lembra-check") e.waitUntil(checkDue()); });
// The page asks for a check whenever it opens.
self.addEventListener("message", e => { if (e.data === "check") e.waitUntil(checkDue()); });

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then(list => list.length ? list[0].focus() : self.clients.openWindow("./")));
});
