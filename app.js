/* ============================================================
   slotone — client-side appointment day-book.
   No network. No dependencies. State in localStorage.
   Core slot-generation + no-overlap logic is unit-tested
   (see the project's test notes); the pure functions here
   mirror those verified definitions exactly.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- tiny helpers ---------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  /* ---------- time helpers ---------- */
  // "HH:MM" -> minutes since midnight (or null if malformed)
  function toMin(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
    if (!m) return null;
    var h = +m[1], mm = +m[2];
    if (h > 23 || mm > 59) return null;
    return h * 60 + mm;
  }
  function toHHMM(min) { return pad2(Math.floor(min / 60)) + ":" + pad2(min % 60); }
  function to12h(min) {
    var h = Math.floor(min / 60), m = min % 60;
    var ap = h < 12 ? "am" : "pm";
    var hh = h % 12; if (hh === 0) hh = 12;
    return hh + (m ? ":" + pad2(m) : "") + ap;
  }

  // local date <-> "YYYY-MM-DD" (no UTC shift)
  function isoDate(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function parseISO(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  function addDays(d, n) { var x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var DOW_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function humanDate(d) { return DOW_FULL[d.getDay()] + ", " + d.getDate() + " " + MON[d.getMonth()] + " " + d.getFullYear(); }

  /* ============================================================
     CORE ENGINE (verified pure functions)
     ============================================================ */
  // half-open interval overlap: [aS,aE) vs [bS,bE)
  function overlaps(aS, aE, bS, bE) { return aS < bE && bS < aE; }

  /*
    generateSlots(o) -> [{ start, end, status, booking? }]
      o.open, o.close : minutes (working window; if null/invalid -> [])
      o.interval      : grid step (min)
      o.duration      : service duration (min)
      o.buffer        : protected minutes AFTER each appointment
      o.booked        : [{start,end, ...}] raw appointment ranges (end excludes buffer)
      o.blocks        : [{start,end}] blocked ranges (lunch / partial off)
    A slot is FREE iff the appointment [s, s+dur) fits in [open,close) AND
      [s, s+dur+buf) doesn't overlap any booked [b.start, b.end+buf) AND
      [s, s+dur) doesn't overlap any block.
  */
  function generateSlots(o) {
    var out = [];
    if (o.open == null || o.close == null || o.close <= o.open) return out;
    var step = o.interval, dur = o.duration, buf = o.buffer || 0;
    for (var s = o.open; s + dur <= o.close; s += step) {
      var e = s + dur;
      var status = "free", booking = null;
      for (var i = 0; i < o.blocks.length; i++) {
        if (overlaps(s, e, o.blocks[i].start, o.blocks[i].end)) { status = "blocked"; break; }
      }
      if (status === "free") {
        for (var j = 0; j < o.booked.length; j++) {
          var b = o.booked[j];
          if (overlaps(s, e + buf, b.start, b.end + buf)) { status = "busy"; booking = b; break; }
        }
      }
      out.push({ start: s, end: e, status: status, booking: booking });
    }
    return out;
  }

  // Guard used at the moment of booking — the authoritative no-overlap gate.
  function canBook(booked, s, dur, buf, open, close, blocks) {
    var e = s + dur;
    if (open == null || close == null || s < open || e > close) return false;
    for (var i = 0; i < blocks.length; i++) if (overlaps(s, e, blocks[i].start, blocks[i].end)) return false;
    for (var j = 0; j < booked.length; j++) if (overlaps(s, e + buf, booked[j].start, booked[j].end + buf)) return false;
    return true;
  }

  /* ============================================================
     STATE
     ============================================================ */
  var KEY = "slotone:v1";
  var storageOk = true;

  var DEFAULT_STATE = {
    biz: "",
    contact: "",
    interval: 15,
    buffer: 0,
    // hours[0..6] Sun..Sat: { on, open, close }
    hours: [
      { on: false, open: "10:00", close: "16:00" },
      { on: true, open: "09:00", close: "17:00" },
      { on: true, open: "09:00", close: "17:00" },
      { on: true, open: "09:00", close: "17:00" },
      { on: true, open: "09:00", close: "17:00" },
      { on: true, open: "09:00", close: "17:00" },
      { on: true, open: "09:00", close: "13:00" }
    ],
    // services: { id, name, dur, price, color }
    services: [
      { id: "s1", name: "Haircut", dur: 30, price: 250, color: "#C8912F" },
      { id: "s2", name: "Cut & beard", dur: 45, price: 350, color: "#2A5DB0" },
      { id: "s3", name: "Kids' cut", dur: 20, price: 180, color: "#2f8f6b" }
    ],
    // blocks: { id, date, start(HH:MM|""), end(HH:MM|"") }  empty times = whole day off
    blocks: [],
    // bookings: { id, date, start(min), end(min), serviceId, serviceName, client, note, price }
    bookings: []
  };

  var state = null;
  var seq = Date.now();
  function uid(p) { return (p || "id") + (seq++).toString(36); }

  function load() {
    try {
      localStorage.setItem("slotone:test", "1"); localStorage.removeItem("slotone:test");
    } catch (e) { storageOk = false; }
    var s = null;
    if (storageOk) {
      try { var raw = localStorage.getItem(KEY); if (raw) s = JSON.parse(raw); } catch (e2) { s = null; }
    }
    if (!s || typeof s !== "object") s = JSON.parse(JSON.stringify(DEFAULT_STATE));
    // shallow repair for forward-compat
    ["biz", "contact"].forEach(function (k) { if (typeof s[k] !== "string") s[k] = ""; });
    if (!Array.isArray(s.hours) || s.hours.length !== 7) s.hours = JSON.parse(JSON.stringify(DEFAULT_STATE.hours));
    if (!Array.isArray(s.services)) s.services = [];
    if (!Array.isArray(s.blocks)) s.blocks = [];
    if (!Array.isArray(s.bookings)) s.bookings = [];
    s.interval = +s.interval || 15;
    s.buffer = +s.buffer || 0;
    state = s;
  }
  function save() {
    if (!storageOk) return;
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { storageOk = false; toast("Storage is full or blocked — data not saved."); }
  }

  /* ---------- selectors over state ---------- */
  function serviceById(id) {
    for (var i = 0; i < state.services.length; i++) if (state.services[i].id === id) return state.services[i];
    return state.services[0] || null;
  }
  function bookingsFor(dateStr) {
    return state.bookings.filter(function (b) { return b.date === dateStr; })
      .sort(function (a, b) { return a.start - b.start; });
  }
  // blocked ranges for a date, as minutes. whole-day off -> [0,1440).
  function blocksFor(dateStr) {
    var out = [];
    state.blocks.forEach(function (bl) {
      if (bl.date !== dateStr) return;
      var s = toMin(bl.start), e = toMin(bl.end);
      if (s == null || e == null || e <= s) out.push({ start: 0, end: 1440 });
      else out.push({ start: s, end: e });
    });
    return out;
  }
  function hoursFor(date) {
    var h = state.hours[date.getDay()];
    if (!h || !h.on) return null;
    var o = toMin(h.open), c = toMin(h.close);
    if (o == null || c == null || c <= o) return null;
    return { open: o, close: c };
  }

  /* ============================================================
     VIEW STATE
     ============================================================ */
  var selected = new Date();
  selected = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate());
  var view = "day";
  var activeServiceId = null;

  function activeService() {
    var s = serviceById(activeServiceId);
    return s || { id: "", name: "—", dur: 30, price: 0, color: "#C8912F" };
  }

  /* ============================================================
     RENDER — sheet header + grid
     ============================================================ */
  function slotsForDate(date, svc) {
    var hrs = hoursFor(date);
    var dateStr = isoDate(date);
    var booked = bookingsFor(dateStr).map(function (b) { return b; });
    if (!hrs) return { off: true, slots: [], booked: booked };
    var slots = generateSlots({
      open: hrs.open, close: hrs.close,
      interval: state.interval, duration: svc.dur, buffer: state.buffer,
      booked: booked, blocks: blocksFor(dateStr)
    });
    return { off: false, slots: slots, booked: booked };
  }

  function renderHead() {
    var wrap = $("#sheetHead");
    wrap.innerHTML = "";
    var card = el("div", "sheethead__card");
    var svc = activeService();

    var title = el("h2", "sheethead__title");
    if (view === "day") {
      title.appendChild(document.createTextNode(humanDate(selected)));
    } else {
      var start = weekStart(selected);
      var end = addDays(start, 6);
      title.appendChild(document.createTextNode(
        "Week of " + start.getDate() + " " + MON[start.getMonth()] +
        " – " + end.getDate() + " " + MON[end.getMonth()] + " " + end.getFullYear()));
    }
    card.appendChild(title);

    var facts = el("div", "sheethead__facts");
    function fact(label, val, mod) {
      var f = el("span", "fact" + (mod ? " fact--" + mod : ""));
      f.appendChild(document.createTextNode(label + " "));
      f.appendChild(el("b", null, val));
      facts.appendChild(f);
    }

    if (view === "day") {
      var res = slotsForDate(selected, svc);
      if (res.off) {
        fact("Status", "Day off / closed");
      } else {
        var free = res.slots.filter(function (s) { return s.status === "free"; }).length;
        fact("Service", svc.name + " · " + svc.dur + "m");
        fact("Booked", String(res.booked.length), "busy");
        fact("Free slots", String(free), "free");
      }
    } else {
      var start2 = weekStart(selected);
      var totBooked = 0, totFree = 0, openDays = 0;
      for (var i = 0; i < 7; i++) {
        var d = addDays(start2, i);
        var r = slotsForDate(d, svc);
        if (!r.off) { openDays++; totFree += r.slots.filter(function (s) { return s.status === "free"; }).length; }
        totBooked += r.booked.length;
      }
      fact("Service", svc.name + " · " + svc.dur + "m");
      fact("Open days", String(openDays));
      fact("Booked", String(totBooked), "busy");
      fact("Free slots", String(totFree), "free");
    }
    card.appendChild(facts);
    wrap.appendChild(card);
  }

  function renderGrid() {
    var root = $("#grid");
    root.innerHTML = "";
    if (view === "day") renderDay(root);
    else renderWeek(root);
  }

  function renderDay(root) {
    var svc = activeService();
    var res = slotsForDate(selected, svc);
    if (res.off) {
      root.appendChild(emptyDay("This day is off.",
        state.hours[selected.getDay()].on
          ? "Working hours for " + DOW_FULL[selected.getDay()] + " look invalid — check Settings."
          : DOW_FULL[selected.getDay()] + " is marked as a day off. Tick it on in Settings to open the day."));
      return;
    }
    if (!res.slots.length) {
      root.appendChild(emptyDay("No slots fit.",
        "A " + svc.dur + "-minute “" + svc.name + "” doesn't fit inside your working hours for this day. Try a shorter service, wider hours, or a smaller buffer."));
      return;
    }
    var list = el("div", "daylist");
    res.slots.forEach(function (slot) {
      list.appendChild(daySlot(slot, svc));
    });
    root.appendChild(list);
  }

  function daySlot(slot, svc) {
    var dateStr = isoDate(selected);
    if (slot.status === "busy") {
      var b = slot.booking;
      var node = el("div", "slot slot--busy");
      node.style.borderLeftColor = "var(--busy)";
      var t = el("div", "slot__time", toHHMM(b.start) + "–" + toHHMM(b.end));
      node.appendChild(t);
      node.appendChild(el("div", "slot__client", b.client || "(no name)"));
      node.appendChild(el("div", "slot__svc", b.serviceName));
      if (b.note) node.appendChild(el("div", "slot__note", b.note));
      var cancel = el("button", "slot__cancel", "×");
      cancel.type = "button";
      cancel.setAttribute("aria-label", "Cancel booking for " + (b.client || "this slot") + " at " + toHHMM(b.start));
      cancel.addEventListener("click", function (ev) { ev.stopPropagation(); cancelBooking(b.id); });
      node.appendChild(cancel);
      return node;
    }
    if (slot.status === "blocked") {
      var bn = el("div", "slot slot--blocked");
      bn.appendChild(el("div", "slot__time", toHHMM(slot.start) + "–" + toHHMM(slot.end)));
      bn.appendChild(el("div", "slot__tag", "Blocked"));
      return bn;
    }
    // free
    var btn = el("button", "slot");
    btn.type = "button";
    btn.style.borderLeftColor = svc.color;
    btn.setAttribute("aria-label", "Book " + svc.name + " at " + toHHMM(slot.start) + " on " + humanDate(selected));
    btn.appendChild(el("div", "slot__time", toHHMM(slot.start)));
    btn.appendChild(el("div", "slot__tag", "Free · " + svc.name));
    if (svc.price > 0) btn.appendChild(el("span", "slot__pricepill", "₱" + svc.price));
    btn.addEventListener("click", function () { openBook(dateStr, slot.start, slot.end, svc); });
    return btn;
  }

  function emptyDay(head, body) {
    var box = el("div", "emptyday");
    box.appendChild(el("strong", null, head));
    box.appendChild(document.createTextNode(body));
    return box;
  }

  function weekStart(date) {
    // week starts Monday
    var day = date.getDay();
    var back = (day === 0) ? 6 : day - 1;
    return addDays(date, -back);
  }

  function renderWeek(root) {
    var svc = activeService();
    var start = weekStart(selected);
    var wk = el("div", "week");
    var todayStr = isoDate(new Date());
    for (var i = 0; i < 7; i++) {
      var d = addDays(start, i);
      var dateStr = isoDate(d);
      var col = el("div", "weekcol");
      var head = el("div", "weekcol__head" + (dateStr === todayStr ? " is-today" : ""));
      head.appendChild(el("div", "weekcol__dow", DOW[d.getDay()]));
      head.appendChild(el("div", "weekcol__date", String(d.getDate())));
      col.appendChild(head);

      var res = slotsForDate(d, svc);
      if (res.off) {
        var body0 = el("div", "weekcol__body");
        var off = el("div", "weekcol__off", "off");
        body0.appendChild(off);
        col.appendChild(body0);
        wk.appendChild(col);
        continue;
      }
      var body = el("div", "weekcol__body");
      var shown = 0, MAXW = 8;
      var freeAndBusy = res.slots.filter(function (s) { return s.status !== "blocked"; });
      (function (dCap, dateCap) {
        for (var k = 0; k < freeAndBusy.length && shown < MAXW; k++) {
          var slot = freeAndBusy[k];
          if (slot.status === "busy") {
            var b = slot.booking;
            var w = el("div", "wslot wslot--busy");
            w.appendChild(el("span", "wslot__t", toHHMM(b.start)));
            w.appendChild(el("span", "wslot__who", b.client || "booked"));
            body.appendChild(w); shown++;
          } else {
            var wf = el("button", "wslot"); wf.type = "button";
            wf.style.borderLeftColor = svc.color;
            wf.setAttribute("aria-label", "Book " + svc.name + " at " + toHHMM(slot.start) + " on " + humanDate(dCap));
            wf.appendChild(el("span", "wslot__t", toHHMM(slot.start)));
            wf.appendChild(el("span", "wslot__who", "free"));
            (function (st, en) {
              wf.addEventListener("click", function () { openBook(dateCap, st, en, svc); });
            })(slot.start, slot.end);
            body.appendChild(wf); shown++;
          }
        }
        var remaining = freeAndBusy.length - shown;
        if (remaining > 0) {
          var more = el("div", "wslot wslot--more", "+" + remaining + " more");
          body.appendChild(more);
        }
      })(d, dateStr);
      col.appendChild(body);
      wk.appendChild(col);
    }
    root.appendChild(wk);
  }

  /* ============================================================
     BOOK dialog
     ============================================================ */
  var pending = null;
  function openBook(dateStr, start, end, svc) {
    pending = { date: dateStr, start: start, end: end, svc: svc };
    $("#bookWhen").textContent = to12h(start) + "–" + to12h(end) + "  ·  " +
      humanDate(parseISO(dateStr)) + "  ·  " + svc.name + (svc.price > 0 ? " (₱" + svc.price + ")" : "");
    $("#clientName").value = "";
    $("#clientNote").value = "";
    showSheet("#bookSheet");
    setTimeout(function () { $("#clientName").focus(); }, 30);
  }
  function confirmBook() {
    if (!pending) return;
    var name = $("#clientName").value.trim();
    if (!name) { $("#clientName").focus(); return; }
    // Authoritative re-check against the current day-book (guards double-book races).
    var booked = bookingsFor(pending.date);
    if (!canBook(booked, pending.start, pending.svc.dur, state.buffer,
        0, 1440, blocksFor(pending.date))) {
      toast("That slot was just taken — pick another.");
      hideSheet("#bookSheet");
      refresh();
      return;
    }
    state.bookings.push({
      id: uid("bk"),
      date: pending.date,
      start: pending.start,
      end: pending.end,
      serviceId: pending.svc.id,
      serviceName: pending.svc.name,
      client: name,
      note: $("#clientNote").value.trim(),
      price: pending.svc.price
    });
    save();
    hideSheet("#bookSheet");
    pending = null;
    refresh();
    toast("Booked.");
  }
  function cancelBooking(id) {
    var b = null;
    state.bookings = state.bookings.filter(function (x) { if (x.id === id) { b = x; return false; } return true; });
    save();
    refresh();
    toast("Booking removed.");
  }

  /* ============================================================
     SHARE snapshot
     ============================================================ */
  function buildSnapshot() {
    var svc = activeService();
    var days = [];
    var base = view === "week" ? weekStart(selected) : selected;
    var span = view === "week" ? 7 : 7; // always offer a week of availability from the anchor
    for (var i = 0; i < span; i++) {
      var d = addDays(base, i);
      var res = slotsForDate(d, svc);
      var times = res.off ? [] : res.slots.filter(function (s) { return s.status === "free"; }).map(function (s) { return toHHMM(s.start); });
      days.push({ date: isoDate(d), label: humanDate(d), off: res.off, times: times });
    }
    return { biz: state.biz, contact: state.contact, svc: svc.name, dur: svc.dur, price: svc.price, days: days };
  }

  function renderShare() {
    var snap = buildSnapshot();
    var body = $("#shareBody");
    body.innerHTML = "";

    if (snap.biz) body.appendChild(el("div", "share__biz", snap.biz));
    var svcline = el("div", "share__contact", "Availability for " + snap.svc + " (" + snap.dur + " min" + (snap.price > 0 ? ", ₱" + snap.price : "") + ")");
    body.appendChild(svcline);
    if (snap.contact) body.appendChild(el("div", "share__contact", snap.contact));

    snap.days.forEach(function (day) {
      if (day.off) return;
      var card = el("div", "shareday");
      card.appendChild(el("div", "shareday__head", day.label));
      if (!day.times.length) {
        card.appendChild(el("div", "shareday__none", "Fully booked"));
      } else {
        var row = el("div", "shareday__times");
        day.times.forEach(function (t) { row.appendChild(el("span", "sharechip", to12h(toMin(t)))); });
        card.appendChild(row);
      }
      body.appendChild(card);
    });

    var foot = el("p", "share__foot",
      "This is a read-only snapshot of open times as of now — not a live booking page. Times may change; confirm when you message.");
    body.appendChild(foot);
    showSheet("#shareSheet");
  }

  function snapshotText() {
    var snap = buildSnapshot();
    var lines = [];
    if (snap.biz) lines.push(snap.biz);
    lines.push("Available for " + snap.svc + " (" + snap.dur + " min" + (snap.price > 0 ? ", ₱" + snap.price : "") + ")");
    if (snap.contact) lines.push(snap.contact);
    lines.push("");
    snap.days.forEach(function (day) {
      if (day.off) return;
      if (!day.times.length) { lines.push(day.label + ": fully booked"); return; }
      lines.push(day.label + ":");
      lines.push("  " + day.times.map(function (t) { return to12h(toMin(t)); }).join(", "));
    });
    lines.push("");
    lines.push("(Read-only snapshot — message me to confirm a time.)");
    return lines.join("\n");
  }

  function copyText() {
    var text = snapshotText();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("Copied to clipboard."); },
        function () { fallbackCopy(text); });
    } else { fallbackCopy(text); }
  }
  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
      toast("Copied to clipboard.");
    } catch (e) { toast("Copy failed — select the snapshot manually."); }
  }

  /* ============================================================
     CSV export (RFC-4180)
     ============================================================ */
  function csvCell(v) {
    v = String(v == null ? "" : v);
    if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }
  function exportCSV() {
    var rows = state.bookings.slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start;
    });
    var header = ["date", "start", "end", "service", "duration_min", "price", "client", "note"];
    var lines = [header.map(csvCell).join(",")];
    rows.forEach(function (b) {
      lines.push([
        b.date, toHHMM(b.start), toHHMM(b.end), b.serviceName,
        (b.end - b.start), b.price, b.client, b.note
      ].map(csvCell).join(","));
    });
    var csv = lines.join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "slotone-bookings-" + isoDate(new Date()) + ".csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast(rows.length + " booking" + (rows.length === 1 ? "" : "s") + " exported.");
  }

  /* ============================================================
     SETTINGS UI
     ============================================================ */
  function renderSettings() {
    $("#bizName").value = state.biz;
    $("#bizContact").value = state.contact;
    setSelect($("#interval"), state.interval);
    setSelect($("#buffer"), state.buffer);
    renderHours();
    renderServices();
    renderBlocks();
  }
  function setSelect(sel, val) {
    var v = String(val);
    for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === v) { sel.selectedIndex = i; return; }
  }

  function renderHours() {
    var wrap = $("#hours");
    wrap.innerHTML = "";
    // display Mon..Sun for a natural work-week order
    var order = [1, 2, 3, 4, 5, 6, 0];
    order.forEach(function (dow) {
      var h = state.hours[dow];
      var row = el("div", "hourrow" + (h.on ? "" : " is-off"));
      var tog = el("label", "hourrow__toggle");
      var cb = el("input"); cb.type = "checkbox"; cb.checked = h.on;
      cb.setAttribute("aria-label", DOW_FULL[dow] + " working");
      cb.addEventListener("change", function () { h.on = cb.checked; save(); renderHours(); refresh(); });
      tog.appendChild(cb);
      tog.appendChild(el("span", "hourrow__day", DOW[dow]));
      row.appendChild(tog);

      var open = el("input"); open.type = "time"; open.value = h.open;
      open.setAttribute("aria-label", DOW_FULL[dow] + " open time");
      open.addEventListener("change", function () { h.open = open.value; save(); refresh(); });
      row.appendChild(open);

      row.appendChild(el("span", "hourrow__dash", "to"));

      var close = el("input"); close.type = "time"; close.value = h.close;
      close.setAttribute("aria-label", DOW_FULL[dow] + " close time");
      close.addEventListener("change", function () { h.close = close.value; save(); refresh(); });
      row.appendChild(close);

      wrap.appendChild(row);
    });
  }

  function renderServices() {
    var wrap = $("#servicesList");
    wrap.innerHTML = "";
    state.services.forEach(function (svc) {
      var row = el("div", "svcitem");

      var sw = el("label", "svcitem__swatch");
      sw.style.background = svc.color;
      sw.title = "Colour for " + (svc.name || "service");
      var col = el("input"); col.type = "color"; col.value = normColor(svc.color);
      col.setAttribute("aria-label", "Colour for " + (svc.name || "service"));
      col.addEventListener("input", function () { svc.color = col.value; sw.style.background = col.value; save(); refresh(); });
      sw.appendChild(col);
      row.appendChild(sw);

      var name = el("input"); name.type = "text"; name.value = svc.name; name.placeholder = "Service name";
      name.setAttribute("aria-label", "Service name");
      name.addEventListener("input", function () { svc.name = name.value; save(); refreshServiceSelect(); refresh(); });
      row.appendChild(name);

      var dur = el("input"); dur.type = "number"; dur.min = "5"; dur.max = "600"; dur.step = "5"; dur.value = svc.dur;
      dur.setAttribute("aria-label", "Duration in minutes for " + (svc.name || "service"));
      dur.addEventListener("input", function () {
        var v = parseInt(dur.value, 10); svc.dur = (isNaN(v) || v < 5) ? 5 : v; save(); refreshServiceSelect(); refresh();
      });
      row.appendChild(dur);
      row.appendChild(el("span", "svcitem__unit", "min"));

      var price = el("input"); price.type = "number"; price.min = "0"; price.step = "10"; price.value = svc.price;
      price.setAttribute("aria-label", "Price for " + (svc.name || "service"));
      price.addEventListener("input", function () { var v = parseInt(price.value, 10); svc.price = (isNaN(v) || v < 0) ? 0 : v; save(); refresh(); });
      row.appendChild(price);

      var rm = el("button", "rmbtn", "×"); rm.type = "button";
      rm.setAttribute("aria-label", "Remove service " + (svc.name || ""));
      rm.addEventListener("click", function () {
        if (state.services.length <= 1) { toast("Keep at least one service."); return; }
        state.services = state.services.filter(function (x) { return x.id !== svc.id; });
        if (activeServiceId === svc.id) activeServiceId = state.services[0].id;
        save(); renderServices(); refreshServiceSelect(); refresh();
      });
      row.appendChild(rm);

      wrap.appendChild(row);
    });
  }
  function normColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c || "") ? c : "#C8912F"; }

  function renderBlocks() {
    var wrap = $("#blocksList");
    wrap.innerHTML = "";
    if (!state.blocks.length) {
      wrap.appendChild(el("p", "hint", "No blocked dates. Add one to close a holiday or carve out a busy window."));
    }
    state.blocks.forEach(function (bl) {
      var row = el("div", "blockitem");
      var date = el("input"); date.type = "date"; date.value = bl.date;
      date.setAttribute("aria-label", "Blocked date");
      date.addEventListener("change", function () { bl.date = date.value; save(); refresh(); });
      row.appendChild(date);

      var from = el("input"); from.type = "time"; from.value = bl.start;
      from.setAttribute("aria-label", "Block start time (leave blank for whole day)");
      from.addEventListener("change", function () { bl.start = from.value; save(); refresh(); });
      row.appendChild(from);

      row.appendChild(el("span", "blockitem__to", "to"));

      var to = el("input"); to.type = "time"; to.value = bl.end;
      to.setAttribute("aria-label", "Block end time (leave blank for whole day)");
      to.addEventListener("change", function () { bl.end = to.value; save(); refresh(); });
      row.appendChild(to);

      var rm = el("button", "rmbtn", "×"); rm.type = "button";
      rm.setAttribute("aria-label", "Remove block");
      rm.addEventListener("click", function () {
        state.blocks = state.blocks.filter(function (x) { return x.id !== bl.id; });
        save(); renderBlocks(); refresh();
      });
      row.appendChild(rm);

      wrap.appendChild(row);
    });
  }

  /* ---------- service <select> in toolbar ---------- */
  function refreshServiceSelect() {
    var sel = $("#serviceSelect");
    var cur = activeServiceId;
    sel.innerHTML = "";
    state.services.forEach(function (svc) {
      var o = el("option", null, svc.name + " · " + svc.dur + "m" + (svc.price > 0 ? " · ₱" + svc.price : ""));
      o.value = svc.id;
      sel.appendChild(o);
    });
    if (!serviceById(cur)) activeServiceId = state.services.length ? state.services[0].id : null;
    if (activeServiceId) sel.value = activeServiceId;
  }

  /* ============================================================
     SHEET show/hide + toast
     ============================================================ */
  var lastFocus = null;
  function showSheet(sel) {
    lastFocus = document.activeElement;
    $(sel).hidden = false;
  }
  function hideSheet(sel) {
    $(sel).hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2400);
  }

  /* ============================================================
     REFRESH
     ============================================================ */
  function refresh() {
    $("#dateInput").value = isoDate(selected);
    $("#tabDay").classList.toggle("is-active", view === "day");
    $("#tabWeek").classList.toggle("is-active", view === "week");
    $("#tabDay").setAttribute("aria-selected", view === "day" ? "true" : "false");
    $("#tabWeek").setAttribute("aria-selected", view === "week" ? "true" : "false");
    renderHead();
    renderGrid();
  }

  /* ============================================================
     TIME-GRID SIGNATURE (hero background)
     ============================================================ */
  function renderTimeGrid() {
    var g = $(".tgrid__lines");
    if (!g) return;
    var W = 1440, H = 460;
    var frag = document.createDocumentFragment();
    var rowH = 46;
    // horizontal ruled rows
    for (var y = rowH; y < H; y += rowH) {
      var ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
      ln.setAttribute("x1", 0); ln.setAttribute("x2", W);
      ln.setAttribute("y1", y); ln.setAttribute("y2", y);
      frag.appendChild(ln);
    }
    // faint vertical hour columns
    var colW = 120;
    for (var x = colW; x < W; x += colW) {
      var v = document.createElementNS("http://www.w3.org/2000/svg", "line");
      v.setAttribute("x1", x); v.setAttribute("x2", x);
      v.setAttribute("y1", 0); v.setAttribute("y2", H);
      v.setAttribute("opacity", "0.5");
      frag.appendChild(v);
    }
    // a scatter of "filled slot" bars — the appointment-card motif
    var seedBars = [
      [1, 1], [3, 2], [2, 4], [5, 3], [4, 6], [7, 2], [8, 5], [6, 7], [9, 4], [10, 6], [2, 8], [5, 8]
    ];
    seedBars.forEach(function (p) {
      var col = p[0], row = p[1];
      var rx = col * colW + 14;
      var ry = row * rowH + 12;
      if (rx > W - 40 || ry > H - 20) return;
      var r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      r.setAttribute("x", rx); r.setAttribute("y", ry);
      r.setAttribute("width", colW - 28); r.setAttribute("height", rowH - 24);
      r.setAttribute("rx", 5);
      frag.appendChild(r);
    });
    g.appendChild(frag);
  }

  /* ============================================================
     WIRE UP
     ============================================================ */
  function init() {
    load();
    activeServiceId = state.services.length ? state.services[0].id : null;

    // toolbar: date nav
    $("#dateInput").value = isoDate(selected);
    $("#dateInput").addEventListener("change", function () {
      var d = parseISO($("#dateInput").value);
      if (d) { selected = d; refresh(); }
    });
    $("#prevDay").addEventListener("click", function () { selected = addDays(selected, view === "week" ? -7 : -1); refresh(); });
    $("#nextDay").addEventListener("click", function () { selected = addDays(selected, view === "week" ? 7 : 1); refresh(); });
    $("#todayBtn").addEventListener("click", function () {
      var n = new Date(); selected = new Date(n.getFullYear(), n.getMonth(), n.getDate()); refresh();
    });

    // view tabs
    $("#tabDay").addEventListener("click", function () { view = "day"; refresh(); });
    $("#tabWeek").addEventListener("click", function () { view = "week"; refresh(); });

    // service select
    $("#serviceSelect").addEventListener("change", function () { activeServiceId = $("#serviceSelect").value; refresh(); });

    // settings toggle
    $("#settingsBtn").addEventListener("click", function () {
      var s = $("#settings");
      var open = s.hidden;
      s.hidden = !open;
      $("#settingsBtn").setAttribute("aria-expanded", open ? "true" : "false");
      if (open) s.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    // business fields
    $("#bizName").addEventListener("input", function () { state.biz = $("#bizName").value; save(); });
    $("#bizContact").addEventListener("input", function () { state.contact = $("#bizContact").value; save(); });
    $("#interval").addEventListener("change", function () { state.interval = parseInt($("#interval").value, 10) || 15; save(); refresh(); });
    $("#buffer").addEventListener("change", function () { state.buffer = parseInt($("#buffer").value, 10) || 0; save(); refresh(); });

    $("#addService").addEventListener("click", function () {
      var palette = ["#C8912F", "#2A5DB0", "#2f8f6b", "#8f4fbf", "#b0532b"];
      state.services.push({ id: uid("s"), name: "New service", dur: 30, price: 0, color: palette[state.services.length % palette.length] });
      save(); renderServices(); refreshServiceSelect(); refresh();
    });
    $("#addBlock").addEventListener("click", function () {
      state.blocks.push({ id: uid("bl"), date: isoDate(selected), start: "", end: "" });
      save(); renderBlocks(); refresh();
    });

    $("#wipeBtn").addEventListener("click", function () {
      if (!window.confirm("Erase ALL slotone data on this device — settings, services, and every booking? This cannot be undone.")) return;
      try { localStorage.removeItem(KEY); } catch (e) {}
      state = JSON.parse(JSON.stringify(DEFAULT_STATE));
      activeServiceId = state.services[0].id;
      save();
      renderSettings(); refreshServiceSelect(); refresh();
      toast("All data erased.");
    });

    // actions
    $("#printBtn").addEventListener("click", function () {
      if (!$("#settings").hidden) { /* keep settings out of print via CSS */ }
      window.print();
    });
    $("#exportBtn").addEventListener("click", exportCSV);
    $("#shareBtn").addEventListener("click", renderShare);

    // book dialog
    $("#bookForm").addEventListener("submit", function (e) { e.preventDefault(); confirmBook(); });
    $("#bookCancel").addEventListener("click", function () { hideSheet("#bookSheet"); pending = null; });
    $("#bookBackdrop").addEventListener("click", function () { hideSheet("#bookSheet"); pending = null; });

    // share dialog
    $("#shareClose").addEventListener("click", function () { hideSheet("#shareSheet"); });
    $("#shareBackdrop").addEventListener("click", function () { hideSheet("#shareSheet"); });
    $("#shareCopy").addEventListener("click", copyText);
    $("#sharePrint").addEventListener("click", function () { window.print(); });

    // Esc closes any open sheet
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (!$("#bookSheet").hidden) { hideSheet("#bookSheet"); pending = null; }
        if (!$("#shareSheet").hidden) { hideSheet("#shareSheet"); }
      }
    });

    renderSettings();
    refreshServiceSelect();
    renderTimeGrid();
    refresh();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
