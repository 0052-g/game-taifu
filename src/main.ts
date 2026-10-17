import './style.css';
import { CITIES } from './data/cities';
import { MAP_HEIGHT, MAP_WIDTH, START_POINT } from './data/map';
import { distance } from './geo';
import { CanvasRenderer } from './renderer';
import { createSimulation, dateFromElapsedDays, stepSimulation } from './simulation';
import type { Point, SimulationState } from './types';

const spiral = `<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M33 10C20 1 5 12 9 25c4 13 23 13 26 0 3-12-12-19-19-10-6 8 5 16 11 10" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/></svg>`;
const arrow = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const play = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>`;
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="site-header">
    <a class="brand" href="./" aria-label="台風メーカー トップ">${spiral}<span>台風メーカー<span class="brand-dot">.</span></span><span class="version">V0.1.1</span></a>
    <div class="header-actions"><span class="personal-best"><span>自己ベスト</span><strong id="best-score">0</strong><small>pt</small></span><button class="help-button" id="help-open" aria-label="遊び方を開く">? <span>遊び方</span></button></div>
  </header>
  <main class="page">
    <section class="intro" aria-labelledby="page-title">
      <div><div class="eyebrow"><span></span> DRAW YOUR OWN STORM</div><h1 id="page-title">進路は、<span>あなた次第。</span></h1><p>海で育てて、山をかわして。ひと筆で巻き起こす、台風大冒険。</p></div>
      <div class="intro-stamp"><span>ぐるぐる描いて</span><strong>どこまで行ける？</strong><svg viewBox="0 0 50 30" aria-hidden="true"><path d="M3 8c27-18 4 33 29 15l11-9m-12 2 12-2-2 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    </section>

    <section class="dashboard" aria-label="台風の状態">
      <div class="stat date-stat"><div class="stat-label"><span class="stat-icon">◷</span>ゲーム内の日付</div><div class="date-value"><strong id="date">9月1日</strong><span id="season" class="season-tag">まだまだ夏の海</span></div></div>
      <div class="stat"><div class="stat-label"><span class="stat-icon wind-icon">≋</span>勢力<span class="stat-note" id="strength-label">元気いっぱい</span></div><div class="meter-value"><strong id="strength">70</strong><small>/ 100</small><div class="meter"><span id="strength-bar"></span></div></div></div>
      <div class="stat"><div class="stat-label"><span class="stat-icon">◇</span>構造の安定度<span class="stat-note" id="stability-label">しっかり</span></div><div class="meter-value"><strong id="stability">85</strong><small>/ 100</small><div class="meter stability-meter"><span id="stability-bar"></span></div></div></div>
      <div class="stat score-stat"><div class="stat-label"><span class="stat-icon">✧</span>累積被害スコア</div><div class="score-value"><strong id="score">0</strong><span>pt</span><span id="score-delta"></span></div></div>
    </section>

    <div class="game-layout">
      <section class="map-card" aria-label="日本地図と進路の作成">
        <div class="map-toolbar"><div class="map-title"><span class="live-dot" id="live-dot"></span><strong id="map-phase">進路をデザイン</strong><span class="map-subtitle">JAPAN & THE PACIFIC</span></div><span class="map-number">MAP / 01</span></div>
        <div class="canvas-wrap"><canvas id="game-canvas" aria-label="日本地図。海上の台風からマウスまたは指で進路を描いてください。キーボードではおまかせ進路ボタンを利用できます。"></canvas><div class="map-hint" id="map-hint"><span class="hint-pencil">〰</span><span><strong>台風から、一筆書き。</strong><small>マウスや指で、好きな進路を描こう</small></span></div><div class="pause-overlay" id="pause-overlay" hidden><span>Ⅱ</span><strong>ちょっとひと休み</strong><small>「再開」で冒険のつづきへ</small></div></div>
        <div class="map-legend"><span><i class="legend-ocean"></i>海：勢力回復</span><span><i class="legend-land"></i>陸：勢力低下</span><span><i class="legend-mountain">⌃</i>山：大きく低下</span><span><i class="legend-city"></i>都市：スコア獲得</span></div>
        <div class="map-footer"><span id="route-info">まだ進路が描かれていません</span><span class="map-note">地図・都市の重みはゲーム用の簡略データ</span></div>
      </section>

      <aside class="control-panel">
        <section class="launch-card"><div class="step-kicker"><span id="step-number">01</span><span id="step-label">まずは、進路を描こう</span></div><h2 id="control-title">そのひと筆が、<br>嵐を起こす。</h2><p id="control-description">海上の台風から線を引こう。<br>海でパワーをためるのがコツ！</p><div class="route-ready" id="route-ready"><span class="ready-dot"></span><span id="route-status">進路の入力待ち</span></div><button class="primary-button" id="start" disabled>${play}<span>台風、出発！</span>${arrow}</button><div class="secondary-controls"><button id="redraw" class="text-button"><span>↺</span> 描き直す</button><button id="sample" class="text-button">おまかせ進路 ${arrow}</button></div><div class="playback" id="playback" hidden><button id="pause" aria-label="シミュレーションを一時停止">Ⅱ 一時停止</button><div class="speeds" aria-label="再生速度"><button data-speed="1" class="selected" aria-pressed="true">×1</button><button data-speed="2" aria-pressed="false">×2</button><button data-speed="4" aria-pressed="false">×4</button></div></div></section>

        <section class="tips-card"><div class="section-label"><span>✦</span> 台風マスターへの道</div><div class="tip"><span class="tip-number">01</span><p><strong>海は、パワースポット。</strong><br>暖かい海で勢力を回復しよう。</p></div><div class="tip"><span class="tip-number">02</span><p><strong>山越えは、体力勝負。</strong><br>構造が崩れると回復にも限界が。</p></div><div class="tip"><span class="tip-number">03</span><p><strong>同じ都市は、おかわり控えめ。</strong><br>残りの資産が少ないほど低得点。</p></div><div class="season-tip">◷ 秋はあっという間。12月にはおしまい！</div></section>

        <section class="log-card"><div class="section-label"><span class="tiny-pulse"></span> 台風だより<span id="terrain-badge">海の上</span></div><div id="event-log" class="event-log" role="log" aria-live="polite"><p class="empty-log">小さな台風が、冒険を待っています。</p></div></section>
      </aside>
    </div>

    <section class="asset-strip" aria-label="主要都市の資産残量"><div class="asset-title"><span>都市の残り資産</span><small>通過すると減少します</small></div><div id="city-assets" class="city-assets"></div></section>
    <footer class="page-footer"><span>${spiral} TAIFU MAKER <span>—</span> A LITTLE STORM, A BIG ADVENTURE.</span><span>気象予測ではない、気ままな台風シミュレーション。<b>VERSION 0.1.1</b></span></footer>
  </main>

  <dialog id="help-dialog" class="modal"><button class="modal-close" data-close="help-dialog" aria-label="閉じる">×</button><span class="eyebrow">HOW TO PLAY</span><h2>台風の冒険をつくろう。</h2><ol class="help-steps"><li><b>進路を描く</b><p>海上の台風から、指やマウスで一筆書き。線の交差・同じ場所の再通過もOK。離したら、線の終点から続きを描けます。</p></li><li><b>「台風、出発！」を押す</b><p>暖かい海では回復、陸上や山では衰退。都市に強い勢力で近づくほど、資産への被害スコアが伸びます。</p></li><li><b>記録に挑戦する</b><p>終点への到達、勢力・構造の低下、冬の到来で終了。同じ都市に居続けても加点は増えず、強くなって再訪すると追加の被害が出ることがあります。</p></li></ol><p class="help-footnote">キーボードでも「おまかせ進路」で遊べます。自己ベストはこのブラウザに保存。簡略地図・架空の資産を使ったゲームです。</p><button class="primary-button" data-close="help-dialog">わかった、やってみよう！ ${arrow}</button></dialog>
  <dialog id="result-dialog" class="modal result-modal"><button class="modal-close" data-close="result-dialog" aria-label="結果を閉じて地図を見る">×</button><div class="result-icon">${spiral}</div><span class="eyebrow">STORM REPORT</span><h2 id="result-title">冒険、おつかれさま！</h2><p id="result-reason"></p><div class="result-score"><small>最終被害スコア</small><strong id="result-score">0</strong><span>pt</span><b id="new-best" hidden>NEW BEST!</b></div><div class="result-stats"><div><span>通過した都市</span><strong id="result-cities">0都市</strong></div><div><span>最高勢力</span><strong id="result-strength">0</strong></div><div><span>旅した日数</span><strong id="result-days">0日</strong></div></div><p id="result-tip" class="result-tip"></p><button id="retry" class="primary-button">新しい進路で挑戦 ${arrow}</button><button id="same-route" class="text-button">同じ進路でもう一度 ↻</button></dialog>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('game-canvas');
const renderer = new CanvasRenderer(canvas);
let route: Point[] = [{ ...START_POINT }];
let state: SimulationState | null = null;
let phase: 'planning' | 'running' | 'finished' = 'planning';
let drawing = false;
let pointerId: number | null = null;
let paused = false;
let speed = 1;
let routeLength = 0;
let lastEvent = 0;
let best = 0;
try { best = Math.max(0, Number(localStorage.getItem('taifu-maker-best-v1')) || 0); } catch { /* Storage is optional. */ }
const format = (value: number) => Math.floor(value).toLocaleString('ja-JP');
$('best-score').textContent = format(best);

// Use the same initial model values for the HUD and simulation.
const initial = createSimulation([START_POINT, { x: START_POINT.x + 1, y: START_POINT.y }]);

const endReasons: Record<string, string> = {
  'route-complete': '描いた進路の終点に到着しました。',
  dissipated: '勢力を使い切り、台風は消滅しました。',
  extratropical: '構造が崩れ、温帯低気圧に変わりました。',
  winter: '12月が到来。冷たい海で台風の季節が終わりました。',
};

function updateRouteInfo() {
  routeLength = route.slice(1).reduce((total, point, i) => total + distance(route[i], point), 0);
  const ready = routeLength > 12;
  $<HTMLButtonElement>('start').disabled = !ready || drawing || phase === 'running';
  $('route-info').textContent = ready ? `進路の長さ ${format(routeLength)} マップ単位${drawing ? ' · 描いています…' : ' · 終点から続きも描けます'}` : 'まだ進路が描かれていません';
  $('route-status').textContent = drawing ? 'いい感じ！そのまま自由に' : ready ? '進路の準備、できました！' : '進路の入力待ち';
  $('route-ready').classList.toggle('is-ready', ready);
  $('map-hint').hidden = ready || phase !== 'planning';
}

function updateHUD() {
  const s = state ?? initial;
  const date = dateFromElapsedDays(s.elapsedDays);
  $('date').textContent = `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  $('season').textContent = s.elapsedDays >= 91 ? '冬の到来' : s.elapsedDays >= 61 ? '冷たい秋の海' : s.elapsedDays >= 30 ? '秋が深まる海' : 'まだまだ夏の海';
  $('season').classList.toggle('cold', s.elapsedDays >= 61);
  $('strength').textContent = String(Math.round(s.strength));
  $('stability').textContent = String(Math.round(s.stability));
  $('strength-bar').style.width = `${s.strength}%`;
  $('stability-bar').style.width = `${s.stability}%`;
  $('strength-label').textContent = s.strength > 75 ? '絶好調！' : s.strength > 45 ? '元気いっぱい' : s.strength > 20 ? 'おつかれ気味' : 'もう限界…';
  $('stability-label').textContent = s.stability > 65 ? 'しっかり' : s.stability > 35 ? 'ぐらぐら' : 'くずれそう';
  $('score').textContent = format(s.score);
  $('terrain-badge').textContent = { ocean: '海の上', land: '上陸中', mountain: '山越え中' }[s.terrain];
  for (const city of CITIES) {
    const remaining = s.cityDamage[city.id]?.remaining ?? city.weight;
    const percent = Math.max(0, Math.min(100, remaining / city.weight * 100));
    const bar = document.getElementById(`asset-${city.id}`);
    if (bar) {
      bar.style.width = `${percent}%`;
      bar.parentElement!.parentElement!.setAttribute('title', `${city.name}：残り ${Math.round(percent)}%`);
      bar.parentElement!.parentElement!.setAttribute('aria-label', `${city.name} 残り資産 ${Math.round(percent)}%`);
    }
  }
  if (state && state.events.length && state.events.at(-1)!.id !== lastEvent) {
    const fresh = state.events.filter(event => event.id > lastEvent);
    lastEvent = state.events.at(-1)!.id;
    const log = $('event-log');
    log.querySelector('.empty-log')?.remove();
    for (const event of fresh) {
      const row = document.createElement('p');
      row.className = `log-event log-${event.kind}`;
      const dot = document.createElement('span');
      dot.className = 'event-dot';
      const text = document.createElement('span');
      text.textContent = event.text;
      row.append(dot, text);
      log.prepend(row);
      if (event.score && event.score > 0) {
        $('score-delta').textContent = `+${format(event.score)}`;
        $('score-delta').classList.remove('score-pop');
        void $('score-delta').offsetWidth;
        $('score-delta').classList.add('score-pop');
      }
    }
    while (log.children.length > 5) log.lastElementChild!.remove();
  }
}

