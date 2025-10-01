const raceBtn = document.getElementById('raceBtn');
const raceCard = document.getElementById('raceCard');
const sizeMB = document.getElementById('sizeMB');
const count = document.getElementById('count');
const conc = document.getElementById('conc');
const partMB = document.getElementById('partMB');
const jsonEl = document.getElementById('json');
const phaseTxt = document.getElementById('phaseTxt');
const winnerTxt = document.getElementById('winnerTxt');

// About modal
const aboutBtn = document.getElementById('aboutBtn');
const aboutModal = document.getElementById('aboutModal');
const aboutClose = document.getElementById('aboutClose');
const aboutOk = document.getElementById('aboutOk');

const bars = {
  awsUp: document.getElementById('awsUp'),
  awsDown: document.getElementById('awsDown'),
  b2Up: document.getElementById('b2Up'),
  b2Down: document.getElementById('b2Down'),
};
const labels = {
  awsUp: document.getElementById('awsUpTxt'),
  awsDown: document.getElementById('awsDownTxt'),
  b2Up: document.getElementById('b2UpTxt'),
  b2Down: document.getElementById('b2DownTxt'),
};

let tpChart, latChart;

// Charts (neutral colors)
function drawCharts(payload) {
  const items = payload.results;
  const labelsX = items.map(r => `${r.provider.toUpperCase()} ${r.op}`);
  const tp  = items.map(r => r.metrics.throughputMBps);
  const p50 = items.map(r => r.metrics.p50ms);
  const p95 = items.map(r => r.metrics.p95ms);
  const p99 = items.map(r => r.metrics.p99ms);

  if (tpChart) tpChart.destroy();
  if (latChart) latChart.destroy();

  tpChart = new Chart(document.getElementById('tpChart'), {
    type: 'bar',
    data: { labels: labelsX, datasets: [{ label: 'MB/s', data: tp }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, title: { display:true, text:'MB/s' } } },
      plugins: { legend: { display: false } }
    }
  });

  latChart = new Chart(document.getElementById('latChart'), {
    type: 'bar',
    data: {
      labels: labelsX,
      datasets: [
        { label: 'p50 ms', data: p50 },
        { label: 'p95 ms', data: p95 },
        { label: 'p99 ms', data: p99 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, title: { display:true, text:'Milliseconds' } } },
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

// Winner across upload + download
function computeWinner(results) {
  const g = { aws: {}, b2: {} };
  for (const r of results) g[r.provider][r.op] = r;
  if (!g.aws.upload || !g.aws.download || !g.b2.upload || !g.b2.download) return null;

  const tot = (x) => x.upload.metrics.durationMs + x.download.metrics.durationMs;
  const mb  = (x) => x.upload.metrics.totalMB + x.download.metrics.totalMB;
  const thr = (x) => mb(x) / (tot(x) / 1000);

  const awsTot = tot(g.aws), b2Tot = tot(g.b2);
  const awsThr = thr(g.aws), b2Thr = thr(g.b2);

  let winner, reason;
  if (awsTot < b2Tot) {
    winner = 'AWS'; reason = `by total time ${(awsTot/1000).toFixed(2)}s vs ${(b2Tot/1000).toFixed(2)}s`;
  } else if (b2Tot < awsTot) {
    winner = 'B2'; reason = `by total time ${(b2Tot/1000).toFixed(2)}s vs ${(awsTot/1000).toFixed(2)}s`;
  } else {
    if (awsThr > b2Thr) { winner = 'AWS'; reason = `time tied; higher throughput ${awsThr.toFixed(2)} vs ${b2Thr.toFixed(2)} MB/s`; }
    else if (b2Thr > awsThr) { winner = 'B2'; reason = `time tied; higher throughput ${b2Thr.toFixed(2)} vs ${awsThr.toFixed(2)} MB/s`; }
    else { winner = 'Tie'; reason = 'identical total time and throughput'; }
  }
  return { winner, reason };
}

// Confetti celebration when B2 wins 🎉
function celebrateConfetti() {
  if (typeof confetti !== 'function') return;
  const duration = 2500;
  const end = Date.now() + duration;

  (function frame(){
    confetti({ particleCount: 3, spread: 70, origin: { x: 0.2, y: 0.6 } });
    confetti({ particleCount: 3, spread: 70, origin: { x: 0.8, y: 0.6 } });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();

  // Big bursts
  setTimeout(() => confetti({ particleCount: 120, spread: 110, startVelocity: 40, origin: { y: 0.6 } }), 150);
  setTimeout(() => confetti({ particleCount: 150, spread: 120, startVelocity: 45, scalar: 1.1, origin: { y: 0.5 } }), 700);
}

function resetBars(total) {
  [['awsUp'],['awsDown'],['b2Up'],['b2Down']].forEach(([k]) => {
    bars[k].style.width = '0%';
    labels[k].textContent = `0 / ${total}`;
  });
}

// Live race via SSE (always does both upload & download)
raceBtn.addEventListener('click', () => {
  const sizeBytes = Number(sizeMB.value) * 1024 * 1024;
  const total = Number(count.value);
  const concurrency = Number(conc.value);
  const part = partMB.value ? Number(partMB.value) : '';

  raceCard.style.display = 'block';
  phaseTxt.textContent = 'Uploads starting…';
  if (winnerTxt) winnerTxt.textContent = 'Winner: —';
  resetBars(total);

  const url = `/api/race/stream?sizeBytes=${sizeBytes}&count=${total}&concurrency=${concurrency}&partMB=${part}`;
  const es = new EventSource(url);

  es.addEventListener('progress', (ev) => {
    const d = JSON.parse(ev.data);
    const key = (d.provider === 'aws' ? 'aws' : 'b2') + (d.op === 'upload' ? 'Up' : 'Down');
    const pct = Math.max(0, Math.min(100, Math.round((d.done / d.total) * 100)));
    bars[key].style.width = pct + '%';
    labels[key].textContent = `${d.done} / ${d.total}`;
  });

  es.addEventListener('phase', (ev) => {
    const d = JSON.parse(ev.data);
    phaseTxt.textContent = d.phase === 'downloads-start' ? 'Downloads starting…' : (d.phase || '…');
  });

  es.addEventListener('done', (ev) => {
    const data = JSON.parse(ev.data);
    jsonEl.textContent = JSON.stringify({ results: data.results }, null, 2);
    drawCharts({ results: data.results });
    const summary = computeWinner(data.results || []);
    if (summary && winnerTxt) {
      winnerTxt.textContent = `Winner: ${summary.winner} (${summary.reason})`;
      if (summary.winner === 'B2') celebrateConfetti();
    }
    phaseTxt.textContent = 'Finished!';
    es.close();
  });

  es.addEventListener('error', () => {
    phaseTxt.textContent = 'Error';
    es.close();
  });
});

/* --- About modal controls --- */
function openAbout(){ aboutModal.classList.add('show'); aboutModal.setAttribute('aria-hidden','false'); }
function closeAbout(){ aboutModal.classList.remove('show'); aboutModal.setAttribute('aria-hidden','true'); }
aboutBtn?.addEventListener('click', openAbout);
aboutClose?.addEventListener('click', closeAbout);
aboutOk?.addEventListener('click', closeAbout);
aboutModal?.addEventListener('click', (e)=>{ if(e.target === aboutModal) closeAbout(); });
document.addEventListener('keydown', (e)=>{ if(e.key === 'Escape') closeAbout(); });
