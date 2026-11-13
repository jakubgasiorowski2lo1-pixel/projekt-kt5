/* Harmonogram KT5: wykres Gantta bez backendu.
   Odczyt: GitHub Contents API (fallback: ./data.json).
   Zapis: PUT do Contents API, każda zmiana = commit. Przy konflikcie (409/422)
   pobieramy świeże dane i nakładamy zmianę ponownie. */
(function () {
  "use strict";

  const CFG = Object.assign({ branch: "main", path: "data.json", riskThreshold: 30 }, window.KT5_CONFIG || {});
  const TOKEN_KEY = "kt5_token";
  const DAY = 86400000;
  const LABEL_W = 300;

  const S = {
    data: null, sha: null, source: "",
    token: localStorage.getItem(TOKEN_KEY) || "",
    user: null, canPush: false,
    editing: null, // id zadania w dialogu (null = nowe)
    busy: false
  };

  // ---------- repo ----------
  function detectRepo() {
    let owner = CFG.owner, repo = CFG.repo;
    const host = location.hostname;
    if ((!owner || !repo) && host.endsWith(".github.io")) {
      owner = owner || host.replace(/\.github\.io$/, "");
      const seg = location.pathname.split("/").filter(Boolean)[0];
      repo = repo || seg || (owner + ".github.io");
    }
    return { owner: owner || CFG.fallbackOwner, repo: repo || CFG.fallbackRepo };
  }
  const REPO = detectRepo();
  const API = "https://api.github.com";
  const contentsUrl = () => `${API}/repos/${REPO.owner}/${REPO.repo}/contents/${CFG.path}`;

  function headers(json) {
    const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (S.token) h.Authorization = "token " + S.token;
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  // UTF-8 <-> base64
  function b64decode(b64) {
    const bin = atob(b64.replace(/\s/g, ""));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function fetchRemote() {
    const r = await fetch(`${contentsUrl()}?ref=${encodeURIComponent(CFG.branch)}&t=${Date.now()}`, { headers: headers(), cache: "no-store" });
    if (!r.ok) {
      const e = new Error(`GitHub API: ${r.status}`);
      e.status = r.status;
      throw e;
    }
    const j = await r.json();
    return { data: normalize(JSON.parse(b64decode(j.content))), sha: j.sha };
  }

  async function loadData() {
    try {
      const { data, sha } = await fetchRemote();
      S.data = data; S.sha = sha; S.source = "api";
    } catch (e) {
      console.warn("Odczyt przez API nie powiódł się, używam ./data.json", e);
      const r = await fetch("data.json?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error("Nie udało się wczytać data.json");
      S.data = normalize(await r.json()); S.sha = null; S.source = "file";
    }
    console.info(`[KT5] dane wczytane z: ${S.source === "api" ? "GitHub API" : "pliku data.json"} (${REPO.owner}/${REPO.repo})`);
    document.body.dataset.source = S.source;
  }

  function normalize(d) {
    d.project = d.project || {};
    d.team = d.team || [];
    d.tasks = (d.tasks || []).map(t => Object.assign({
      type: "task", owners: [], progress: 0, notes: "",
      baselineStart: t.start, baselineEnd: t.end
    }, t));
    d.tasks.forEach(t => {
      if (t.type === "buffer") { t.extraDays = t.extraDays || 0; }
    });
    d.history = d.history || [];
    return d;
  }

  /** Zapis: pobierz świeże dane, nałóż zmianę (mutate), wyślij PUT. Ponów przy konflikcie. */
  async function saveChange(text, mutate) {
    if (!S.token) { openLogin(); throw new Error("Zaloguj się, aby zapisywać."); }
    if (S.busy) throw new Error("Poprzedni zapis jeszcze trwa.");
    S.busy = true; showMsg("Zapisywanie…", "info");
    try {
      for (let attempt = 1; attempt <= 4; attempt++) {
        const fresh = await fetchRemote();
        mutate(fresh.data);
        fresh.data.history.unshift({ ts: new Date().toISOString(), user: S.user ? S.user.login : "?", text });
        fresh.data.history = fresh.data.history.slice(0, 3000);
        sortTasks(fresh.data);
        const body = {
          message: `[harmonogram] ${text}`.slice(0, 200),
          content: b64encode(JSON.stringify(fresh.data, null, 2) + "\n"),
          sha: fresh.sha,
          branch: CFG.branch
        };
        const r = await fetch(contentsUrl(), { method: "PUT", headers: headers(true), body: JSON.stringify(body) });
        if (r.ok) {
          const j = await r.json();
          S.data = fresh.data; S.sha = j.content.sha; S.source = "api";
          render();
          showMsg("Zapisano: " + text, "ok", 4000);
          return;
        }
        if (r.status === 409 || r.status === 422) {
          console.warn(`Konflikt zapisu (${r.status}), próba ${attempt}`);
          await new Promise(res => setTimeout(res, 400 * attempt));
          continue;
        }
        if (r.status === 401) throw new Error("Token nieprawidłowy lub wygasł. Zaloguj się ponownie.");
        if (r.status === 403 || r.status === 404) throw new Error("Brak uprawnień do zapisu. Sprawdź, czy przyjąłeś zaproszenie jako Collaborator i czy token ma zakres public_repo.");
        throw new Error("Błąd zapisu: " + r.status);
      }
      throw new Error("Nie udało się zapisać po kilku próbach (konflikty). Odśwież i spróbuj ponownie.");
    } catch (e) {
      showMsg(e.message, "err");
      throw e;
    } finally {
      S.busy = false;
    }
  }

  // ---------- daty ----------
  const toDay = s => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY);
  const fromDay = n => new Date(n * DAY).toISOString().slice(0, 10);
  const todayDay = () => { const d = new Date(); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY); };
  const fmt = s => { const [y, m, d] = s.split("-"); return `${+d}.${m}.${y}`; };
  const fmtShort = s => { const [, m, d] = s.split("-"); return `${+d}.${m}`; };
  const MONTHS = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
  const dayCount = (a, b) => toDay(b) - toDay(a) + 1;
  const plural = (n, one, few, many) => {
    const a = Math.abs(n);
    if (a === 1) return one;
    if (a % 10 >= 2 && a % 10 <= 4 && (a % 100 < 10 || a % 100 >= 20)) return few;
    return many;
  };
  const days = n => `${n} ${plural(n, "dzień", "dni", "dni")}`;

  // ---------- logika zadań ----------
  function cmpId(a, b) {
    const isB = x => /^[A-Za-z]/.test(x);
    if (isB(a) !== isB(b)) return isB(a) ? 1 : -1;
    const pa = a.split("."), pb = b.split(".");
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if (pa[i] === undefined) return -1;
      if (pb[i] === undefined) return 1;
      const c = pa[i].localeCompare(pb[i], "pl", { numeric: true });
      if (c) return c;
    }
    return 0;
  }
  function sortTasks(d) { d.tasks.sort((x, y) => cmpId(x.id, y.id)); }

  function taskInfo(t) {
    const today = todayDay();
    const s = toDay(t.start), e = toDay(t.end), be = toDay(t.baselineEnd || t.end);
    const info = { slipDays: Math.max(0, e - be), lateDays: 0, expected: 0, status: "ok" };
    if (t.type === "buffer") {
      const b = bufferState(S.data)[t.id] || { used: 0, capacity: 0 };
      info.status = b.used > b.capacity ? "late" : "buffer";
      return info;
    }
    info.expected = today < s ? 0 : today >= e ? 100 : Math.round((today - s + 1) / (e - s + 1) * 100);
    if (t.progress >= 100) info.status = "done";
    else if (today > e) { info.status = "late"; info.lateDays = today - e; }
    else if (info.expected - t.progress >= CFG.riskThreshold) info.status = "risk";
    return info;
  }
  // ---------- bufory (liczone automatycznie) ----------
  // Jednostka: dni zajęć (piątki z project.classDays, bez project.noClassDates).
  // Gdy projekt nie ma dni zajęć, liczone są dni kalendarzowe.
  function countWork(d, a, b) {
    if (a > b) return 0;
    const cls = d.project.classDays;
    if (!cls || !cls.length) return b - a + 1;
    const off = d.project.noClassDates || [];
    let n = 0;
    for (let x = a; x <= b; x++) if (cls.includes(new Date(x * DAY).getUTCDay()) && !off.includes(fromDay(x))) n++;
    return n;
  }
  const workUnit = (d, n) => (d.project.classDays && d.project.classDays.length)
    ? `${n} ${plural(n, "piątek", "piątki", "piątków")}` : days(n);

  function bufferFor(d, t, buffers) {
    if (t.buffer === "none") return null;
    if (t.buffer && buffers.some(b => b.id === t.buffer)) return t.buffer;
    if (!buffers.length) return null;
    const be = toDay(t.baselineEnd || t.end);
    const after = buffers.find(b => toDay(b.end) >= be);
    return (after || buffers[buffers.length - 1]).id;
  }

  /** Zużycie buforów: obsuwy (koniec później niż w planie), opóźnienie bieżące
      (minęła data końca, a zadanie nieukończone) i zadania niezaplanowane. */
  function bufferState(d) {
    if (d._buf && d._bufKey === bufKey(d)) return d._buf;
    const buffers = d.tasks.filter(t => t.type === "buffer");
    const res = {};
    buffers.forEach(b => res[b.id] = {
      capacity: countWork(d, toDay(b.start), toDay(b.end)), used: b.extraDays || 0,
      items: b.extraDays ? [{ taskId: "", name: "dodane ręcznie", days: b.extraDays, reason: "ręcznie" }] : []
    });
    const today = todayDay();
    const isParent = t => d.tasks.some(x => x.id.startsWith(t.id + "."));
    d.tasks.filter(t => t.type !== "buffer" && !isParent(t)).forEach(t => {
      const bid = bufferFor(d, t, buffers);
      if (!bid) return;
      const add = (n, reason) => { if (n > 0) { res[bid].used += n; res[bid].items.push({ taskId: t.id, name: t.name, days: n, reason }); } };
      const e = toDay(t.end), be = toDay(t.baselineEnd || t.end);
      if (t.unplanned) add(countWork(d, toDay(t.start), e), "zadanie niezaplanowane");
      else add(countWork(d, be + 1, e), "obsuwa terminu");
      if (t.progress < 100 && today > e) add(countWork(d, e + 1, today), "po terminie, nieukończone");
    });
    Object.defineProperty(d, "_buf", { value: res, writable: true, configurable: true });
    Object.defineProperty(d, "_bufKey", { value: bufKey(d), writable: true, configurable: true });
    return res;
  }
  function bufKey(d) { return todayDay() + "|" + JSON.stringify(d.tasks) + JSON.stringify(d.project); }

  const STATUS_LABEL = { ok: "w toku", done: "ukończone", late: "po terminie", risk: "zagrożone", buffer: "bufor" };

  function person(id) { return S.data.team.find(p => p.id === id); }
  function ownersLabel(t) {
    const ids = t.owners || [];
    const students = S.data.team.filter(p => p.id !== "p").map(p => p.id);
    if (students.length && students.every(id => ids.includes(id))) return "cały zespół";
    return ids.map(id => (person(id) || { name: id }).name).join(", ");
  }
  function taskColor(t) {
    if (t.type === "buffer") return "#94a3b8";
    if ((t.owners || []).length === 1) { const p = person(t.owners[0]); if (p && p.color) return p.color; }
    return "#3b82f6";
  }

  // ---------- render ----------
  const $ = sel => document.querySelector(sel);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "style") n.style.cssText = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v);
    }
    kids.flat().forEach(k => n.append(k instanceof Node ? k : document.createTextNode(String(k))));
    return n;
  };

  function render() {
    const d = S.data;
    document.title = `${d.project.name || "Projekt"} – harmonogram`;
    $("#projName").textContent = d.project.name || "Projekt";
    $("#projDesc").textContent = d.project.description || "";
    const left = toDay(d.project.deadline) - todayDay();
    $("#countdown").innerHTML = d.project.deadline
      ? `Termin końcowy: <b>${fmt(d.project.deadline)}</b><br><span class="${left < 14 ? "err" : ""}">${left >= 0 ? "zostało " + days(left) : "termin minął " + days(-left) + " temu"}</span>`
      : "";
    $("#dataLink").href = `https://github.com/${REPO.owner}/${REPO.repo}/blob/${CFG.branch}/${CFG.path}`;
    document.body.classList.toggle("fri-proj", hasClassDays());
    renderAuth(); renderFilters(); renderStats(); renderGantt(); renderTeam(); renderHistory();
    document.body.classList.toggle("can-edit", !!S.token);
  }

  function renderAuth() {
    const box = $("#authBox"); box.innerHTML = "";
    if (S.token) {
      box.append(
        el("span", { class: "small" }, S.user ? `Zalogowano: ${S.user.login}` : "Zalogowano"),
        S.user && !S.canPush ? el("span", { class: "err small", title: "Konto nie ma prawa zapisu do repozytorium" }, " (brak prawa zapisu)") : "",
        el("button", { type: "button", onclick: logout }, "Wyloguj")
      );
    } else {
      box.append(el("button", { type: "button", class: "primary", onclick: openLogin }, "Zaloguj do edycji"));
    }
  }

  function renderFilters() {
    const sel = $("#filterPerson"), cur = sel.value;
    sel.innerHTML = '<option value="">wszyscy</option>';
    S.data.team.forEach(p => sel.append(el("option", { value: p.id }, p.name)));
    sel.value = cur;
  }

  function renderStats() {
    const tasks = S.data.tasks.filter(t => t.type !== "buffer");
    const infos = tasks.map(taskInfo);
    const totalDays = tasks.reduce((a, t) => a + dayCount(t.start, t.end), 0) || 1;
    const done = tasks.reduce((a, t) => a + dayCount(t.start, t.end) * t.progress / 100, 0);
    const cnt = st => infos.filter(i => i.status === st).length;
    const slip = infos.filter(i => i.slipDays > 0).length;
    const buffers = S.data.tasks.filter(t => t.type === "buffer");
    const bst = bufferState(S.data);
    const bufLen = buffers.reduce((a, b) => a + bst[b.id].capacity, 0);
    const bufUsed = buffers.reduce((a, b) => a + bst[b.id].used, 0);
    const box = $("#stats"); box.innerHTML = "";
    const stat = (label, value, cls = "") => el("div", { class: "stat " + cls }, el("div", { class: "v" }, value), el("div", { class: "l" }, label));
    box.append(
      stat("postęp całości (ważony czasem)", Math.round(done / totalDays * 100) + "%"),
      stat("ukończone", `${cnt("done")} / ${tasks.length}`),
      stat("po terminie", cnt("late"), cnt("late") ? "bad" : ""),
      stat("zagrożone", cnt("risk"), cnt("risk") ? "warn" : ""),
      stat("z obsuwą terminu", slip, slip ? "warn" : ""),
      stat("bufor zużyty", `${bufUsed} / ${workUnit(S.data, bufLen)}`, bufUsed > bufLen ? "bad" : bufUsed > bufLen * 0.7 ? "warn" : "")
    );
  }

  function visibleTasks() {
    const fp = $("#filterPerson").value, fs = $("#filterStatus").value;
    return S.data.tasks.filter(t => {
      if (fp && !(t.owners || []).includes(fp)) return false;
      if (!fs) return true;
      const i = taskInfo(t);
      if (fs === "buffer") return t.type === "buffer";
      if (fs === "slip") return i.slipDays > 0;
      return t.type !== "buffer" && i.status === fs;
    });
  }

  /** Oś czasu: tryb „piątki” (kolumna = dzień zajęć) albo „dni” (kolumna = dzień). */
  function buildAxis(d, min, max) {
    const [mode, w] = $("#zoom").value.split(":");
    const cls = d.project.classDays || [];
    const fri = mode === "f" && cls.length;
    const colW = +w;
    if (!fri) {
      const cols = []; for (let x = min; x <= max; x++) cols.push(x);
      return { fri: false, colW, cols, xs: day => (day - min) * colW, xe: day => (day - min + 1) * colW,
        xToday: day => (day - min) * colW + colW / 2 };
    }
    const cols = []; for (let x = min; x <= max; x++) if (cls.includes(new Date(x * DAY).getUTCDay())) cols.push(x);
    const firstGE = day => { let i = cols.findIndex(c => c >= day); return i < 0 ? cols.length : i; };
    const lastLE = day => { let i = -1; cols.forEach((c, k) => { if (c <= day) i = k; }); return i; };
    const xs = day => firstGE(day) * colW;
    const xe = day => (lastLE(day) + 1) * colW;
    return { fri: true, colW, cols, xs, xe,
      xToday: day => cols.includes(day) ? xs(day) + colW / 2 : xe(day) };
  }

  function renderGantt() {
    const d = S.data, today = todayDay();
    const all = d.tasks;
    const starts = all.map(t => Math.min(toDay(t.start), toDay(t.baselineStart || t.start)));
    const ends = all.map(t => Math.max(toDay(t.end), toDay(t.baselineEnd || t.end)));
    let min = Math.min(toDay(d.project.start || fromDay(today)), ...starts);
    let max = Math.max(toDay(d.project.deadline || fromDay(today)), ...ends, today);
    min -= ((new Date(min * DAY).getUTCDay() + 6) % 7); // od poniedziałku
    max += 7;
    const A = buildAxis(d, min, max);
    const W = A.fri ? A.cols.length * A.colW : (max - min + 1) * A.colW;
    const noClass = d.project.noClassDates || [];

    const g = $("#gantt"); g.innerHTML = "";
    g.classList.toggle("fri-mode", A.fri);
    g.style.setProperty("--dayW", A.colW + "px");
    g.style.setProperty("--labelW", LABEL_W + "px");
    g.style.width = (LABEL_W + W) + "px";

    // nagłówek: miesiące + kolumny
    const months = el("div", { class: "tl months" }), weeks = el("div", { class: "tl weeks" });
    if (A.fri) {
      let k = 0;
      while (k < A.cols.length) {
        const dt = new Date(A.cols[k] * DAY), m = dt.getUTCMonth();
        let j = k; while (j + 1 < A.cols.length && new Date(A.cols[j + 1] * DAY).getUTCMonth() === m) j++;
        months.append(el("div", { class: "m", style: `left:${k * A.colW}px;width:${(j - k + 1) * A.colW}px` }, `${MONTHS[m]} ${dt.getUTCFullYear()}`));
        k = j + 1;
      }
      A.cols.forEach((c, k2) => {
        const ds = fromDay(c), off = noClass.includes(ds);
        weeks.append(el("div", { class: "w fri" + (off ? " off" : "") + (c === today ? " is-today" : ""), style: `left:${k2 * A.colW}px;width:${A.colW}px`,
          title: `${fmt(ds)}${off ? " – brak zajęć" : ""}` }, off ? `${fmtShort(ds)} wolne` : `pt ${fmtShort(ds)}`));
      });
    } else {
      for (let dd = min; dd <= max; dd++) {
        const dt = new Date(dd * DAY);
        if (dt.getUTCDate() === 1 || dd === min) {
          const endM = Math.min(max, Math.round(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1) / DAY) - 1);
          months.append(el("div", { class: "m", style: `left:${A.xs(dd)}px;width:${(endM - dd + 1) * A.colW}px` }, `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`));
        }
        if (dt.getUTCDay() === 1) {
          weeks.append(el("div", { class: "w", style: `left:${A.xs(dd)}px;width:${7 * A.colW}px` }, A.colW >= 10 ? fmtShort(fromDay(dd)) : String(dt.getUTCDate())));
        }
      }
    }
    g.append(el("div", { class: "row head" }, el("div", { class: "label" }, "Zadanie"), el("div", { class: "track" }, months, weeks)));

    const rows = visibleTasks();
    if (!rows.length) g.append(el("div", { class: "row empty" }, el("div", { class: "label muted" }, "Brak zadań dla wybranego filtra."), el("div", { class: "track" })));

    const span = (a, b) => { const l = A.xs(a); let r = A.xe(b); if (r <= l) r = l + Math.max(8, A.colW / 3); return { l, w: r - l }; };

    rows.forEach(t => {
      const i = taskInfo(t);
      const depth = t.id.split(".").length - 1;
      const isBuf = t.type === "buffer";
      const s = toDay(t.start), e = toDay(t.end);
      const bs = toDay(t.baselineStart || t.start), be = toDay(t.baselineEnd || t.end);
      const color = taskColor(t);
      const track = el("div", { class: "track" });
      const P = span(s, e);

      // pierwotny plan (jeśli różny od aktualnego)
      if (bs !== s || be !== e) {
        const G = span(bs, be);
        if (G.l !== P.l || G.w !== P.w) track.append(el("div", { class: "ghost", style: `left:${G.l}px;width:${G.w}px`, title: `Pierwotny plan: ${fmt(t.baselineStart)} – ${fmt(t.baselineEnd)}` }));
      }

      if (isBuf) {
        const b = bufferState(d)[t.id];
        const frac = b.capacity ? Math.min(1, b.used / b.capacity) : (b.used ? 1 : 0);
        const tipB = [`Bufor ${fmt(t.start)} – ${fmt(t.end)}: ${workUnit(d, b.capacity)}`, `Zużyto: ${workUnit(d, b.used)}, zostało: ${workUnit(d, Math.max(0, b.capacity - b.used))}`,
          ...b.items.map(it => `• ${it.taskId} ${it.name}: ${workUnit(d, it.days)} (${it.reason})`)].join("\n");
        const bar = el("div", { class: "bar buffer" + (b.used > b.capacity ? " over" : ""), style: `left:${P.l}px;width:${P.w}px`, title: tipB });
        bar.append(el("div", { class: "buf-used", style: `width:${frac * 100}%` }));
        bar.append(el("span", { class: "bar-txt" }, `${b.used}/${b.capacity}`));
        track.append(bar);
      } else {
        const planEnd = Math.min(e, be);
        const tip = [
          `${t.id} ${t.name}`,
          `Termin: ${fmt(t.start)} – ${fmt(t.end)}`,
          i.slipDays ? `Obsuwa: +${workUnit(d, countWork(d, be + 1, e))} (plan: do ${fmt(t.baselineEnd)})` : "",
          `Postęp: ${t.progress}% (oczekiwany ~${i.expected}%)`,
          t.hours ? `Szacowany czas: ${t.hours} h` : "",
          i.lateDays ? `Po terminie od ${days(i.lateDays)}` : "",
          `Osoby: ${ownersLabel(t)}`
        ].filter(Boolean).join("\n");
        const bar = el("div", { class: `bar st-${i.status}` + (t.unplanned ? " unplanned" : "") + (P.w < 40 ? " narrow" : ""), style: `left:${P.l}px;width:${P.w}px;--c:${color}`, title: tip });
        const planW = planEnd >= s ? Math.min(100, (A.xe(planEnd) - P.l) / P.w * 100) : 0;
        bar.append(el("div", { class: "seg plan", style: `width:${Math.max(0, planW)}%` }));
        if (i.slipDays && planW < 100) bar.append(el("div", { class: "seg slip", style: `left:${Math.max(0, planW)}%;width:${100 - Math.max(0, planW)}%` }));
        bar.append(el("div", { class: "prog", style: `width:${t.progress}%` }));
        bar.append(el("span", { class: "bar-txt" }, `${t.progress}%`));
        track.append(bar);
        if (i.lateDays) {
          const l = P.l + P.w, r = Math.max(l + 6, A.xe(today));
          track.append(el("div", { class: "late-ext", style: `left:${l}px;width:${r - l}px`, title: `Po terminie: ${days(i.lateDays)}, postęp ${t.progress}%` }));
        }
      }

      const slipLbl = i.slipDays && !isBuf ? ` · +${A.fri ? countWork(d, be + 1, e) + " pt" : i.slipDays + "d"}` : "";
      const badge = el("span", { class: "badge b-" + i.status }, STATUS_LABEL[i.status] + slipLbl);
      const label = el("div", { class: "label", style: `padding-left:${8 + depth * 16}px` },
        el("span", { class: "tid" }, t.id),
        el("span", { class: "tname" + (depth ? "" : " top-level") }, t.name, t.unplanned ? el("span", { class: "tag" }, "niezapl.") : ""),
        badge,
        el("div", { class: "sub muted small" }, `${t.start === t.end ? fmtShort(t.start) : fmtShort(t.start) + "–" + fmtShort(t.end)}${t.hours ? " · " + t.hours + " h" : ""} · ${isBuf ? "bufor" : ownersLabel(t)}`)
      );
      g.append(el("div", { class: "row" + (isBuf ? " is-buffer" : ""), "data-id": t.id, onclick: () => openTask(t.id) }, label, track));
    });

    // tło: weekendy (tryb dni), dni zajęć i dni wolne
    const offset = (new Date(min * DAY).getUTCDay() + 6) % 7;
    g.style.setProperty("--weekOffset", (-offset * A.colW) + "px");
    const classDays = d.project.classDays || [];
    for (let dd = min; dd <= max; dd++) {
      const ds = fromDay(dd);
      if (!classDays.includes(new Date(dd * DAY).getUTCDay())) continue;
      const off = noClass.includes(ds);
      if (A.fri && !off) continue;
      g.append(el("div", { class: off ? "noclass" : "classday", style: `left:${LABEL_W + A.xs(dd)}px;width:${A.colW}px`,
        title: off ? `${fmt(ds)}: brak zajęć` : `${fmt(ds)}: zajęcia` }));
    }
    if (today >= min && today <= max) {
      g.append(el("div", { class: "today", style: `left:${LABEL_W + A.xToday(today)}px`, title: "Dziś " + fmt(fromDay(today)) }));
    }
    if (d.project.deadline) {
      g.append(el("div", { class: "deadline", style: `left:${LABEL_W + A.xe(toDay(d.project.deadline))}px`, title: "Termin końcowy " + fmt(d.project.deadline) }));
    }
    S._x = A.xs;
  }

  function scrollToToday() {
    const wrap = $("#ganttWrap");
    if (!S._x) return;
    wrap.scrollLeft = Math.max(0, S._x(todayDay()) - (wrap.clientWidth - LABEL_W) / 3);
  }

  function renderTeam() {
    const ul = $("#teamList"); ul.innerHTML = "";
    S.data.team.forEach(p => {
      const mine = S.data.tasks.filter(t => (t.owners || []).includes(p.id) && t.type !== "buffer");
      const late = mine.filter(t => taskInfo(t).status === "late").length;
      ul.append(el("li", {},
        el("i", { class: "dot", style: `background:${p.color || "#999"}` }),
        el("b", {}, p.name), " ", el("span", { class: "muted" }, p.role || ""),
        el("span", { class: "small muted" }, ` · zadań: ${mine.length}`),
        late ? el("span", { class: "small err" }, ` · po terminie: ${late}`) : ""
      ));
    });
  }

  function renderHistory() {
    const ul = $("#history"); ul.innerHTML = "";
    S.data.history.slice(0, 40).forEach(h => {
      const dt = new Date(h.ts);
      ul.append(el("li", {}, el("span", { class: "muted small" }, `${dt.toLocaleDateString("pl-PL")} ${dt.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })} · ${h.user}`), el("div", {}, h.text)));
    });
    if (!S.data.history.length) ul.append(el("li", { class: "muted" }, "Brak zmian."));
  }

  // ---------- komunikaty ----------
  let msgTimer;
  function showMsg(text, kind = "info", ms = 0) {
    const m = $("#msg");
    m.textContent = text; m.className = "msg " + kind; m.hidden = false;
    clearTimeout(msgTimer);
    if (ms) msgTimer = setTimeout(() => (m.hidden = true), ms);
  }

  // ---------- logowanie ----------
  function openLogin() { $("#loginErr").textContent = ""; $("#loginForm").reset(); $("#loginDlg").showModal(); }
  async function checkUser() {
    if (!S.token) return;
    const r = await fetch(API + "/user", { headers: headers() });
    if (r.status === 401) { throw new Error("Token nieprawidłowy lub wygasł."); }
    if (!r.ok) throw new Error("Nie udało się sprawdzić tokenu: " + r.status);
    S.user = await r.json();
    const scopes = r.headers.get("x-oauth-scopes");
    const rr = await fetch(`${API}/repos/${REPO.owner}/${REPO.repo}`, { headers: headers() });
    S.canPush = rr.ok ? !!((await rr.json()).permissions || {}).push : false;
    if (scopes !== null && !/\b(public_)?repo\b/.test(scopes)) {
      showMsg("Token nie ma zakresu public_repo, zapis się nie uda.", "err");
    } else if (!S.canPush) {
      showMsg(`Konto ${S.user.login} nie ma prawa zapisu do ${REPO.owner}/${REPO.repo}. Poproś właściciela o dodanie jako Collaborator i przyjmij zaproszenie.`, "err");
    }
  }
  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    S.token = ""; S.user = null; S.canPush = false;
    render(); showMsg("Wylogowano. Token usunięty z tej przeglądarki.", "info", 3000);
  }

  // ---------- dialog zadania ----------
  const F = () => $("#taskForm").elements;

  function nextId(type) {
    if (type === "buffer") {
      let n = 1; while (S.data.tasks.some(t => t.id === "B" + n)) n++;
      return "B" + n;
    }
    const tops = S.data.tasks.map(t => parseInt(t.id, 10)).filter(n => !isNaN(n));
    return String((tops.length ? Math.max(...tops) : 0) + 1);
  }

  function fillBufferSelect(sel) {
    sel.innerHTML = "";
    const st = bufferState(S.data);
    sel.append(el("option", { value: "" }, "automatycznie (najbliższy bufor po zadaniu)"));
    S.data.tasks.filter(t => t.type === "buffer").forEach(b => {
      const left = st[b.id].capacity - st[b.id].used;
      sel.append(el("option", { value: b.id }, `${b.id} ${b.name} (zostało ${workUnit(S.data, Math.max(0, left))})`));
    });
    sel.append(el("option", { value: "none" }, "nie odliczaj od bufora"));
  }

  function openTask(id, newType) {
    const t = id ? S.data.tasks.find(x => x.id === id) : null;
    const isNew = !t;
    const type = t ? t.type : (newType || "task");
    S.editing = id || null;
    const form = $("#taskForm"); form.reset();
    const f = F();
    form.classList.toggle("is-new", isNew);
    form.classList.toggle("is-buffer", type === "buffer");
    const readOnly = !S.token;
    form.classList.toggle("read-only", readOnly);

    $("#taskDlgTitle").textContent = isNew ? (type === "buffer" ? "Nowy bufor" : "Nowe zadanie") : `${t.id} ${t.name}`;
    const today = fromDay(todayDay());
    f.id.value = t ? t.id : nextId(type);
    f.type.value = type;
    f.name.value = t ? t.name : "";
    const nextCls = nextClassDay(todayDay());
    setDateField("start", t ? t.start : nextCls);
    setDateField("end", t ? t.end : nextCls);
    f.notes.value = t ? t.notes || "" : "";
    f.progress.value = t ? t.progress : 0;
    f.hours.value = t && t.hours ? t.hours : "";
    $("#progOut").textContent = f.progress.value + "%";
    f.id.readOnly = !isNew;
    f.type.disabled = !isNew;

    // osoby
    const oc = $("#ownerChecks"); oc.innerHTML = "";
    S.data.team.forEach(p => {
      const checked = t ? (t.owners || []).includes(p.id) : false;
      oc.append(el("label", { class: "check" }, el("input", { type: "checkbox", name: "owner", value: p.id, checked: checked ? "checked" : null }), " ", p.name));
    });

    // informacja o planie bazowym
    if (t && t.type !== "buffer") {
      const i = taskInfo(t);
      $("#baselineInfo").textContent = `Plan bazowy: ${fmt(t.baselineStart)} – ${fmt(t.baselineEnd)}` +
        (i.slipDays ? ` · obsuwa +${days(i.slipDays)}` : "") + ` · status: ${STATUS_LABEL[i.status]}` +
        (i.expected ? ` · oczekiwany postęp ~${i.expected}%` : "");
    } else $("#baselineInfo").textContent = "";

    // bufory
    fillBufferSelect(f.taskBuffer);
    f.taskBuffer.value = t && t.buffer ? t.buffer : "";
    $("#slipBox").hidden = true;
    const bu = $("#bufferUsage"); bu.innerHTML = "";
    if (t && t.type === "buffer") {
      const b = bufferState(S.data)[t.id];
      bu.append(el("p", {}, `Pojemność: ${workUnit(S.data, b.capacity)} zajęć w okresie bufora. Zużyto: ${workUnit(S.data, b.used)}, zostało: ${workUnit(S.data, Math.max(0, b.capacity - b.used))}.`));
      bu.append(el("p", { class: "small muted" }, "Zużycie liczy się samo: obsuwy terminów, zadania po terminie i zadania niezaplanowane przypisane do tego bufora."));
      if (b.items.length) {
        const ul = el("ul", { class: "small" });
        b.items.forEach(it => ul.append(el("li", {}, `${it.taskId} ${it.name}: ${workUnit(S.data, it.days)} (${it.reason})`)));
        bu.append(ul);
      }
      if (S.token) bu.append(el("label", {}, "Dodatkowe zużycie wpisane ręcznie (piątki): ", el("input", { type: "number", name: "extraDays", min: 0, value: t.extraDays || 0, style: "width:6em" })));
    }

    [...form.querySelectorAll("input,select,textarea")].forEach(i => { if (i.name !== "type") i.disabled = readOnly; });
    if (!isNew) f.type.disabled = true;
    $("#btnSave").hidden = readOnly;
    $("#btnDelete").hidden = readOnly || isNew;
    updateSlipBox();
    $("#taskDlg").showModal();
  }

  function hasClassDays() { return !!(S.data.project.classDays && S.data.project.classDays.length); }
  function nextClassDay(day) {
    if (!hasClassDays()) return fromDay(day);
    let x = day; while (!S.data.project.classDays.includes(new Date(x * DAY).getUTCDay())) x++;
    return fromDay(x);
  }
  /** W projekcie z dniami zajęć daty wybiera się z listy piątków. */
  function setDateField(name, value) {
    const form = $("#taskForm");
    let fld = form.elements[name];
    if (hasClassDays()) {
      if (fld.tagName !== "SELECT") {
        const sel = el("select", { name, required: "required" });
        fld.replaceWith(sel); fld = sel;
      }
      const d = S.data, cls = d.project.classDays, off = d.project.noClassDates || [];
      const from = Math.min(toDay(d.project.start || value), todayDay() - 28, toDay(value));
      const to = Math.max(toDay(d.project.deadline || value) + 56, toDay(value));
      fld.innerHTML = "";
      for (let x = from; x <= to; x++) {
        const ds = fromDay(x);
        if (!cls.includes(new Date(x * DAY).getUTCDay()) && ds !== value) continue;
        const wd = ["nd", "pn", "wt", "śr", "cz", "pt", "sb"][new Date(x * DAY).getUTCDay()];
        fld.append(el("option", { value: ds }, `${wd} ${fmt(ds)}${off.includes(ds) ? " (brak zajęć)" : ""}`));
      }
      fld.value = value;
    } else {
      if (fld.tagName === "SELECT") {
        const inp = el("input", { type: "date", name, required: "required" });
        fld.replaceWith(inp); fld = inp;
      }
      fld.value = value;
    }
  }

  function updateSlipBox() {
    const f = F();
    const t = S.editing ? S.data.tasks.find(x => x.id === S.editing) : null;
    if (t && t.type !== "buffer" && f.end.value && !f.rebaseline.checked) {
      const delta = toDay(f.end.value) - toDay(t.end);
      if (delta > 0) {
        const n = countWork(S.data, toDay(t.end) + 1, toDay(f.end.value));
        $("#slipText").textContent = `Przesuwasz koniec o ${days(delta)} później (${workUnit(S.data, n)} zajęć). Zostanie to pokazane jako obsuwa i automatycznie odliczone od bufora.`;
        $("#slipBox").hidden = false;
        return;
      }
    }
    $("#slipBox").hidden = true;
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    const f = F();
    const isNew = !S.editing;
    const id = f.id.value.trim();
    const type = f.type.value;
    const name = f.name.value.trim();
    const start = f.start.value, end = f.end.value;
    if (!name) return showMsg("Podaj nazwę.", "err");
    if (toDay(end) < toDay(start)) return showMsg("Koniec nie może być przed początkiem.", "err");
    if (isNew && S.data.tasks.some(t => t.id === id)) return showMsg(`Numer ${id} już istnieje.`, "err");
    const owners = [...document.querySelectorAll('#ownerChecks input:checked')].map(i => i.value);
    const progress = +f.progress.value;
    const hours = f.hours.value === "" ? null : Math.max(0, +f.hours.value);
    const notes = f.notes.value.trim();
    const rebase = f.rebaseline.checked;
    const taskBuf = f.taskBuffer.value;
    const unplanned = f.unplanned.checked;
    const extraInput = f.extraDays ? Math.max(0, +f.extraDays.value || 0) : null;
    const today = fromDay(todayDay());

    let text;
    if (isNew) {
      text = `${type === "buffer" ? "Dodano bufor" : "Dodano zadanie"} ${id} „${name}” (${fmt(start)}–${fmt(end)})` + (unplanned ? " [niezaplanowane]" : "");
      if (taskBuf && type !== "buffer") text += taskBuf === "none" ? ", bez bufora" : `, bufor ${taskBuf}`;
    } else {
      const old = S.data.tasks.find(t => t.id === S.editing);
      const ch = [];
      if (old.name !== name) ch.push("nazwa");
      if (old.start !== start || old.end !== end) ch.push(`termin ${fmtShort(old.start)}–${fmtShort(old.end)} → ${fmtShort(start)}–${fmtShort(end)}` + (rebase ? " (nowy plan)" : ""));
      if (old.progress !== progress) ch.push(`postęp ${old.progress}% → ${progress}%`);
      if ((old.hours ?? null) !== hours) ch.push(`godziny → ${hours ?? "brak"}`);
      if ((old.notes || "") !== notes) ch.push("notatki");
      if ((old.owners || []).join() !== owners.join()) ch.push("osoby");
      if (old.type === "buffer" && extraInput !== null && extraInput !== (old.extraDays || 0)) ch.push(`ręczne zużycie bufora → ${extraInput}`);
      if (old.type !== "buffer" && (old.buffer || "") !== taskBuf) ch.push(taskBuf === "none" ? "bez bufora" : `bufor → ${taskBuf || "automatycznie"}`);
      if (!ch.length) { $("#taskDlg").close(); return; }
      text = `${id} „${name}”: ${ch.join(", ")}`;
    }

    try {
      await saveChange(text, data => {
        if (isNew) {
          if (data.tasks.some(t => t.id === id)) throw new Error(`Numer ${id} został w międzyczasie zajęty. Wybierz inny.`);
          const nt = { id, name, type, start, end, baselineStart: start, baselineEnd: end, owners: type === "buffer" ? [] : owners, progress: type === "buffer" ? 0 : progress, notes };
          if (hours !== null && type !== "buffer") nt.hours = hours;
          if (type === "buffer") nt.extraDays = 0;
          else {
            if (unplanned) nt.unplanned = true;
            if (taskBuf) nt.buffer = taskBuf;
          }
          data.tasks.push(nt);
        } else {
          const t = data.tasks.find(x => x.id === S.editing);
          if (!t) throw new Error("To zadanie zostało w międzyczasie usunięte.");
          t.name = name; t.notes = notes;
          t.start = start; t.end = end;
          if (rebase) { t.baselineStart = start; t.baselineEnd = end; }
          if (t.type === "buffer") {
            if (extraInput !== null) t.extraDays = extraInput;
            delete t.usedDays; delete t.usage;
          } else {
            t.owners = owners; t.progress = progress;
            if (hours === null) delete t.hours; else t.hours = hours;
            if (taskBuf) t.buffer = taskBuf; else delete t.buffer;
          }
        }
      });
      $("#taskDlg").close();
    } catch (e) { /* komunikat już pokazany */ }
  }

  async function onDelete() {
    const id = S.editing;
    if (!id) return;
    const t = S.data.tasks.find(x => x.id === id);
    if (!confirm(`Usunąć ${t.type === "buffer" ? "bufor" : "zadanie"} ${id} „${t.name}”?`)) return;
    try {
      await saveChange(`Usunięto ${id} „${t.name}”`, data => {
        data.tasks = data.tasks.filter(x => x.id !== id);
      });
      $("#taskDlg").close();
    } catch (e) { /* pokazane */ }
  }

  // ---------- start ----------
  function bind() {
    ["#filterPerson", "#filterStatus"].forEach(s => $(s).addEventListener("change", renderGantt));
    $("#zoom").addEventListener("change", () => { renderGantt(); scrollToToday(); });
    $("#btnToday").addEventListener("click", scrollToToday);
    $("#btnReport").addEventListener("click", openReport);
    $("#btnReload").addEventListener("click", async () => {
      try { await loadData(); render(); showMsg("Pobrano najnowsze dane.", "ok", 2500); } catch (e) { showMsg(e.message, "err"); }
    });
    $("#btnAddTask").addEventListener("click", () => openTask(null, "task"));
    $("#btnAddBuffer").addEventListener("click", () => openTask(null, "buffer"));
    $("#taskForm").addEventListener("submit", onSubmit);
    $("#btnCancel").addEventListener("click", () => $("#taskDlg").close());
    $("#btnDelete").addEventListener("click", onDelete);
    const f = F();
    f.progress.addEventListener("input", () => ($("#progOut").textContent = f.progress.value + "%"));
    $("#taskForm").addEventListener("change", ev => {
      const n = ev.target.name, ff = F();
      if (n === "start" && ff.end.value && ff.end.value < ff.start.value) { ff.end.value = ff.start.value; }
      if (n === "start" || n === "end" || n === "rebaseline") updateSlipBox();
    });

    $("#loginForm").addEventListener("submit", async ev => {
      ev.preventDefault();
      const tok = $("#loginForm").elements.token.value.trim();
      S.token = tok;
      try {
        await checkUser();
        localStorage.setItem(TOKEN_KEY, tok);
        $("#loginDlg").close();
        await loadData();
        render();
        if (S.canPush) showMsg(`Zalogowano jako ${S.user.login}. Możesz edytować (kliknij zadanie).`, "ok", 5000);
      } catch (e) {
        S.token = ""; S.user = null;
        $("#loginErr").textContent = e.message;
      }
    });
    $("#btnLoginCancel").addEventListener("click", () => $("#loginDlg").close());
  }

  async function init() {
    bind();
    try {
      if (S.token) {
        try { await checkUser(); } catch (e) { showMsg(e.message + " Zaloguj się ponownie.", "err"); S.token = ""; localStorage.removeItem(TOKEN_KEY); }
      }
      await loadData();
      render();
      scrollToToday();
    } catch (e) {
      showMsg("Błąd wczytywania danych: " + e.message, "err");
    }
  }

  // ---------- raport PDF (druk do PDF z przeglądarki) ----------
  const esc = v => String(v ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtTs = ts => { const d = new Date(ts); return `${d.toLocaleDateString("pl-PL")} ${d.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}`; };

  function historyFor(id) {
    const q = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^(${q} „|Dodano (zadanie|bufor) ${q} „)`), del = new RegExp(`^Usunięto ${q} „`);
    const out = [];
    for (const h of S.data.history) { // od najnowszych; wcześniejsze wpisy dotyczą usuniętego zadania o tym numerze
      if (del.test(h.text)) break;
      if (re.test(h.text)) out.push(h);
    }
    return out;
  }

  function buildReport() {
    const d = S.data, now = new Date();
    const tasks = d.tasks.filter(t => t.type !== "buffer");
    const buffers = d.tasks.filter(t => t.type === "buffer");
    const bst = bufferState(d);
    const statusCls = { ok: "ok", done: "done", late: "late", risk: "risk", buffer: "" };
    const totalDays = tasks.reduce((a, t) => a + dayCount(t.start, t.end), 0) || 1;
    const doneW = tasks.reduce((a, t) => a + dayCount(t.start, t.end) * t.progress / 100, 0);
    const infos = tasks.map(taskInfo);
    const cnt = st => infos.filter(i => i.status === st).length;

    const taskRow = (t, who) => {
      const i = taskInfo(t);
      const slip = i.slipDays ? `+${workUnit(d, countWork(d, toDay(t.baselineEnd) + 1, toDay(t.end)))}` : "–";
      const full = who !== null;
      const others = (t.owners || []).filter(o => o !== who).map(o => (person(o) || { name: o }).name);
      const ch = full ? historyFor(t.id) : [];
      return `<tr>
        <td class="id">${esc(t.id)}</td>
        <td><b>${esc(t.name)}</b>${t.unplanned ? ' <span class="tag">niezaplanowane</span>' : ""}
          ${full ? (others.length ? `<div class="small">razem z: ${esc(others.join(", "))}</div>` : "") : `<div class="small">${esc(ownersLabel(t) || "brak osoby")}</div>`}
          ${full && t.notes ? `<div class="notes">${esc(t.notes).replace(/\n/g, "<br>")}</div>` : ""}
          ${ch.length ? `<details open><summary>Zmiany (${ch.length})</summary><ul>${ch.map(h => `<li>${fmtTs(h.ts)} · ${esc(h.user)}: ${esc(h.text)}</li>`).join("")}</ul></details>` : ""}
        </td>
        <td class="nw">${fmt(t.start)}<br>– ${fmt(t.end)}</td>
        <td class="nw">${fmt(t.baselineStart)}<br>– ${fmt(t.baselineEnd)}</td>
        <td class="c">${t.hours ? t.hours + " h" : "–"}</td>
        <td class="c"><div class="pb"><i style="width:${t.progress}%"></i></div>${t.progress}%</td>
        <td class="c"><span class="st ${statusCls[i.status]}">${STATUS_LABEL[i.status]}</span></td>
        <td class="c">${slip}</td>
      </tr>`;
    };
    const table = (list, who) => list.length ? `<table>
      <thead><tr><th>Nr</th><th>Zadanie</th><th>Termin</th><th>Plan bazowy</th><th>Czas</th><th>Postęp</th><th>Status</th><th>Obsuwa</th></tr></thead>
      <tbody>${list.map(t => taskRow(t, who)).join("")}</tbody></table>` : `<p class="muted">Brak przypisanych zadań.</p>`;

    const people = d.team.map(p => {
      const mine = tasks.filter(t => (t.owners || []).includes(p.id));
      if (!mine.length && p.id === "p") return "";
      const hrs = mine.reduce((a, t) => a + (t.hours || 0), 0);
      const late = mine.filter(t => taskInfo(t).status === "late").length;
      const done = mine.filter(t => t.progress >= 100).length;
      return `<section class="person">
        <h2><span class="dot" style="background:${esc(p.color || "#999")}"></span>${esc(p.name)} <span class="role">${esc(p.role || "")}</span></h2>
        <p class="small">Zadań: ${mine.length} · ukończonych: ${done} · po terminie: ${late}${hrs ? ` · szacowany czas: ${hrs} h` : ""}</p>
        ${table(mine, p.id)}
      </section>`;
    }).join("");

    const nobody = tasks.filter(t => !(t.owners || []).length);
    const bufHtml = buffers.map(b => {
      const st = bst[b.id];
      return `<tr><td class="id">${esc(b.id)}</td><td><b>${esc(b.name)}</b>${st.items.length ? `<ul>${st.items.map(it => `<li>${esc(it.taskId)} ${esc(it.name)}: ${workUnit(d, it.days)} (${esc(it.reason)})</li>`).join("")}</ul>` : ""}</td>
        <td class="nw">${fmt(b.start)} – ${fmt(b.end)}</td><td class="c">${st.used} / ${workUnit(d, st.capacity)}</td></tr>`;
    }).join("");
    const hist = [...d.history].reverse();

    return `<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8">
<title>Raport – ${esc(d.project.name)} – ${now.toLocaleDateString("pl-PL")}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font: 11px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #0f172a; margin: 0; }
  h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 15px; margin: 18px 0 4px; border-bottom: 2px solid #e2e8f0; padding-bottom: 3px; }
  .role { font-weight: 400; color: #64748b; font-size: 12px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
  .small { font-size: 10px; color: #475569; margin: 2px 0; } .muted { color: #64748b; }
  .summary { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
  .summary div { border: 1px solid #e2e8f0; border-radius: 6px; padding: 5px 10px; } .summary b { font-size: 14px; display: block; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  th { background: #f1f5f9; text-align: left; font-size: 10px; padding: 4px 6px; border-bottom: 1px solid #cbd5e1; }
  td { padding: 4px 6px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  td.id { font-weight: 600; color: #475569; width: 34px; } td.c { text-align: center; white-space: nowrap; } td.nw { white-space: nowrap; }
  .notes { font-size: 10px; color: #334155; margin-top: 2px; white-space: normal; }
  details ul, td ul { margin: 2px 0 0; padding-left: 16px; font-size: 10px; color: #334155; } summary { font-size: 10px; color: #1e40af; }
  .pb { width: 60px; height: 6px; background: #e2e8f0; border-radius: 3px; margin: 2px auto; overflow: hidden; } .pb i { display: block; height: 100%; background: #2563eb; }
  .st { padding: 1px 6px; border-radius: 8px; font-size: 10px; } .st.ok { background: #e0f2fe; } .st.done { background: #dcfce7; } .st.late { background: #fee2e2; color: #991b1b; } .st.risk { background: #fef3c7; }
  .tag { font-size: 9px; background: #fae8ff; color: #86198f; border-radius: 4px; padding: 0 4px; }
  .person { page-break-before: always; } .person:first-of-type { page-break-before: auto; }
  .hist { page-break-before: always; } .hist td { font-size: 10px; }
  .noprint { position: fixed; top: 8px; right: 8px; } @media print { .noprint { display: none; } }
  .noprint button { font: inherit; font-size: 13px; padding: 6px 14px; background: #2563eb; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
</style></head><body>
<div class="noprint"><button onclick="window.print()">Zapisz jako PDF / drukuj</button></div>
<h1>${esc(d.project.name)} – raport postępu</h1>
<div class="small">${esc(d.project.description || "")}</div>
<div class="small">Wygenerowano: ${fmtTs(now)} · termin końcowy: ${d.project.deadline ? fmt(d.project.deadline) : "–"} · źródło: ${esc(REPO.owner)}/${esc(REPO.repo)}</div>
<div class="summary">
  <div><b>${Math.round(doneW / totalDays * 100)}%</b>postęp całości</div>
  <div><b>${cnt("done")} / ${tasks.length}</b>ukończone</div>
  <div><b>${cnt("late")}</b>po terminie</div>
  <div><b>${cnt("risk")}</b>zagrożone</div>
  <div><b>${infos.filter(i => i.slipDays > 0).length}</b>z obsuwą</div>
  <div><b>${d.history.length}</b>zmian w historii</div>
</div>
<h2>Wszystkie zadania</h2>
<p class="small">Szczegóły, notatki i zmiany każdego zadania są w częściach dla poszczególnych osób.</p>
${table(tasks, null)}
${buffers.length ? `<h2>Bufory</h2><table><thead><tr><th>Nr</th><th>Bufor i zużycie</th><th>Okres</th><th>Zużyto</th></tr></thead><tbody>${bufHtml}</tbody></table>` : ""}
${people}
${nobody.length ? `<section class="person"><h2>Zadania bez przypisanej osoby</h2>${table(nobody, "")}</section>` : ""}
<section class="hist"><h2>Historia wszystkich zmian (${hist.length})</h2>
<table><thead><tr><th>Data</th><th>Kto</th><th>Zmiana</th></tr></thead><tbody>
${hist.map(h => `<tr><td class="nw">${fmtTs(h.ts)}</td><td class="nw">${esc(h.user)}</td><td>${esc(h.text)}</td></tr>`).join("")}
</tbody></table></section>
<script>setTimeout(() => window.print(), 400);<\/script>
</body></html>`;
  }

  /** Raport wyświetla się na tej samej stronie (bez nowego okna, działa też na telefonie). */
  function openReport() {
    try {
      const doc = buildReport();
      let css = doc.slice(doc.indexOf("<style>") + 7, doc.indexOf("</style>"));
      css = css.split("\n").filter(l => !l.includes(".noprint")).join("\n");
      css = css.replace(/([^{}]+)\{([^{}]*)\}/g, (m, sel, body) => {
        sel = sel.trim();
        if (sel.startsWith("@")) return m;
        const scoped = sel.split(",").map(x => x.trim()).map(x => x === "body" ? "#reportView .rv-doc" : "#reportView .rv-doc " + x).join(", ");
        return `${scoped} {${body}}\n`;
      });
      let body = doc.slice(doc.indexOf("<body>") + 6, doc.indexOf("</body>"));
      body = body.replace(/<div class="noprint">[\s\S]*?<\/div>/, "").replace(/<script>[\s\S]*?<\/script>/, "");
      let rv = $("#reportView");
      if (!rv) { rv = el("div", { id: "reportView" }); document.body.append(rv); }
      rv.innerHTML = `<style>${css}</style>
        <div class="rv-bar"><b>Raport</b><span class="spacer"></span>
          <button type="button" class="primary" id="rvPrint">Zapisz jako PDF / drukuj</button>
          <button type="button" id="rvClose">Zamknij</button></div>
        <div class="rv-doc">${body}</div>`;
      rv.hidden = false;
      document.body.classList.add("report-open");
      $("#rvPrint").addEventListener("click", () => window.print());
      $("#rvClose").addEventListener("click", () => { rv.hidden = true; document.body.classList.remove("report-open"); });
      rv.scrollTop = 0;
    } catch (e) {
      console.error(e);
      showMsg("Nie udało się przygotować raportu: " + e.message, "err");
    }
  }

  window.KT5 = { state: S, repo: REPO, reload: () => loadData().then(render) };
  init();
})();
