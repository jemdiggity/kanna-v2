/**
 * The relay status dashboard: one self-contained HTML page, served by the relay
 * process at `GET /dashboard` and polling `GET /stats` for its data.
 *
 * A TypeScript module rather than a static asset on purpose: the relay's
 * Dockerfile copies `services/relay/src/` and runs `tsc`, so an `.html` file
 * next to it would compile to nothing and 404 in production. No external
 * stylesheet, script, or font — the page must render on a phone tethered to a
 * hotspot while the operator is looking at a broken relay.
 *
 * The page takes its bearer token from its own `?token=` query parameter and
 * sends it as a header on every poll, so the credential appears in the address
 * bar the operator opened and not in the relay's own request log for each poll.
 */
export const RELAY_STATUS_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Kanna relay status</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0d1117; --panel: #161b22; --line: #30363d;
    --fg: #e6edf3; --dim: #8b949e; --ok: #3fb950; --warn: #d29922; --bad: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px; background: var(--bg); color: var(--fg);
    font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  h1 { font-size: 15px; margin: 0; font-weight: 600; }
  h2 { font-size: 12px; margin: 0 0 8px; color: var(--dim); text-transform: uppercase; letter-spacing: .08em; }
  header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; margin-bottom: 14px; }
  header .meta { color: var(--dim); }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 12px; margin-bottom: 12px; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
  .kv { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; }
  .kv span:first-child { color: var(--dim); }
  .num { font-variant-numeric: tabular-nums; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 720px; }
  th, td { text-align: left; padding: 4px 10px 4px 0; white-space: nowrap; }
  th { color: var(--dim); font-weight: 500; border-bottom: 1px solid var(--line); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr:nth-child(even) { background: rgba(255,255,255,.02); }
  .empty { color: var(--dim); padding: 6px 0; }
  .tag { border: 1px solid var(--line); border-radius: 10px; padding: 0 6px; color: var(--dim); }
  #banner { display: none; border: 1px solid var(--bad); color: var(--bad); border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; }
  #banner.on { display: block; }
  .dot { color: var(--ok); }
  .dot.stale { color: var(--warn); }
</style>
</head>
<body>
<header>
  <h1>Kanna relay status</h1>
  <span class="meta" id="commit">commit —</span>
  <span class="meta" id="uptime">up —</span>
  <span class="meta"><span class="dot" id="dot">●</span> <span id="polled">never polled</span></span>
</header>
<div id="banner"></div>

<div class="grid">
  <section>
    <h2>Connections</h2>
    <div id="conn"></div>
  </section>
  <section>
    <h2>Bytes since start</h2>
    <div id="bytes"></div>
  </section>
  <section>
    <h2>Tunnel buffer pressure</h2>
    <div id="flow"></div>
  </section>
  <section>
    <h2>Upgrades and compression</h2>
    <div id="upgrades"></div>
  </section>
</div>

<section>
  <h2>Live connections</h2>
  <div class="scroll" id="live"></div>
</section>

<section>
  <h2>Recent closes</h2>
  <div class="scroll" id="recent"></div>
</section>

<script>
(function () {
  var TOKEN = new URLSearchParams(location.search).get('token') || '';
  var REFRESH_MS = 4000;
  var COLUMNS = [
    ['#', 'connectionId', 'num'],
    ['uid', 'uid', ''],
    ['desktop', 'desktopId', ''],
    ['role', 'role', ''],
    ['tunnel', 'tunnelService', ''],
    ['zip', 'compressed', ''],
    ['age', 'durationMs', 'num'],
    ['rx tunnel', 'rx.tunnel', 'num'],
    ['rx transfer', 'rx.taskTransfer', 'num'],
    ['rx term', 'rx.terminalEvent', 'num'],
    ['rx ctrl', 'rx.control', 'num'],
    ['rx total', 'rx.total', 'num'],
    ['tx tunnel', 'tx.tunnel', 'num'],
    ['tx transfer', 'tx.taskTransfer', 'num'],
    ['tx term', 'tx.terminalEvent', 'num'],
    ['tx ctrl', 'tx.control', 'num'],
    ['tx total', 'tx.total', 'num'],
    ['total', 'totalBytes', 'num']
  ];

  function esc(value) {
    return String(value == null ? '—' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function bytes(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    if (value < 1024) return value + ' B';
    var units = ['KiB', 'MiB', 'GiB', 'TiB'];
    var scaled = value / 1024;
    var index = 0;
    while (scaled >= 1024 && index < units.length - 1) { scaled = scaled / 1024; index = index + 1; }
    return scaled.toFixed(scaled < 10 ? 2 : 1) + ' ' + units[index];
  }

  function duration(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    var seconds = Math.floor(value / 1000);
    if (seconds < 60) return seconds + 's';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ' + (minutes % 60) + 'm';
    return Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
  }

  function rows(target, pairs) {
    var html = '';
    for (var index = 0; index < pairs.length; index++) {
      html += '<div class="kv"><span>' + esc(pairs[index][0]) + '</span>'
        + '<span class="num">' + esc(pairs[index][1]) + '</span></div>';
    }
    document.getElementById(target).innerHTML = html;
  }

  function cell(report, path) {
    if (path === 'durationMs') return duration(report.durationMs);
    if (path === 'compressed') return report.compressed ? 'deflate' : 'plain';
    if (path === 'connectionId') return report.connectionId;
    if (path === 'totalBytes') return bytes(report.totalBytes);
    if (path.indexOf('rx.') === 0) return bytes((report.received || {})[path.slice(3)]);
    if (path.indexOf('tx.') === 0) return bytes((report.sent || {})[path.slice(3)]);
    return report[path];
  }

  function table(target, reports, emptyText) {
    var element = document.getElementById(target);
    if (!reports || reports.length === 0) {
      element.innerHTML = '<div class="empty">' + esc(emptyText) + '</div>';
      return;
    }
    var head = '';
    for (var column = 0; column < COLUMNS.length; column++) {
      head += '<th class="' + COLUMNS[column][2] + '">' + esc(COLUMNS[column][0]) + '</th>';
    }
    var body = '';
    for (var index = 0; index < reports.length; index++) {
      body += '<tr>';
      for (var field = 0; field < COLUMNS.length; field++) {
        body += '<td class="' + COLUMNS[field][2] + '">'
          + esc(cell(reports[index], COLUMNS[field][1])) + '</td>';
      }
      body += '</tr>';
    }
    element.innerHTML = '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  function banner(message) {
    var element = document.getElementById('banner');
    element.textContent = message || '';
    element.className = message ? 'on' : '';
    document.getElementById('dot').className = message ? 'dot stale' : 'dot';
  }

  function render(stats) {
    document.getElementById('commit').textContent = 'commit ' + (stats.commit || '—');
    document.getElementById('uptime').textContent = 'up ' + duration(stats.bytes.uptimeMs)
      + ' (since ' + stats.bytes.startedAt + ')';
    document.getElementById('polled').textContent = 'polled ' + new Date().toLocaleTimeString();

    rows('conn', [
      ['paired users', stats.connections],
      ['sockets open', stats.bytes.connections.open],
      ['sockets opened', stats.bytes.connections.opened],
      ['sockets closed', stats.bytes.connections.closed]
    ]);
    rows('bytes', [
      ['received tunnel', bytes(stats.bytes.received.tunnel)],
      ['received transfer', bytes(stats.bytes.received.taskTransfer)],
      ['received terminal', bytes(stats.bytes.received.terminalEvent)],
      ['received control', bytes(stats.bytes.received.control)],
      ['received total', bytes(stats.bytes.received.total)],
      ['sent total', bytes(stats.bytes.sent.total)],
      ['both directions', bytes(stats.bytes.totalBytes)]
    ]);
    rows('flow', [
      ['pauses', stats.tunnelFlow.pauseCount],
      ['resumes', stats.tunnelFlow.resumeCount],
      ['cap rejects', stats.tunnelFlow.capRejectCount],
      ['peak buffered', bytes(stats.tunnelFlow.maxBufferedBytes)]
    ]);
    var refusals = [
      ['upgrades admitted', stats.upgrades.admitted],
      ['upgrades refused', stats.upgrades.refused.total]
    ];
    var byStatus = stats.upgrades.refused.byStatus || {};
    for (var status in byStatus) {
      if (Object.prototype.hasOwnProperty.call(byStatus, status)) {
        refusals.push(['refused ' + status, byStatus[status]]);
      }
    }
    refusals.push(['tracked addresses', stats.upgrades.trackedAddresses]);
    refusals.push(['compression negotiated', stats.compression.negotiated]);
    refusals.push(['compression plain', stats.compression.plain]);
    rows('upgrades', refusals);

    table('live', stats.liveConnections, 'No open connections.');
    table('recent', stats.recentConnections, 'No connection has closed since this relay started.');
  }

  function tick() {
    fetch('/stats', {
      cache: 'no-store',
      headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}
    }).then(function (response) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Relay refused the status token (HTTP ' + response.status + '). '
          + 'Re-open this page from: kd relay stats --open');
      }
      if (!response.ok) throw new Error('Relay answered HTTP ' + response.status + '.');
      return response.json();
    }).then(function (stats) {
      banner('');
      render(stats);
    }).catch(function (error) {
      banner(error && error.message ? error.message : String(error));
    });
  }

  if (!TOKEN) {
    banner('No token in this URL. Open the dashboard with: kd relay stats --open');
  }
  tick();
  setInterval(tick, REFRESH_MS);
})();
</script>
</body>
</html>
`;
