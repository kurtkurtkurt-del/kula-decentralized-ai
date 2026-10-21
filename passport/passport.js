/* afterhours — the computer's passport (21.10.2026).

   The app measures a phone with a Kotlin module; a computer has no app, so
   this page measures it in the browser and draws the result as a qr code
   (qr.js) for the phone to read (the app's passport tab: connect). The
   result is the same shape the app writes, passport/0.2, with
   kind "computer" and approx true — a browser measures itself more than
   the machine:

     cpu_cores      navigator.hardwareConcurrency
     ram_total_gb   navigator.deviceMemory where it exists (chrome; never
                    above 8), else what the person types; ram_free is taken
                    as 45% of it, like the app's own javascript fallback
     app_mem_cap_mb half the ram: what a local model runner would get
     mem_bw_gbs     a 64 mb Float32Array copied three times after a warm-up
     gflops         a 256×256 float matrix multiply, three times, on every
                    core at once (one worker per core; one thread if the
                    browser refuses workers)
     storage_free   navigator.storage.estimate(): what the browser may use
     battery        navigator.getBattery() where it exists
     largest_model_q4 / est_tps  the app's rule: usable = min(free, cap) × 0.8,
                    ~0.6 gb per 1B; tok/s = bandwidth / size × 0.5

   The device id is made once and kept in localStorage, so reading the
   code again on the phone replaces this computer instead of adding it.  */

