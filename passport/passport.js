/* afterhours — passport/ (21.10.2026): your devices together, one number.

   The page measures the computer it is open on as soon as it opens (in the
   browser, so roughly: cores, memory, a Float32Array copy for bandwidth, a
   matrix multiply on every core for gflops) and shows one number — the
   tokens a second of every device together. The other devices come in as
   their passport json, pasted (the app: copy json); they stay in
   localStorage. Under the list, this computer as a qr code for the phone's
   passport tab (connect). A connect id from the phone hands it over without a
   camera: the page builds the Terminal command for a Mac (mac.sh, a native
   measurement) and sends its own measurement on request. The passport is the app's shape, passport/0.2,
   kind "computer", approx true. The rule for the model and the speed is the
   app's: usable = free ram × 0.8 (not the app memory cap: a model runner
   uses native memory), ~0.6 gb per 1B; tok/s =
   bandwidth / size × 0.5. The speed adds up across devices; the model does
   not (memory is not pooled), so the line under the number names the best
   device's model. */

(function () {
  var AH = (window.AH = window.AH || {});
  var $ = function (id) { return document.getElementById(id); };
  var STEPS = [1, 3, 4, 7, 8, 12, 14];
  var ID_KEY = "afterhours.passport.device";
  var LIST_KEY = "afterhours.passport.linked";
  var mine = null;

  var r1 = function (n) { return Math.round(n * 10) / 10; };
  var r2 = function (n) { return Math.round(n * 100) / 100; };

  function deviceId() {
    try {
      var have = localStorage.getItem(ID_KEY);
      if (have) return have;
      var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
        var r = Math.floor(Math.random() * 16);
        return (c === "x" ? r : (r & 3) | 8).toString(16);
      });
      localStorage.setItem(ID_KEY, id);
      return id;
    } catch (_) { return "unknown"; }
  }

  // "mac · macos · chrome 152": what the browser lets on about the machine
  function whoAmI() {
    var ua = navigator.userAgent || "";
    var uad = navigator.userAgentData;
    var os = uad && uad.platform ? uad.platform.toLowerCase() : /Mac OS X/.test(ua) ? "macos" : /Windows/.test(ua) ? "windows" : /CrOS/.test(ua) ? "chromeos" : /Linux/.test(ua) ? "linux" : "";
    var browser = "";
    if (uad && uad.brands) {
      var real = uad.brands.filter(function (x) { return !/Not.A.Brand/i.test(x.brand); });
      var b = real.filter(function (x) { return !/Chromium/i.test(x.brand); })[0] || real[0];
      if (b) browser = (b.brand + " " + b.version).toLowerCase();
    }
    if (!browser || /chromium/.test(browser)) {
      var m = ua.match(/(Firefox|Edg|OPR|Chrome|Safari)\/(\d+)/g) || [];
      var pick = m.filter(function (x) { return !/^Safari/.test(x); })[0] || m[0] || "";
      if (pick) browser = pick.replace("/", " ").replace("Edg", "edge").replace("OPR", "opera").toLowerCase();
    }
    var device = /Macintosh/.test(ua) ? "mac" : /Windows/.test(ua) ? "pc" : /CrOS/.test(ua) ? "chromebook" : /Linux/.test(ua) ? "linux" : "computer";
    return { device: device, os: (os + (browser ? " · " + browser : "")).trim() || "browser" };
  }

  function estimateModel(ramFreeGb, memBwGbs) {
    var usable = ramFreeGb * 0.8;
    var fit = null;
    for (var i = STEPS.length - 1; i >= 0; i--) if (STEPS[i] * 0.6 <= usable) { fit = STEPS[i]; break; }
    var sizeGb = (fit || 1) * 0.6;
    var tps = sizeGb > 0 && memBwGbs > 0 ? r1((memBwGbs / sizeGb) * 0.5) : 0;
    return { label: fit === null ? "<1B" : "~" + fit + "B", tps: tps };
  }

  // 64 mb copied three times after a warm-up: read + write, so 2 × bytes per copy
  function bandwidth() {
    return new Promise(function (resolve) {
      setTimeout(function () {
        var n = 16 * 1024 * 1024;
        var a = new Float32Array(n), b = new Float32Array(n);
        b.set(a);
        var t0 = performance.now();
        for (var i = 0; i < 3; i++) b.set(a);
        resolve(r2((2 * n * 4 * 3) / Math.max(0.001, (performance.now() - t0) / 1000) / 1e9));
      }, 0);
    });
  }

  // the app's multiply (256×256, three times) on one worker per core; one thread if workers fail
  var MATMUL = "function matmul(times){var m=256;var x=new Float32Array(m*m),y=new Float32Array(m*m),z=new Float32Array(m*m);" +
    "for(var i=0;i<m*m;i++){x[i]=(i%7)*0.5;y[i]=(i%5)*0.25;}" +
    "for(var r=0;r<times;r++)for(var i=0;i<m;i++)for(var k=0;k<m;k++){var aik=x[i*m+k];for(var j=0;j<m;j++)z[i*m+j]+=aik*y[k*m+j];}return z[0];}";
  function gflopsOneThread() {
    var fn = new Function(MATMUL + "return matmul;")();
    fn(1);
    var t0 = performance.now();
    fn(3);
    return r2((3 * 2 * Math.pow(256, 3)) / Math.max(0.001, (performance.now() - t0) / 1000) / 1e9);
  }
  function gflops(cores) {
    var workers = Math.max(1, Math.min(cores || 1, 32));
    return new Promise(function (resolve) {
      var url = null, pool = [], done = 0, finished = false;
      var fallback = function () {
        if (finished) return;
        finished = true;
        pool.forEach(function (w) { try { w.terminate(); } catch (_) {} });
        if (url) URL.revokeObjectURL(url);
        resolve(gflopsOneThread());
      };
      try {
        url = URL.createObjectURL(new Blob([MATMUL + "onmessage=function(e){matmul(1);var t0=performance.now();matmul(e.data);postMessage(performance.now()-t0);};"], { type: "text/javascript" }));
        var guard = setTimeout(fallback, 20000);
        var t0 = performance.now();
        for (var i = 0; i < workers; i++) {
          var w = new Worker(url);
          w.onerror = fallback;
          w.onmessage = function () {
            done++;
            if (done < workers || finished) return;
            finished = true;
            clearTimeout(guard);
            var sec = Math.max(0.001, (performance.now() - t0) / 1000);
            pool.forEach(function (p) { p.terminate(); });
            URL.revokeObjectURL(url);
            resolve(r2((workers * 3 * 2 * Math.pow(256, 3)) / sec / 1e9));
          };
          w.postMessage(3);
          pool.push(w);
        }
      } catch (_) { fallback(); }
    });
  }
  function storage() {
    if (!(navigator.storage && navigator.storage.estimate)) return Promise.resolve(0);
    return navigator.storage.estimate().then(function (e) { return r1(Math.max(0, (e.quota || 0) - (e.usage || 0)) / Math.pow(1024, 3)); }).catch(function () { return 0; });
  }
  function battery() {
    if (!navigator.getBattery) return Promise.resolve({ pct: 0, charging: false });
    return navigator.getBattery().then(function (b) { return { pct: Math.round(b.level * 100), charging: !!b.charging }; }).catch(function () { return { pct: 0, charging: false }; });
  }

  // ram: the browser says it on chrome (never above 8); elsewhere 8 is assumed
  function measure() {
    var ramTotal = navigator.deviceMemory || 8;
    var cores = navigator.hardwareConcurrency || 1;
    var who = whoAmI();
    return bandwidth().then(function (bw) {
      return gflops(cores).then(function (g) {
        return Promise.all([storage(), battery()]).then(function (rest) {
          var ramFree = r1(ramTotal * 0.45), cap = Math.round(ramTotal * 1024 * 0.5);
          var est = estimateModel(ramFree, bw);
          return {
            schema: "passport/0.2", device: who.device, soc: "unknown", android: who.os,
            ram_total_gb: r1(ramTotal), ram_free_gb: ramFree, app_mem_cap_mb: cap,
            cpu_cores: cores, cpu_max_ghz: 0, mem_bw_gbs: bw, gflops: g,
            storage_free_gb: rest[0], battery_pct: rest[1].pct, charging: rest[1].charging,
            largest_model_q4: est.label, est_tps: est.tps, measured_at: new Date().toISOString(),
            approx: true, device_id: deviceId(), kind: "computer", os: who.os
          };
        });
      });
    });
  }

  // ---- the other devices, pasted ---------------------------------------
  function linked() {
    try { return JSON.parse(localStorage.getItem(LIST_KEY) || "[]"); } catch (_) { return []; }
  }
  function saveLinked(list) {
    try { localStorage.setItem(LIST_KEY, JSON.stringify(list)); } catch (_) {}
  }
  function same(a, b) { return a.device_id && b.device_id ? a.device_id === b.device_id : a.device === b.device && a.soc === b.soc; }
  function parse(text) {
    var p;
    try { p = JSON.parse(String(text).trim()); } catch (_) { throw new Error(AH.t("passport.err.not")); }
    if (!p || typeof p !== "object" || typeof p.schema !== "string" || !/^passport\/0\./.test(p.schema)) throw new Error(AH.t("passport.err.not"));
    if (typeof p.est_tps !== "number" || !(p.est_tps >= 0) || typeof p.device !== "string") throw new Error(AH.t("passport.err.incomplete"));
    if (mine && same(p, mine)) throw new Error(AH.t("passport.err.self"));
    return p;
  }
  function add(text) {
    var p = parse(text);
    saveLinked([p].concat(linked().filter(function (l) { return !same(l, p); })).slice(0, 8));
  }
  function remove(i) {
    var list = linked();
    list.splice(i, 1);
    saveLinked(list);
  }

  // ---- the page -------------------------------------------------------------
  var fitOf = function (label) { return label && label[0] !== "<" ? Number(String(label).replace(/[^0-9.]/g, "")) || 0 : 0; };
  function show() {
    var all = (mine ? [mine] : []).concat(linked());
    var tps = r1(all.reduce(function (a, p) { return a + (Number(p.est_tps) || 0); }, 0));
    var best = all.reduce(function (b, p) { return !b || fitOf(p.largest_model_q4) > fitOf(b.largest_model_q4) ? p : b; }, null);
    $("pp-tps").textContent = String(tps);
    $("pp-under").textContent = all.length ? AH.tn("passport.n", all.length) + " · " + AH.t("passport.best", { model: best.largest_model_q4 }) : "";
    var list = $("pp-list");
    list.innerHTML = "";
    all.forEach(function (p, i) {
      var row = document.createElement("div");
      row.className = "pp-row";
      var name = document.createElement("span");
      name.className = "pp-name";
      name.textContent = (p.device + " · " + (p.os || p.android || "")).toLowerCase();
      var v = document.createElement("span");
      v.className = "pp-v";
      v.textContent = p.est_tps + " tok/s";
      row.appendChild(name);
      row.appendChild(v);
      if (i === 0 && mine) {
        var me = document.createElement("span");
        me.className = "pp-me";
        me.textContent = AH.t("passport.this");
        row.appendChild(me);
      } else {
        var x = document.createElement("button");
        x.type = "button";
        x.className = "pp-x";
        x.setAttribute("aria-label", AH.t("passport.remove"));
        x.textContent = "×";
        x.addEventListener("click", function () { remove(mine ? i - 1 : i); show(); });
        row.appendChild(x);
      }
      list.appendChild(row);
    });
  }
  function drawCode(p) {
    var code = AH.qr(JSON.stringify(p));
    var canvas = $("pp-canvas"), quiet = 4, modules = code.size + quiet * 2;
    var px = Math.max(2, Math.floor(480 / modules));
    canvas.width = canvas.height = modules * px;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    for (var y = 0; y < code.size; y++) for (var x = 0; x < code.size; x++) if (code.get(x, y)) ctx.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
    $("pp-code").hidden = false;
  }

  // ---- to the phone by connect id ---------------------------------------------------
  // The Passport app shows a connect id and waits; the passport is dropped under it on
  // kula's server (backend/sql/17_passport_drops.sql) and the phone picks it up once.
  var ID_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
  function connectId() {
    var field = $("pp-id");
    var v = field.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    if (field.value !== v) field.value = v;
    return v;
  }
  function macCommand() {
    var here = location.href.split("#")[0].split("?")[0].replace(/[^/]*$/, "");
    var id = connectId();
    return "curl -fsSL " + here + "mac.sh | bash" + (ID_RE.test(id) ? " -s -- " + id : "");
  }
  function showCommand() { $("pp-cmd").textContent = macCommand(); }
  function sendToPhone() {
    var status = $("pp-sendstatus"), id = connectId(), cfg = window.AH_CONFIG || {};
    var fail = function (msg) { status.className = "account-status error"; status.textContent = msg; };
    if (!ID_RE.test(id)) return fail(AH.t("passport.send.badId"));
    if (!mine) return fail(AH.t("passport.measuring"));
    if (!cfg.url || !cfg.anonKey) return fail(AH.t("passport.send.offline"));
    status.className = "account-status";
    status.textContent = AH.t("passport.send.sending");
    fetch(cfg.url.replace(/\/$/, "") + "/rest/v1/rpc/passport_drop", {
      method: "POST",
      headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ p_code: id, p_data: mine })
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || String(r.status)); });
      status.className = "account-status ok";
      status.textContent = AH.t("passport.send.sent", { id: id });
    }).catch(function (e) { fail(AH.t("passport.send.failed") + " · " + String(e && e.message || e).slice(0, 120)); });
  }

  function init() {
    show();
    showCommand();
    $("pp-id").addEventListener("input", showCommand);
    $("pp-sendbtn").addEventListener("click", sendToPhone);
    $("pp-cmdcopy").addEventListener("click", function () {
      var done = function () { $("pp-sendstatus").className = "account-status"; $("pp-sendstatus").textContent = AH.t("passport.send.copied"); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(macCommand()).then(done, done);
    });
    $("pp-addbtn").addEventListener("click", function () {
      var status = $("pp-status"), field = $("pp-paste");
      try {
        add(field.value);
        field.value = "";
        status.className = "account-status";
        status.textContent = "";
        show();
      } catch (e) {
        status.className = "account-status error";
        status.textContent = e.message;
      }
    });
    measure().then(function (p) {
      mine = p;
      show();
      drawCode(p);
    }).catch(function () {
      $("pp-under").textContent = AH.t("passport.failed");
      show();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
