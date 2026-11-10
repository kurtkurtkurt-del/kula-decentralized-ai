/* kula-node dashboard. no dependencies: an EventSource for the live state,
   fetch for the few actions. every url is relative, so the random prefix the
   page was opened under is kept without the script ever knowing it. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var mb = function (n) { return n == null ? '?' : n >= 1024 ? (n / 1024).toFixed(1) + ' gb' : n + ' mb'; };
  var bytes = function (n) { return n < 1024 ? n + ' b' : n < 1048576 ? (n / 1024).toFixed(1) + ' kb' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' mb' : (n / 1073741824).toFixed(2) + ' gb'; };
  var when = function (t) { return t ? new Date(t).toTimeString().slice(0, 8) : '—'; };
  var ago = function (t) { if (!t) return ''; var s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + ' s' : s < 3600 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + ' h'; };
  var S = null;

  function post(route, body) {
    return fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), credentials: 'omit' });
  }
  // reads an sse response from fetch, one json object per data line
  function readSse(res, onEvent) {
    if (!res.ok) return res.json().catch(function () { return { error: 'http ' + res.status }; }).then(function (o) { throw new Error(o.error || 'http ' + res.status); });
    var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
    return reader.read().then(function step(r) {
      if (r.done) return;
      buf += dec.decode(r.value, { stream: true });
      var i;
      while ((i = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line.indexOf('data:') !== 0) continue;
        try { onEvent(JSON.parse(line.slice(5).trim())); } catch (e) {}
      }
      return reader.read().then(step);
    });
  }

  // ---- render --------------------------------------------------------------
  function rSelf() {
    var s = S.self, p = s.passport || null;
    $('who').textContent = '· ' + s.name;
    $('self-name').textContent = (p && p.device ? String(p.device) : s.name).toLowerCase();
    $('self-sub').textContent = [p && p.soc, p && p.os, s.host ? 'lan ' + s.host : 'no lan address'].filter(Boolean).join(' · ');
    var rows = [
      ['memory', mb(s.totalRam) + ' · ' + mb(s.ram) + ' free'],
      ['bandwidth', s.bw + ' gb/s' + (p && p.mem_bw_read_gbs ? ' · passport ' + p.mem_bw_read_gbs : '')],
      ['gpu', s.gpu ? s.gpu + (s.vram ? ' · ' + mb(s.vram) : '') : 'none / unknown'],
    ];
    if (p) {
      var e = p.estimate || {}, b = p.budget || {};
      if (p.gflops) rows.push(['compute', p.gflops + ' gflops']);
      if (b.ram_gb !== undefined) rows.push(['model budget', b.ram_gb + ' gb · ~' + b.q4_k_m_b + 'B q4']);
      rows.push(['alone', e.tps_high ? '~' + e.fit_b + 'B · ' + e.tps_low + '–' + e.tps_high + ' tok/s' : (p.largest_model_q4 || '?') + ' · ' + (p.est_tps || '?') + ' tok/s']);
      rows.push(['measured', (p.approx ? 'approximate · ' : '') + String(p.measured_at || '').slice(0, 16).replace('T', ' ')]);
    }
    rows.push(['id', s.id.slice(0, 8)]);
    $('self-facts').innerHTML = rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('');
    $('self-hint').textContent = p ? 'passport: ' + s.passportFile : 'no passport: measure on the pc/ page and put passport.json in ~/.kula-node/.';
  }
  function rGate() {
    var g = S.gate, el = $('gate-state');
    if (S.mode === 'chat') { el.textContent = 'master'; el.className = 'big on'; $('gate-sub').textContent = 'this computer runs the cluster; the gate is not open.'; $('gate-facts').innerHTML = ''; return; }
    if (!g.port) { el.textContent = 'opening'; el.className = 'big wait'; }
    else if (g.open.length) {
      var peers = {}; g.open.forEach(function (o) { peers[o.peer] = 1; });
      el.textContent = 'master connected'; el.className = 'big on';
      $('gate-sub').textContent = 'from: ' + Object.keys(peers).join(', ');
    } else { el.textContent = 'waiting'; el.className = 'big wait'; $('gate-sub').textContent = g.lastPeer ? 'last connected ' + g.lastPeer + ' · ' + ago(g.lastAt) + ' ago' : 'no phone has connected yet'; }
    var rows = [['gate', g.port ? '0.0.0.0:' + g.port : '—']];
    g.open.forEach(function (o) { rows.push([o.channel, o.peer + ' · ' + ago(o.since)]); });
    if (g.lastReject) rows.push(['last refusal', g.lastReject.peer + ' · ' + g.lastReject.reason + ' · ' + when(g.lastReject.at)]);
    $('gate-facts').innerHTML = rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('');
  }
  function rTraffic() {
    var t = S.traffic, open = { rpc: 0, api: 0 };
    S.gate.open.forEach(function (o) { open[o.channel]++; });
    $('traffic').innerHTML = ['rpc', 'api'].map(function (c) {
      var x = t[c];
      return '<tr><td class="name">' + c + '</td><td>' + open[c] + '</td><td>' + x.opens + '</td><td>' + bytes(x.bytesIn) + '</td><td>' + bytes(x.bytesOut) + '</td><td>' + (x.rejects ? '<span class="warn">' + x.rejects + '</span>' : '0') + '</td></tr>';
    }).join('');
  }
  function rModel() {
    var a = S.api;
    $('model-name').textContent = a.loaded ? a.model : (a.running ? 'not loaded' : (S.mode === 'chat' ? (a.model || 'not loaded') : 'the worker api has not started yet'));
    $('model-sub').textContent = a.loaded ? ['context ' + a.ctx, 'held ' + mb(a.heldMB), a.tokensUsed + ' tok made'].join(' · ') : (S.mode === 'share' ? 'loaded on the master\'s first /load, or from below.' : '');
    $('model-busy').hidden = !a.busy;
    var canLoad = S.mode === 'share' && S.models.length;
    $('model-load').hidden = !canLoad;
    if (canLoad) {
      var pick = $('model-pick'), cur = pick.value;
      pick.innerHTML = S.models.map(function (m) { return '<option' + (m === cur ? ' selected' : '') + '>' + esc(m) + '</option>'; }).join('');
    }
  }
  function dot(r) {
    if (!r) return '<span class="dot"></span>—';
    if (r.ok) return '<span class="dot ok"></span>' + r.ms + ' ms';
    if (r.reason === 'channel closed') return '<span class="dot half"></span>channel closed';
    return '<span class="dot no"></span>' + esc(r.reason);
  }
  function rPeers() {
    var list = S.peers;
    $('peers-empty').hidden = !!list.length;
    $('peers').innerHTML = list.map(function (p) {
      return '<tr><td class="name">' + esc(p.name) + '</td><td>' + p.badges.map(function (b) { return '<span class="badge">' + esc(b) + '</span>'; }).join('') + '</td><td>' + esc(p.host + ':' + p.port) + '</td><td>' + mb(p.ram) + '</td><td>' + (p.bw == null ? '?' : p.bw + ' gb/s') + '</td><td>' + dot(p.reach && p.reach.rpc) + '</td><td>' + dot(p.reach && p.reach.api) + '</td><td>' + (p.probedAt ? ago(p.probedAt) + ' ago' : (p.last_ok ? String(p.last_ok).slice(0, 16).replace('T', ' ') : '—')) + '</td></tr>';
    }).join('');
  }
  // share mode: the devices paired with this gate, each with "remove access"
  function rPaired() {
    var list = S.paired || [];
    $('c-paired').hidden = S.mode !== 'share';
    $('paired-empty').hidden = !!list.length;
    $('paired').innerHTML = list.map(function (d) {
      return '<tr><td class="name">' + esc(d.name || 'unnamed device') + '</td><td><code>' + esc(d.fp.slice(0, 8) + ' ' + d.fp.slice(8, 16)) + '</code></td><td>' + esc(d.address || '?') + '</td><td>' + (d.pairedAt ? esc(new Date(d.pairedAt).toISOString().slice(0, 16).replace('T', ' ')) : '?') + '</td><td>' + (d.lastSeen ? ago(d.lastSeen) + ' ago' : 'never') + '</td><td><button class="line" data-unpair="' + esc(d.fp) + '" data-name="' + esc(d.name || d.fp.slice(0, 16)) + '">remove access</button></td></tr>';
    }).join('');
  }
  function rDevices() {
    var sel = $('chat-dev'), cur = sel.value;
    var opts = '<option value="">the fastest free device</option>' + S.devices.map(function (d) { return '<option value="' + esc(d.name) + '"' + (d.name === cur ? ' selected' : '') + '>' + esc(d.name) + (d.tps ? ' · ' + d.tps + ' tok/s' : '') + (d.busy ? ' · busy' : '') + '</option>'; }).join('');
    sel.innerHTML = opts;
    sel.hidden = !S.devices.length;
  }
  function rLedger() {
    var l = S.ledger, v = l.verify;
    $('ledger-state').innerHTML = (l.total + ' lines · ' + esc(l.file)) + (v ? ' · <span class="' + (v.ok ? 'ok' : 'err') + '">' + (v.ok ? 'chain intact, ' + v.count + ' lines, key ' + esc(v.keyId.slice(0, 8)) : 'chain broken: ' + v.problems.map(function (p) { return 'line ' + p.n + ' ' + p.reason; }).join(', ')) + '</span> · ' + when(v.at) : '');
    $('ledger').textContent = l.lines.map(function (line) {
      try { var o = JSON.parse(line); return when(o.t) + '  ' + (o.kind || '?').padEnd(8) + ' ' + (o.peer || '') + '  ' + Object.keys(o).filter(function (k) { return ['t', 'kind', 'peer', 'prev', 'sig', 'v', 'dev'].indexOf(k) < 0; }).map(function (k) { return k + '=' + JSON.stringify(o[k]); }).join(' '); } catch (e) { return line; }
    }).join('\n') || 'ledger empty';
  }
  function rQr() {
    $('qr').hidden = !S.hasQr;
    if (S.hasQr) $('qr-img').src = 'qr.svg?' + Date.now();
    $('qr-hint').textContent = S.hasQr ? 'kula → together → add a computer → scan this code. the code carries the cluster\'s secret: this picture is its only place on the page.' : (S.mode === 'chat' ? 'no pairing code in master mode; workers are added from the phone.' : 'the code shows here once the gate is open.');
  }
  function rLog() { var el = $('log'); el.textContent = S.log.join('\n'); el.scrollTop = el.scrollHeight; }
  function rMode() {
    var m = $('mode'); m.textContent = S.mode === 'share' ? 'worker · share' : 'master · chat'; m.className = 'chip on';
    $('up').textContent = 'up ' + ago(S.startedAt);
    $('probe').hidden = !S.peers.length && S.mode === 'chat';
  }
  function rAll() { rMode(); rSelf(); rGate(); rTraffic(); rModel(); rPeers(); rPaired(); rDevices(); rLedger(); rQr(); rLog(); }

  // ---- live ------------------------------------------------------------------
  var es = new EventSource('events');
  es.addEventListener('snapshot', function (e) { S = JSON.parse(e.data); rAll(); $('live').textContent = 'live'; $('live').className = 'chip on'; });
  var on = function (kind, key, fn) { es.addEventListener(kind, function (e) { if (!S) return; S[key] = JSON.parse(e.data); fn(); }); };
  on('self', 'self', rSelf);
  on('gate', 'gate', function () { rGate(); rTraffic(); });
  on('traffic', 'traffic', rTraffic);
  on('api', 'api', rModel);
  on('peers', 'peers', rPeers);
  on('paired', 'paired', rPaired);
  on('devices', 'devices', rDevices);
  on('ledger', 'ledger', rLedger);
  on('models', 'models', rModel);
  es.addEventListener('qr', function (e) { if (!S) return; S.hasQr = JSON.parse(e.data); rQr(); });
  es.addEventListener('log', function (e) { if (!S) return; S.log.push(JSON.parse(e.data)); if (S.log.length > 80) S.log.shift(); rLog(); });
  es.onerror = function () { $('live').textContent = 'disconnected · retrying'; $('live').className = 'chip bad'; };
  setInterval(function () { if (S) { rMode(); rGate(); } }, 10000);

  // ---- actions ---------------------------------------------------------------
  $('probe').onclick = function () {
    var b = $('probe'); b.disabled = true; b.textContent = 'probing…';
    post('probe').then(function (r) { return r.json(); }).then(function (o) { if (o.error) alert(o.error); }).catch(function (e) { alert(e.message); }).then(function () { b.disabled = false; b.textContent = 'probe'; });
  };
  $('verify').onclick = function () {
    var b = $('verify'); b.disabled = true;
    post('verify').then(function (r) { return r.json(); }).then(function (o) { if (o.error) alert(o.error); }).catch(function (e) { alert(e.message); }).then(function () { b.disabled = false; });
  };
  $('paired').onclick = function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-unpair]') : null;
    if (!b) return;
    var name = b.getAttribute('data-name');
    if (!confirm('remove ' + name + '\'s access to this computer?\n\nits new connections are refused and its open ones close. to come back it has to pair again with a new code.')) return;
    b.disabled = true;
    post('unpair', { fp: b.getAttribute('data-unpair') }).then(function (r) { return r.json(); }).then(function (o) { if (o.error) alert(o.error); }).catch(function (err) { alert(err.message); }).then(function () { b.disabled = false; });
  };
  $('model-go').onclick = function () {
    var b = $('model-go'), m = $('model-pick').value; b.disabled = true; $('model-msg').textContent = 'loading…';
    post('load', { model: m }).then(function (r) { return r.json(); }).then(function (o) { $('model-msg').textContent = o.error ? 'failed: ' + o.error : 'ready'; }).catch(function (e) { $('model-msg').textContent = e.message; }).then(function () { b.disabled = false; });
  };

  var history = [];
  function bubble(role, text) {
    var d = document.createElement('p'); d.className = 'msg';
    d.innerHTML = '<b>' + (role === 'user' ? 'you' : 'device') + '</b><span></span>';
    d.lastChild.textContent = text; $('chat-out').appendChild(d); $('chat-out').scrollTop = 1e9; return d.lastChild;
  }
  function sendChat() {
    var text = $('chat-in').value.trim();
    if (!text) return;
    $('chat-in').value = ''; $('chat-send').disabled = true; $('chat-stat').textContent = 'sent…';
    history.push({ role: 'user', content: text });
    bubble('user', text);
    var span = bubble('assistant', ''), reply = '';
    post('chat', { messages: history, maxTokens: 256, device: $('chat-dev').value || undefined }).then(function (res) {
      return readSse(res, function (o) {
        if (o.t) { reply += o.t; span.textContent = reply; $('chat-out').scrollTop = 1e9; }
        if (o.error) { span.innerHTML = '<span class="err">' + esc(o.error) + '</span>'; $('chat-stat').textContent = ''; }
        if (o.done) { history.push({ role: 'assistant', content: reply }); $('chat-stat').textContent = o.device + ' · ' + o.tokens + ' tok · ' + o.tps + ' tok/s · first ' + o.firstMs + ' ms'; }
      });
    }).catch(function (e) { span.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; $('chat-stat').textContent = ''; }).then(function () { $('chat-send').disabled = false; });
  }
  $('chat-send').onclick = sendChat;
  $('chat-in').onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } };
  $('chat-reset').onclick = function () { history = []; $('chat-out').innerHTML = ''; $('chat-stat').textContent = ''; };

  $('batch-go').onclick = function () {
    var b = $('batch-go'); b.disabled = true; $('bars').innerHTML = ''; $('batch-log').textContent = '';
    var per = {}, n = 0, total = 8;
    var draw = function (report) {
      var rows = report || Object.keys(per).map(function (k) { var x = per[k]; return { device: k, prompts: x.prompts, tokens: x.tokens, tps: Math.round((x.tokens / Math.max(1, x.genMs)) * 10000) / 10 }; });
      var max = Math.max.apply(null, rows.map(function (r) { return r.tps; }).concat([1]));
      var box = $('bars'); box.innerHTML = '';
      rows.forEach(function (r) {
        var row = document.createElement('div'); row.className = 'bar';
        row.innerHTML = '<span></span><div class="track"><div class="fill"></div></div><span class="n"></span>';
        row.firstChild.textContent = r.device;
        row.querySelector('.fill').style.width = Math.round(100 * r.tps / max) + '%'; // cssom, not an inline attribute: the csp allows it
        row.lastChild.textContent = r.prompts + ' prompts · ' + r.tps + ' tok/s';
        box.appendChild(row);
      });
    };
    post('batch', {}).then(function (res) {
      return readSse(res, function (o) {
        if (o.start) { total = o.prompts.length; $('batch-stat').textContent = '0 / ' + total; }
        if (o.i !== undefined) {
          n++; $('batch-stat').textContent = n + ' / ' + total;
          var x = per[o.device] || (per[o.device] = { prompts: 0, tokens: 0, genMs: 0 });
          x.prompts++; x.tokens += o.tokens; x.genMs += Math.max(1, o.ms - o.firstMs);
          $('batch-log').textContent += '#' + (o.i + 1) + ' ' + o.device + ': ' + o.tokens + ' tok, ' + o.tps + ' tok/s\n';
          draw();
        }
        if (o.done) { draw(o.report); $('batch-stat').textContent = total + ' prompts in ' + o.seconds + ' s'; }
        if (o.error) { $('batch-stat').innerHTML = '<span class="err">' + esc(o.error) + '</span>'; }
      });
    }).catch(function (e) { $('batch-stat').innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }).then(function () { b.disabled = false; });
  };
})();