function reset() {
  drawing = false;
  if (pointerId !== null && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
  pointerId = null;
  route = [{ ...START_POINT }];
  state = null;
  phase = 'planning';
  paused = false;
  lastEvent = 0;
  $('score-delta').textContent = '';
  $('pause-overlay').hidden = true;
  $('playback').hidden = true;
  $('map-phase').textContent = '進路をデザイン';
  $('live-dot').classList.remove('running');
  $('step-number').textContent = '01';
  $('step-label').textContent = 'まずは、進路を描こう';
  $('control-title').innerHTML = 'そのひと筆が、<br>嵐を起こす。';
  $('control-description').innerHTML = '海上の台風から線を引こう。<br>海でパワーをためるのがコツ！';
  $('start').innerHTML = `${play}<span>台風、出発！</span>${arrow}`;
  $<HTMLButtonElement>('sample').disabled = false;
  $('event-log').innerHTML = '<p class="empty-log">小さな台風が、冒険を待っています。</p>';
  updateRouteInfo();
  updateHUD();
}

function start() {
  if (routeLength <= 12 || drawing || phase === 'running') return;
  state = createSimulation(route);
  phase = 'running';
  paused = false;
  lastEvent = 0;
  $('playback').hidden = false;
  $('pause-overlay').hidden = true;
  $('pause').textContent = 'Ⅱ 一時停止';
  $('pause').setAttribute('aria-label', 'シミュレーションを一時停止');
  $('map-phase').textContent = '台風、冒険中！';
  $('live-dot').classList.add('running');
  $('step-number').textContent = '02';
  $('step-label').textContent = 'さあ、嵐のはじまり';
  $('control-title').innerHTML = 'ぐるぐる、<br>いってきます！';
  $('control-description').innerHTML = '勢力と構造を見守ろう。<br>海に出れば、復活のチャンス。';
  $('start').innerHTML = `${spiral}<span>台風、移動中…</span>`;
  $<HTMLButtonElement>('sample').disabled = true;
  $('event-log').innerHTML = '<p class="empty-log">台風の旅がはじまりました。</p>';
  updateRouteInfo();
  updateHUD();
}

function finish() {
  if (!state) return;
  phase = 'finished';
  $('live-dot').classList.remove('running');
  $('playback').hidden = true;
  $('map-phase').textContent = '今回の台風レポート';
  $('step-number').textContent = '03';
  $('step-label').textContent = 'ひと筆の冒険、おしまい';
  $('control-title').innerHTML = '次は、どんな<br>進路にしよう？';
  $('control-description').textContent = endReasons[state.endReason ?? 'route-complete'];
  $('start').innerHTML = `${play}<span>同じ進路で再挑戦</span>${arrow}`;
  $<HTMLButtonElement>('start').disabled = false;
  $<HTMLButtonElement>('sample').disabled = false;
  $('result-reason').textContent = endReasons[state.endReason ?? 'route-complete'];
  $('result-score').textContent = format(state.score);
  $('result-cities').textContent = `${state.affectedCities}都市`;
  $('result-strength').textContent = `${Math.round(state.maxStrength)}`;
  $('result-days').textContent = `${Math.floor(state.elapsedDays)}日`;
  $('result-tip').textContent = state.affectedCities === 0 ? '次は都市の近くまで！暖かい海で勢力をためてから向かおう。' : state.stability < 30 ? '山越えで構造がぐらぐら。次は海沿いのルートを試してみよう。' : '海で育てて、強いまま都市へ。次のひと筆で記録を更新しよう！';
  const record = Math.floor(state.score) > best;
  $('new-best').hidden = !record;
  if (record) {
    best = Math.floor(state.score);
    $('best-score').textContent = format(best);
    try { localStorage.setItem('taifu-maker-best-v1', String(best)); } catch { /* Continue without persistence. */ }
  }
  $<HTMLDialogElement>('result-dialog').showModal();
  updateHUD();
}

function setPaused(value: boolean) {
  if (phase !== 'running') return;
  paused = value;
  $('pause-overlay').hidden = !paused;
  $('pause').textContent = paused ? '▶ 再開' : 'Ⅱ 一時停止';
  $('pause').setAttribute('aria-label', paused ? 'シミュレーションを再開' : 'シミュレーションを一時停止');
  $('map-phase').textContent = paused ? 'ひと休み中' : '台風、冒険中！';
}

function pointFromEvent(event: PointerEvent): Point {
  const point = renderer.screenToWorld(event.clientX, event.clientY);
  return { x: Math.max(0, Math.min(MAP_WIDTH, point.x)), y: Math.max(0, Math.min(MAP_HEIGHT, point.y)) };
}

canvas.addEventListener('pointerdown', event => {
  if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0) || phase !== 'planning') return;
  const point = pointFromEvent(event);
  // Touch targets stay generous even when the map shrinks on a phone.
  const tolerance = 40 * MAP_WIDTH / canvas.getBoundingClientRect().width;
  if (distance(point, route.at(-1)!) > tolerance) {
    $('route-status').textContent = route.length > 1 ? '線の終点から、続きを描こう' : '海上の台風から描きはじめよう';
    return;
  }
  event.preventDefault();
  pointerId = event.pointerId;
  drawing = true;
  canvas.setPointerCapture(event.pointerId);
  if (distance(point, route.at(-1)!) > 2) route.push(point);
  updateRouteInfo();
});
canvas.addEventListener('pointermove', event => {
  if (!drawing || event.pointerId !== pointerId) return;
  event.preventDefault();
  const events = event.getCoalescedEvents?.() ?? [event];
  for (const sample of events.length ? events : [event]) {
    const point = pointFromEvent(sample);
    if (distance(point, route.at(-1)!) >= 2) route.push(point);
  }
  // O(1) while drawing; full route length is computed on pointerup.
  $('map-hint').hidden = true;
  $('route-status').textContent = 'いい感じ！そのまま自由に';
});
function endStroke(event: PointerEvent) {
  if (event.pointerId !== pointerId) return;
  if (event.type === 'pointerup') {
    const point = pointFromEvent(event);
    if (distance(point, route.at(-1)!) >= 2) route.push(point);
  }
  drawing = false;
  pointerId = null;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  updateRouteInfo();
}
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);
canvas.addEventListener('lostpointercapture', event => {
  if (event.pointerId === pointerId) { drawing = false; pointerId = null; updateRouteInfo(); }
});
$('start').addEventListener('click', start);
$('redraw').addEventListener('click', reset);
$('pause').addEventListener('click', () => setPaused(!paused));
$('sample').addEventListener('click', () => {
  reset();
  // Scenic coastal route: sea recovery, then Osaka, Nagoya and Tokyo.
  const cityPoint = (id: string) => ({ ...CITIES.find(city => city.id === id)!.position });
  route = [START_POINT, { x: 440, y: 570 }, { x: 445, y: 455 }, cityPoint('osaka'), { x: 570, y: 432 }, cityPoint('nagoya'), { x: 635, y: 419 }, cityPoint('tokyo'), { x: 735, y: 355 }];
  updateRouteInfo();
});
document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach(button => {
  button.addEventListener('click', () => {
    speed = Number(button.dataset.speed);
    document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach(item => {
      const active = item === button;
      item.classList.toggle('selected', active);
      item.setAttribute('aria-pressed', String(active));
    });
  });
});
$('help-open').addEventListener('click', () => {
  setPaused(true);
  $<HTMLDialogElement>('help-dialog').showModal();
});
document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach(button => button.addEventListener('click', () => $<HTMLDialogElement>(button.dataset.close!).close()));
document.querySelectorAll<HTMLDialogElement>('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } }));
$('retry').addEventListener('click', () => { $<HTMLDialogElement>('result-dialog').close(); reset(); });
$('same-route').addEventListener('click', () => { $<HTMLDialogElement>('result-dialog').close(); start(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });
document.addEventListener('keydown', event => { if (event.code === 'Space' && event.target === document.body && phase === 'running' && !document.querySelector('dialog[open]')) { event.preventDefault(); setPaused(!paused); } });

const showcase = ['fukuoka', 'hiroshima', 'osaka', 'nagoya', 'tokyo', 'sendai', 'sapporo'];
for (const id of showcase) {
  const city = CITIES.find(item => item.id === id);
  if (!city) continue;
  const item = document.createElement('div');
  item.className = 'city-asset';
  item.innerHTML = `<span>${city.name}</span><div class="asset-meter"><i id="asset-${city.id}"></i></div>`;
  $('city-assets').append(item);
}

const resizeObserver = new ResizeObserver(() => renderer.resize());
resizeObserver.observe(canvas);
renderer.resize();
reset();
let previousTime = performance.now();
let hudTime = 0;
function frame(time: number) {
  const dt = Math.min((time - previousTime) / 1000, 0.1);
  previousTime = time;
  if (state && phase === 'running' && !paused) {
    stepSimulation(state, dt * speed);
    if (state.phase === 'finished') finish();
  }
  if (time - hudTime > 100) { updateHUD(); hudTime = time; }
  renderer.render({ route, state, phase, time, drawing });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