(function () {
  var AH = (window.AH = window.AH || {});
  var $ = function (id) { return document.getElementById(id); };
  var STEPS = [1, 3, 4, 7, 8, 12, 14];
  var ID_KEY = "afterhours.passport.device";
  var RAM_KEY = "afterhours.passport.ram";
  var last = null;

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

  // "macbook · macos · chrome 130": what the browser lets on about the machine
  function whoAmI() {
    var ua = navigator.userAgent || "";
    var uad = navigator.userAgentData;
    var os = "";
    if (uad && uad.platform) os = uad.platform.toLowerCase();
    else if (/Mac OS X/.test(ua)) os = "macos";
    else if (/Windows/.test(ua)) os = "windows";
    else if (/CrOS/.test(ua)) os = "chromeos";
    else if (/Linux/.test(ua)) os = "linux";
    var browser = "";
    if (uad && uad.brands) {
      var b = uad.brands.filter(function (x) { return !/Not.A.Brand|Chromium/i.test(x.brand); })[0] || uad.brands[0];
      if (b) browser = (b.brand + " " + b.version).toLowerCase();
    }
    if (!browser) {
      var m = ua.match(/(Firefox|Edg|OPR|Chrome|Safari)\/(\d+)/g) || [];
      var pick = m.filter(function (x) { return !/^Safari/.test(x); })[0] || m[0] || "";
      browser = pick.replace("/", " ").replace("Edg", "edge").replace("OPR", "opera").toLowerCase();
    }
    var device = /Macintosh/.test(ua) ? "mac" : /Windows/.test(ua) ? "pc" : /CrOS/.test(ua) ? "chromebook" : /Linux/.test(ua) ? "linux box" : "computer";
    return { device: device, os: (os + (browser ? " · " + browser : "")).trim() || "browser" };
  }

  function estimateModel(ramFreeGb, appMemCapMb, memBwGbs) {
    var usable = Math.min(ramFreeGb, appMemCapMb / 1024) * 0.8;
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
        var sec = Math.max(0.001, (performance.now() - t0) / 1000);
        resolve(r2((2 * n * 4 * 3) / sec / 1e9));
      }, 0);
    });
  }

  // the same multiply the app does, as a function workers and the main thread share
  function matmulSource() {
    return "function matmul(times){var m=256;var x=new Float32Array(m*m),y=new Float32Array(m*m),z=new Float32Array(m*m);" +
      "for(var i=0;i<m*m;i++){x[i]=(i%7)*0.5;y[i]=(i%5)*0.25;}" +
      "for(var r=0;r<times;r++)for(var i=0;i<m;i++)for(var k=0;k<m;k++){var aik=x[i*m+k];for(var j=0;j<m;j++)z[i*m+j]+=aik*y[k*m+j];}return z[0];}";
  }
  function gflopsOneThread(cores) {
    var fn = new Function(matmulSource() + "return matmul;")();
    fn(1); // warm-up
    var t0 = performance.now();
    fn(3);
    var sec = Math.max(0.001, (performance.now() - t0) / 1000);
    return { gflops: r2((3 * 2 * Math.pow(256, 3)) / sec / 1e9), threads: 1, cores: cores };
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
        resolve(gflopsOneThread(cores));
      };
      try {
        var src = matmulSource() + "onmessage=function(e){matmul(1);var t0=performance.now();matmul(e.data);postMessage(performance.now()-t0);};";
        url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
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
            resolve({ gflops: r2((workers * 3 * 2 * Math.pow(256, 3)) / sec / 1e9), threads: workers, cores: cores });
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

  function ramTyped() {
    var v = parseFloat($("pp-ram").value);
    return v > 0 ? v : 0;
  }

  function measure() {
    var ramTotal = ramTyped();
    var cores = navigator.hardwareConcurrency || 1;
    var who = whoAmI();
    return bandwidth().then(function (bw) {
      return gflops(cores).then(function (g) {
        return Promise.all([storage(), battery()]).then(function (rest) {
          var ramFree = r1(ramTotal * 0.45);
          var cap = Math.round(ramTotal * 1024 * 0.5);
          var est = estimateModel(ramFree, cap, bw);
          return {
            schema: "passport/0.2",
            device: who.device,
            soc: "unknown",
            android: who.os,
            ram_total_gb: r1(ramTotal),
            ram_free_gb: ramFree,
            app_mem_cap_mb: cap,
            cpu_cores: cores,
            cpu_max_ghz: 0,
            mem_bw_gbs: bw,
            gflops: g.gflops,
            storage_free_gb: rest[0],
            battery_pct: rest[1].pct,
            charging: rest[1].charging,
            largest_model_q4: est.label,
            est_tps: est.tps,
            measured_at: new Date().toISOString(),
            approx: true,
            device_id: deviceId(),
            kind: "computer",
            os: who.os,
            threads: g.threads
          };
        });
      });
    });
  }

  // ---- the page -----------------------------------------------------------
  function row(k, v) {
    var d = document.createElement("div");
    d.className = "pp-row";
    var a = document.createElement("span"); a.className = "pp-k"; a.textContent = k;
    var b = document.createElement("span"); b.className = "pp-v"; b.textContent = v;
    d.appendChild(a); d.appendChild(b);
    return d;
  }
  function two(n) { return String(n).padStart(2, "0"); }
  function at(iso) {
    var d = new Date(iso);
    return two(d.getDate()) + "." + two(d.getMonth() + 1) + " " + two(d.getHours()) + ":" + two(d.getMinutes());
  }
  function draw(p) {
    var code = AH.qr(JSON.stringify(p));
    var canvas = $("pp-canvas"), quiet = 4, modules = code.size + quiet * 2;
    var px = Math.max(2, Math.floor(640 / modules)); // drawn at 2× for sharp modules
    canvas.width = canvas.height = modules * px;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    for (var y = 0; y < code.size; y++) for (var x = 0; x < code.size; x++) if (code.get(x, y)) ctx.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
    return code;
  }
  function show(p) {
    last = p;
    var t = AH.t;
    var rows = $("pp-rows");
    rows.innerHTML = "";
    rows.appendChild(row(t("passport.row.largest"), p.largest_model_q4 + " Q4 · " + p.est_tps + " tok/s"));
    rows.appendChild(row(t("passport.row.device"), p.device + " · " + p.os));
    rows.appendChild(row(t("passport.row.ram"), p.ram_total_gb ? p.ram_total_gb + " gb · " + p.ram_free_gb + " " + t("passport.row.free") : "—"));
    rows.appendChild(row(t("passport.row.cpu"), p.cpu_cores + " × " + (p.threads > 1 ? t("passport.row.threads", { n: p.threads }) : t("passport.row.oneThread"))));
    rows.appendChild(row(t("passport.row.bw"), p.mem_bw_gbs + " gb/s"));
    rows.appendChild(row(t("passport.row.compute"), p.gflops + " gflops"));
    rows.appendChild(row(t("passport.row.disk"), (p.storage_free_gb || "—") + " gb · " + (p.battery_pct || "—") + "%" + (p.charging ? " ⚡" : "")));
    rows.appendChild(row(t("passport.row.measured"), at(p.measured_at) + " · " + t("passport.row.approx")));
    var code = draw(p);
    var json = {};
    Object.keys(p).forEach(function (k) { if (k !== "threads") json[k] = p[k]; });
    $("pp-json").textContent = JSON.stringify(json, null, 2);
    $("pp-canvas").setAttribute("data-version", String(code.version));
    $("pp-form").hidden = true;
    $("pp-result").hidden = false;
  }

  function run() {
    var btn = $("pp-run"), status = $("pp-status");
    if (!ramTyped()) {
      status.className = "account-status error";
      status.textContent = AH.t("passport.ram.missing");
      $("pp-ram").focus();
      return;
    }
    try { localStorage.setItem(RAM_KEY, String(ramTyped())); } catch (_) {}
    btn.disabled = true;
    status.className = "account-status";
    status.textContent = AH.t("passport.measuring");
    measure().then(function (p) {
      show(p);
    }).catch(function (e) {
      status.className = "account-status error";
      status.textContent = AH.t("passport.failed") + " · " + String(e && e.message || e).toLowerCase();
    }).then(function () { btn.disabled = false; });
  }

  function init() {
    var ram = $("pp-ram");
    var known = navigator.deviceMemory;
    var remembered = null;
    try { remembered = parseFloat(localStorage.getItem(RAM_KEY)); } catch (_) {}
    if (remembered > 0) ram.value = remembered;
    else if (known) ram.value = known;
    if (known) $("pp-ram-about").textContent = AH.t("passport.ram.known", { n: known });
    $("pp-run").addEventListener("click", run);
    $("pp-again").addEventListener("click", function () {
      $("pp-result").hidden = true;
      $("pp-form").hidden = false;
      run();
    });
    $("pp-copy").addEventListener("click", function () {
      if (!last) return;
      var text = $("pp-json").textContent;
      var done = function () {
        $("pp-copied").textContent = AH.t("passport.copied");
        setTimeout(function () { $("pp-copied").textContent = ""; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else done();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
