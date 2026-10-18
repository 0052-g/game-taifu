import { LANDMASSES, MAP_HEIGHT, MAP_WIDTH, START_POINT } from './data/map';
import { CITIES } from './data/cities';
import { MESH_CELLS, MESH_GRID, POPULATION_CELLS, meshCellBounds } from './data/mesh';
import { SIMULATION_CONFIG } from './config';
import { assetFill, initialAssetPoints, remainingAssetPoints } from './asset-display';
import type { Point, SimulationState } from './types';

export type MapLayer = 'terrain' | 'population' | 'assets';

export interface RenderFrame {
  route: Point[];
  state: SimulationState | null;
  phase: 'planning' | 'running' | 'finished';
  time: number;
  drawing: boolean;
}

type Label = { id: string; x: number; y: number; width: number; height: number; align: CanvasTextAlign; leader?: Point };
type MeshBounds = ReturnType<typeof meshCellBounds>;
type VisibleMesh = { cell: (typeof MESH_CELLS)[number]; bounds: MeshBounds };
type Popup = { id: number | string; text: string; position: Point; born: number; kind: string; score?: number };

const INK = '#234f4b';
const CORAL = '#f47b65';
const FONT = '"Noto Sans JP", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

/** Canvas coordinates stay in map units; pointer input uses the same fitted transform. */
export class CanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly backgrounds: Record<MapLayer, HTMLCanvasElement>;
  private readonly landPath = new Path2D();
  private readonly visibleMesh: VisibleMesh[] = [];
  private readonly populationBounds = new Map<number, MeshBounds & { id: number; population: number }>();
  private readonly damageOverlay = document.createElement('canvas');
  private readonly landMask = document.createElement('canvas');
  private readonly cloudSprite = document.createElement('canvas');
  private readonly cityBaseCache = document.createElement('canvas');
  private readonly cityLabelCache = document.createElement('canvas');
  private cityGeometryKey = '';
  private cityMarkerMask = -1;
  private cityTiles: { x: number; y: number; sourceX: number; size: number }[] = [];
  private readonly backgroundReady = new Set<MapLayer>();
  private cacheRatio = 0;
  private damageNeedsRebuild = true;
  private hasDamagePixels = false;
  private readonly damageCtx: CanvasRenderingContext2D;
  private layer: MapLayer = 'assets';
  private lastDamagePaint = -Infinity;
  private lastFrameTime: number | null = null;
  private frameIntervalAverage = 16;
  private damagePaintInterval = 100;
  private cssWidth = MAP_WIDTH;
  private cssHeight = MAP_HEIGHT;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private dpr = 1;
  private labels: Label[] = [];
  private cityFontSize = 14;
  private readonly maxCityWeight = Math.max(...CITIES.map((city) => city.weight), 1);
  private routePath = new Path2D();
  private routeRef: Point[] | null = null;
  private routeCount = -1;
  private lastRoutePoint = '';
  private traveledPath = new Path2D();
  private traveledSegment = -1;
  private traveledRoute: Point[] | null = null;
  private lastElapsedDays = -1;
  private seenEvents = new Set<string | number>();
  private popups: Popup[] = [];
  private renderedState: SimulationState | null = null;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('このブラウザでは Canvas 2D を利用できません。');
    this.ctx = context;
    const thematicBackground = document.createElement('canvas');
    this.backgrounds = { terrain: document.createElement('canvas'), population: thematicBackground, assets: thematicBackground };
    this.damageCtx = this.damageOverlay.getContext('2d')!;
    this.prepareMapGeometry();
    this.buildCloudSprite();
    this.resize();
  }

  setLayer(layer: MapLayer): void {
    const overlayChanges = (this.layer === 'assets') !== (layer === 'assets');
    this.layer = layer;
    if (!this.backgroundReady.has(layer)) this.buildBackground(layer);
    if (overlayChanges) {
      this.damageCtx.clearRect(0, 0, this.damageOverlay.width, this.damageOverlay.height);
      this.damageNeedsRebuild = true;
      this.hasDamagePixels = false;
      this.lastDamagePaint = -Infinity;
    }
  }

  resize(): void {
    const bounds = this.canvas.getBoundingClientRect();
    this.cssWidth = Math.max(1, bounds.width);
    this.cssHeight = Math.max(1, bounds.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(this.cssWidth * this.dpr);
    const pixelHeight = Math.round(this.cssHeight * this.dpr);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    this.scale = Math.min(this.cssWidth / MAP_WIDTH, this.cssHeight / MAP_HEIGHT);
    this.offsetX = (this.cssWidth - MAP_WIDTH * this.scale) / 2;
    this.offsetY = (this.cssHeight - MAP_HEIGHT * this.scale) / 2;
    this.placeCityLabels();
    const cityGeometryKey = `${pixelWidth},${pixelHeight},${this.scale},${this.offsetX},${this.offsetY},${this.dpr}`;
    if (cityGeometryKey !== this.cityGeometryKey) {
      this.cityGeometryKey = cityGeometryKey;
      this.buildCityCaches(Math.max(0, this.cityMarkerMask));
    }
    const ratio = Math.min(2, Math.max(0.5, this.scale * this.dpr));
    const cacheWidth = Math.round(MAP_WIDTH * ratio);
    const cacheHeight = Math.round(MAP_HEIGHT * ratio);
    if (this.landMask.width !== cacheWidth || this.landMask.height !== cacheHeight || this.cacheRatio === 0) {
      this.cacheRatio = ratio;
      this.backgroundReady.clear();
      const inactive = this.layer === 'terrain' ? this.backgrounds.population : this.backgrounds.terrain;
      inactive.width = inactive.height = 1;
      this.buildBackground(this.layer);
      this.landMask.width = this.damageOverlay.width = cacheWidth;
      this.landMask.height = this.damageOverlay.height = cacheHeight;
      const mask = this.landMask.getContext('2d')!;
      mask.setTransform(cacheWidth / MAP_WIDTH, 0, 0, cacheHeight / MAP_HEIGHT, 0, 0);
      mask.fillStyle = '#fff';
      mask.fill(this.landPath, 'evenodd');
      this.damageNeedsRebuild = true;
      this.hasDamagePixels = false;
      this.lastDamagePaint = -Infinity;
    }
  }

  screenToWorld(clientX: number, clientY: number): Point {
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - bounds.left - this.offsetX) / this.scale,
      y: (clientY - bounds.top - this.offsetY) / this.scale,
    };
  }

  render(frame: RenderFrame): void {
    const stateChanged = frame.state !== this.renderedState;
    const interval = this.lastFrameTime === null ? null : frame.time - this.lastFrameTime;
    // Adapt color updates only. A pause/resume or clock restart must not bias
    // the moving average; hysteresis prevents toggling near the thresholds.
    if (stateChanged || interval === null || interval < 0 || interval > 1000) {
      this.frameIntervalAverage = 16;
      this.damagePaintInterval = 100;
      if (interval !== null && (interval < 0 || interval > 1000)) this.lastDamagePaint = -Infinity;
    } else if (interval > 0) {
      this.frameIntervalAverage += (Math.min(interval, 250) - this.frameIntervalAverage) * 0.15;
      if (this.frameIntervalAverage > 40) this.damagePaintInterval = 180;
      else if (this.frameIntervalAverage < 25) this.damagePaintInterval = 100;
    }
    this.lastFrameTime = frame.time;
    // A retry may replace the simulation directly without an intervening planning frame.
    if (stateChanged) {
      this.renderedState = frame.state;
      this.seenEvents.clear();
      this.popups = [];
      this.traveledRoute = null;
      this.traveledSegment = -1;
      this.lastElapsedDays = -1;
      this.damageCtx.clearRect(0, 0, this.damageOverlay.width, this.damageOverlay.height);
      this.lastDamagePaint = -Infinity;
      this.damageNeedsRebuild = true;
      this.hasDamagePixels = false;
    }
    const motionFrame = this.reducedMotion.matches ? { ...frame, time: 0 } : frame;
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#e7f3ef';
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    ctx.clip();
    ctx.drawImage(this.backgrounds[this.layer], 0, 0, MAP_WIDTH, MAP_HEIGHT);
    this.drawMeshDamage(frame);
    this.drawSeaMotion(motionFrame.time);
    this.drawCities(frame.state);
    this.drawRoute(motionFrame);
    if (frame.phase === 'planning') this.drawStart(motionFrame);
    const position = frame.state?.position ?? START_POINT;
    this.drawTyphoon(position, frame.state?.strength ?? SIMULATION_CONFIG.initialStrength, motionFrame.time, frame.phase);
    this.drawEvents(frame);
    ctx.restore();
  }

  private prepareMapGeometry(): void {
    for (const land of LANDMASSES) {
      for (const ring of [land.points, ...(land.holes ?? [])]) {
        if (!ring.length) continue;
        this.landPath.moveTo(ring[0].x, ring[0].y);
        for (let i = 1; i < ring.length; i++) this.landPath.lineTo(ring[i].x, ring[i].y);
        this.landPath.closePath();
      }
    }
    const visible = (bounds: MeshBounds) => bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0 && bounds.x < MAP_WIDTH && bounds.y < MAP_HEIGHT;
    for (const cell of MESH_CELLS) {
      const bounds = meshCellBounds(cell);
      if (visible(bounds)) this.visibleMesh.push({ cell, bounds });
    }
    for (const cell of POPULATION_CELLS) {
      const bounds = meshCellBounds(cell);
      if (visible(bounds)) this.populationBounds.set(cell.id, { ...bounds, id: cell.id, population: cell.population });
    }
  }

  private buildBackground(layer: MapLayer): void {
    // Terrain keeps its own cache. Population and remaining assets share one
    // thematic canvas, rebuilt only when switching between those two views.
    if (layer !== 'terrain') {
      this.backgroundReady.delete('population');
      this.backgroundReady.delete('assets');
    }
    const background = this.backgrounds[layer];
    background.width = Math.round(MAP_WIDTH * this.cacheRatio);
    background.height = Math.round(MAP_HEIGHT * this.cacheRatio);
    const ctx = background.getContext('2d')!;
    ctx.setTransform(background.width / MAP_WIDTH, 0, 0, background.height / MAP_HEIGHT, 0, 0);
    ctx.fillStyle = '#e4f3ef';
    ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    const warm = ctx.createRadialGradient(200, 800, 30, 220, 750, 600);
    warm.addColorStop(0, '#f5edcf');
    warm.addColorStop(0.55, '#edf1de');
    warm.addColorStop(1, '#e4f3ef00');
    ctx.fillStyle = warm;
    ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    ctx.strokeStyle = '#91bcb53d';
    ctx.lineWidth = 0.75;
    for (let x = 40; x < MAP_WIDTH; x += 80) {
      for (let y = 40; y < MAP_HEIGHT; y += 80) {
        ctx.beginPath();
        ctx.moveTo(x - 3, y);
        ctx.lineTo(x + 3, y);
        ctx.moveTo(x, y - 3);
        ctx.lineTo(x, y + 3);
        ctx.stroke();
      }
    }

    ctx.save();
    ctx.translate(0, 2.5);
    ctx.fillStyle = '#6eaa953b';
    ctx.fill(this.landPath, 'evenodd');
    ctx.restore();
    ctx.fillStyle = layer === 'terrain' ? '#d6e5ce' : '#e5ecd4';
    ctx.fill(this.landPath, 'evenodd');
    ctx.save();
    ctx.clip(this.landPath, 'evenodd');
    const terrainStops: [number, readonly number[]][] = [
      [0, [211, 231, 187]], [100, [196, 221, 169]], [350, [166, 198, 145]],
      [700, [133, 171, 133]], [1200, [100, 145, 121]], [1900, [73, 114, 104]], [3000, [53, 91, 86]],
    ];
    const populationStops: [number, readonly number[]][] = [
      [0, [229, 236, 212]], [0.15, [241, 234, 207]], [0.35, [245, 208, 165]],
      [0.55, [236, 166, 122]], [0.76, [224, 117, 91]], [1, [171, 73, 68]],
    ];
    const colorAt = (value: number, stops: [number, readonly number[]][]): string => {
      let i = 1;
      while (i < stops.length - 1 && value > stops[i][0]) i++;
      const [low, a] = stops[i - 1];
      const [high, b] = stops[i];
      const blend = Math.max(0, Math.min(1, (value - low) / (high - low)));
      return `rgb(${a.map((channel, j) => Math.round(channel + (b[j] - channel) * blend)).join(',')})`;
    };
    for (const { cell, bounds } of this.visibleMesh) {
      const { x, y, width, height } = bounds;
      if (layer === 'terrain') {
        // Missing DEM samples remain neutral: null never stands in for sea level.
        ctx.fillStyle = cell.elevationM === null ? '#d6e5ce' : colorAt(Math.max(0, cell.elevationM) + Math.max(0, cell.reliefM ?? 0) * 0.12, terrainStops);
      } else if (layer === 'assets') {
        const initial = initialAssetPoints(cell.population);
        ctx.fillStyle = assetFill(initial, initial);
      } else {
        const density = cell.population / cell.areaKm2;
        const heat = Math.max(0, Math.min(1, Math.log10(1 + density) / Math.log10(12_001)));
        ctx.fillStyle = colorAt(heat, populationStops);
      }
      // A tiny overlap prevents raster seams when the cached map is downsampled.
      ctx.fillRect(x, y, width + 0.12, height + 0.12);
    }
    if (layer === 'population') {
      // The census grid is visible over populated clusters without outlining the sea.
      ctx.beginPath();
      for (const { cell, bounds } of this.visibleMesh) {
        if (cell.population <= 0) continue;
        ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height);
      }
      ctx.strokeStyle = '#fffaf030';
      ctx.lineWidth = 0.3;
      ctx.stroke();
    } else if (layer === 'terrain') {
      // Sparse relief marks identify high, rugged cells; heights are actual DEM values.
      ctx.beginPath();
      for (const { cell, bounds } of this.visibleMesh) {
        if (cell.elevationM === null || cell.elevationM < 700 || (cell.reliefM ?? 0) < 200 || cell.id % 29 !== 0) continue;
        const x = bounds.x + bounds.width / 2;
        const y = bounds.y + bounds.height / 2;
        ctx.moveTo(x - 2.3, y + 1.5);
        ctx.lineTo(x, y - 2);
        ctx.lineTo(x + 2.3, y + 1.5);
      }
      ctx.strokeStyle = '#e0e9bf85';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = '#528d798c';
    ctx.lineWidth = 1.1;
    ctx.lineJoin = 'round';
    ctx.stroke(this.landPath);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#74a49b';
    ctx.font = `500 18px ${FONT}`;
    ctx.fillText('日 本 海', 470, 210);
    ctx.fillStyle = '#87aaa1';
    ctx.font = `500 21px ${FONT}`;
    ctx.fillText('太 平 洋', 760, 605);
    ctx.font = `500 12px ${FONT}`;
    ctx.fillStyle = '#92b5ab';
    ctx.fillText('P A C I F I C  O C E A N', 760, 628);
    ctx.font = `500 15px ${FONT}`;
    ctx.fillStyle = '#9aab85';
    ctx.fillText('あたたかい海でパワーチャージ', 204, 585);
    this.drawCompass(ctx);
    this.backgroundReady.add(layer);
  }

  private drawMeshDamage(frame: RenderFrame): void {
    const state = frame.state;
    if (!state) return;
    const rebuild = this.damageNeedsRebuild;
    if (rebuild || (state.meshDamageDirtyIds.size > 0 && (frame.phase === 'finished' || frame.time - this.lastDamagePaint >= this.damagePaintInterval))) {
      const ids: Iterable<number> = rebuild ? Object.keys(state.meshDamage).map(Number) : state.meshDamageDirtyIds;
      let minIx = Infinity, minIy = Infinity, maxIx = -Infinity, maxIy = -Infinity;
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      const sx = this.damageOverlay.width / MAP_WIDTH;
      const sy = this.damageOverlay.height / MAP_HEIGHT;
      for (const id of ids) {
        const bounds = this.populationBounds.get(id);
        if (!bounds) continue;
        const ix = id % MESH_GRID.width;
        const iy = Math.floor(id / MESH_GRID.width);
        minIx = Math.min(minIx, ix); maxIx = Math.max(maxIx, ix);
        minIy = Math.min(minIy, iy); maxIy = Math.max(maxIy, iy);
        left = Math.min(left, Math.round(bounds.x * sx));
        right = Math.max(right, Math.round((bounds.x + bounds.width) * sx));
        top = Math.min(top, Math.round(bounds.y * sy));
        bottom = Math.max(bottom, Math.round((bounds.y + bounds.height) * sy));
      }
      const ctx = this.damageCtx;
      if (rebuild) ctx.clearRect(0, 0, this.damageOverlay.width, this.damageOverlay.height);
      if (minIx !== Infinity) {
        // Snap shared mesh edges to the same pixel. Repaint the complete dirty
        // rectangle, including unchanged neighbors, before applying coast alpha
        // exactly once. This prevents seams and repeatedly fading coastal pixels.
        ctx.clearRect(left, top, right - left, bottom - top);
        for (let iy = minIy; iy <= maxIy; iy++) {
          for (let ix = minIx; ix <= maxIx; ix++) {
            const id = iy * MESH_GRID.width + ix;
            const damage = state.meshDamage[id];
            if (!damage || damage.damage <= 0) continue;
            const bounds = this.populationBounds.get(id);
            if (!bounds) continue;
            const x = Math.round(bounds.x * sx);
            const y = Math.round(bounds.y * sy);
            const width = Math.round((bounds.x + bounds.width) * sx) - x;
            const height = Math.round((bounds.y + bounds.height) * sy) - y;
            if (this.layer === 'assets') {
              ctx.fillStyle = assetFill(initialAssetPoints(bounds.population), remainingAssetPoints(bounds, state));
            } else {
              const total = damage.remaining + damage.damage;
              const fraction = total > 0 ? Math.min(1, damage.damage / total) : 0;
              ctx.fillStyle = `rgba(188, 74, 53, ${0.12 + fraction * 0.52})`;
            }
            ctx.fillRect(x, y, width, height);
            this.hasDamagePixels = true;
          }
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, right - left, bottom - top);
        ctx.clip();
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(this.landMask, 0, 0);
        ctx.restore();
      }
      state.meshDamageDirtyIds.clear();
      this.damageNeedsRebuild = false;
      this.lastDamagePaint = frame.time;
    }
    if (this.hasDamagePixels) this.ctx.drawImage(this.damageOverlay, 0, 0, MAP_WIDTH, MAP_HEIGHT);
  }

  private drawCompass(ctx: CanvasRenderingContext2D): void {
    const x = MAP_WIDTH - 57;
    const y = 63;
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = '#7caaa0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 23, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#5d9186';
    ctx.beginPath();
    ctx.moveTo(0, -18);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#b0c9bb';
    ctx.beginPath();
    ctx.moveTo(0, -18);
    ctx.lineTo(-6, 7);
    ctx.lineTo(0, 3);
    ctx.closePath();
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.font = `700 11px ${FONT}`;
    ctx.fillStyle = '#628f84';
    ctx.fillText('N', 0, -31);
    ctx.restore();
  }

  private drawSeaMotion(time: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = '#91bdb063';
    ctx.lineWidth = 1.5;
    const waves = [{ x: 119, y: 228 }, { x: 274, y: 304 }, { x: 824, y: 435 }, { x: 521, y: 655 }, { x: 891, y: 682 }, { x: 81, y: 589 }, { x: 601, y: 110 }];
    for (let i = 0; i < waves.length; i++) {
      const { x, y } = waves[i];
      const offset = Math.sin(time / 1700 + i) * 3;
      ctx.beginPath();
      ctx.moveTo(x - 14 + offset, y);
      ctx.quadraticCurveTo(x - 7 + offset, y + 5, x + offset, y);
      ctx.quadraticCurveTo(x + 7 + offset, y - 5, x + 14 + offset, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 5 + offset, y + 8);
      ctx.lineTo(x + 9 + offset, y + 8);
      ctx.stroke();
    }
    ctx.restore();
  }

  private placeCityLabels(): void {
    const ctx = this.ctx;
    this.cityFontSize = Math.max(14, 10.5 / this.scale);
    ctx.font = `700 ${this.cityFontSize}px ${FONT}`;
    const occupied: { x: number; y: number; width: number; height: number }[] = [];
    const labels: Label[] = [];
    const majorOnly = this.cssWidth < 500;
    const priority = [...CITIES].sort((a, b) => b.weight - a.weight);
    for (const city of priority) {
      if (majorOnly && priority.indexOf(city) > 7 && !['tokyo', 'osaka', 'nagoya'].includes(city.id)) continue;
      const width = ctx.measureText(city.name).width + 6;
      const height = this.cityFontSize + 6;
      const gap = 13;
      const { x, y } = city.position;
      const candidates = [
        { x: x + gap, y: y - height / 2 },
        { x: x - width - gap, y: y - height / 2 },
        { x: x - width / 2, y: y - height - gap },
        { x: x - width / 2, y: y + gap },
        { x: x + gap, y: y - height - 6 },
        { x: x - width - gap, y: y + 5 },
      ];
      const fits = (candidate: Point): boolean => {
        if (candidate.x < 10 || candidate.x + width > MAP_WIDTH - 10 || candidate.y < 12 || candidate.y + height > MAP_HEIGHT - 16) return false;
        if (occupied.some((other) => candidate.x < other.x + other.width + 3 && candidate.x + width + 3 > other.x && candidate.y < other.y + other.height + 3 && candidate.y + height + 3 > other.y)) return false;
        return !CITIES.some((other) => other.id !== city.id && other.position.x > candidate.x - 9 && other.position.x < candidate.x + width + 9 && other.position.y > candidate.y - 5 && other.position.y < candidate.y + height + 5);
      };
      let position = candidates.find(fits);
      const essential = ['tokyo', 'osaka', 'nagoya'].includes(city.id);
      if (!position && essential) {
        // Dense Kansai/Chubu cities need more room at a readable mobile font size.
        // Prefer the open sea below/east, then search progressively farther away.
        const distantCandidates: Point[] = [];
        for (let ring = 1; ring <= 8; ring++) {
          const distance = ring * (height + gap);
          distantCandidates.push(
            { x: x + gap, y: y + distance },
            { x: x - width / 2, y: y + distance },
            { x: x + distance, y: y - height / 2 },
            { x: x + distance, y: y + distance },
            { x: x - width - gap, y: y + distance },
            { x: x - width / 2, y: y - height - distance },
          );
        }
        position = distantCandidates.find(fits);
      }
      if (!position) continue;
      const anchor = {
        x: Math.max(position.x, Math.min(position.x + width, x)),
        y: Math.max(position.y, Math.min(position.y + height, y)),
      };
      occupied.push({ ...position, width, height });
      labels.push({ id: city.id, x: position.x + 3, y: position.y + height / 2, width, height, align: 'left', leader: Math.hypot(anchor.x - x, anchor.y - y) > gap * 2 ? anchor : undefined });
    }
    this.labels = labels;
  }

  private buildCityCaches(markerMask: number, includeLabels = true): void {
    const configure = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
      canvas.width = this.canvas.width;
      canvas.height = this.canvas.height;
      const ctx = canvas.getContext('2d')!;
      // Align cached text and markers to the same device pixels as direct paint.
      ctx.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale, this.dpr * this.offsetX, this.dpr * this.offsetY);
      return ctx;
    };
    const pixelScale = this.dpr * this.scale;
    const tileSize = Math.ceil(36 * pixelScale) + 2;
    this.cityBaseCache.width = tileSize * CITIES.length;
    this.cityBaseCache.height = tileSize * 2;
    let ctx = this.cityBaseCache.getContext('2d')!;
    this.cityTiles = [];
    for (const [index, city] of CITIES.entries()) {
      const x = Math.floor(this.dpr * this.offsetX + (city.position.x - 18) * pixelScale);
      const y = Math.floor(this.dpr * this.offsetY + (city.position.y - 18) * pixelScale);
      const sourceX = index * tileSize;
      this.cityTiles.push({ x, y, sourceX, size: tileSize });
      const position = (row: number) => ctx.setTransform(pixelScale, 0, 0, pixelScale, sourceX - x + this.dpr * this.offsetX + city.position.x * pixelScale, row * tileSize - y + this.dpr * this.offsetY + city.position.y * pixelScale);
      position(0);
      ctx.fillStyle = '#789e8875';
      ctx.fillRect(-15, -7, 6, 5);
      ctx.fillRect(-9, -14, 5, 7);
      ctx.fillRect(8, 3, 6, 7);
      position(1);
      const markerSize = 5 + Math.sqrt(city.weight / this.maxCityWeight) * 3;
      ctx.beginPath();
      ctx.arc(0, 0, markerSize + 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fffdf4';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, markerSize, 0, Math.PI * 2);
      ctx.fillStyle = (markerMask & (1 << index)) !== 0 ? '#c49b7b' : CORAL;
      ctx.fill();
      ctx.strokeStyle = '#bd6655';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(-1.5, -1.5, 1.7, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd6b6';
      ctx.fill();
    }
    this.cityMarkerMask = markerMask;
    if (!includeLabels) return;
    ctx = configure(this.cityLabelCache);
    ctx.save();
    ctx.font = `700 ${this.cityFontSize}px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    for (const label of this.labels) {
      const city = CITIES.find((c) => c.id === label.id)!;
      if (label.leader) {
        const angle = Math.atan2(label.leader.y - city.position.y, label.leader.x - city.position.x);
        ctx.beginPath();
        ctx.moveTo(city.position.x + Math.cos(angle) * 12, city.position.y + Math.sin(angle) * 12);
        ctx.lineTo(label.leader.x, label.leader.y);
        ctx.lineWidth = Math.max(1.2, 0.7 / this.scale);
        ctx.strokeStyle = '#729286';
        ctx.stroke();
      }
      ctx.textAlign = label.align;
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#eef6e6e8';
      ctx.strokeText(city.name, label.x, label.y);
      ctx.fillStyle = INK;
      ctx.fillText(city.name, label.x, label.y);
    }
    ctx.restore();
  }

  private drawCities(state: SimulationState | null): void {
    let markerMask = 0;
    const damaged = CITIES.map((city, index) => {
      const asset = state?.cityDamage[city.id];
      const fraction = asset ? Math.min(1, asset.damage / (asset.remaining + asset.damage || 1)) : 0;
      if (fraction > 0.8) markerMask |= 1 << index;
      return fraction;
    });
    if (markerMask !== this.cityMarkerMask) this.buildCityCaches(markerMask, false);
    const ctx = this.ctx;
    const pixelScale = this.dpr * this.scale;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < CITIES.length; i++) {
      const tile = this.cityTiles[i];
      const { sourceX, size, x, y } = tile;
      ctx.drawImage(this.cityBaseCache, sourceX, 0, size, size, x, y, size, size);
      if (damaged[i] > 0.01) {
        const center = CITIES[i].position;
        ctx.beginPath();
        ctx.arc(this.dpr * this.offsetX + center.x * pixelScale, this.dpr * this.offsetY + center.y * pixelScale, (16 + damaged[i] * 5) * pixelScale, -Math.PI / 2, -Math.PI / 2 + damaged[i] * Math.PI * 2);
        ctx.strokeStyle = '#e8987080';
        ctx.lineWidth = 5 * pixelScale;
        ctx.stroke();
      }
      ctx.drawImage(this.cityBaseCache, sourceX, size, size, size, x, y, size, size);
    }
    ctx.drawImage(this.cityLabelCache, 0, 0);
    ctx.restore();
  }

  private drawRoute(frame: RenderFrame): void {
    const { route, state } = frame;
    if (route.length < 2) return;
    const endpoint = route[route.length - 1];
    const last = `${endpoint.x},${endpoint.y}`;
    if (route !== this.routeRef || route.length !== this.routeCount || last !== this.lastRoutePoint) {
      this.routeRef = route;
      this.routeCount = route.length;
      this.lastRoutePoint = last;
      this.routePath = new Path2D();
      this.routePath.moveTo(route[0].x, route[0].y);
      for (let i = 1; i < route.length; i++) this.routePath.lineTo(route[i].x, route[i].y);
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#fffdf2d9';
    ctx.lineWidth = 8;
    ctx.stroke(this.routePath);
    ctx.strokeStyle = frame.phase === 'planning' ? CORAL : '#ed937d';
    ctx.lineWidth = 3.5;
    ctx.setLineDash([7, 8]);
    ctx.lineDashOffset = frame.phase === 'planning' ? -frame.time / 95 : 0;
    ctx.stroke(this.routePath);
    ctx.setLineDash([]);

    if (state && frame.phase !== 'planning') {
      const segment = Math.max(0, Math.min(state.routeSegment, route.length - 1));
      if (this.traveledRoute !== route || segment < this.traveledSegment || state.elapsedDays < this.lastElapsedDays) {
        this.traveledPath = new Path2D();
        this.traveledPath.moveTo(route[0].x, route[0].y);
        this.traveledSegment = 0;
        this.traveledRoute = route;
      }
      for (let i = this.traveledSegment + 1; i <= segment; i++) this.traveledPath.lineTo(route[i].x, route[i].y);
      this.traveledSegment = segment;
      this.lastElapsedDays = state.elapsedDays;
      ctx.strokeStyle = '#dd705a';
      ctx.lineWidth = 4;
      ctx.stroke(this.traveledPath);
      ctx.beginPath();
      ctx.moveTo(route[segment].x, route[segment].y);
      ctx.lineTo(state.position.x, state.position.y);
      ctx.stroke();
    } else {
      this.traveledRoute = null;
      this.traveledSegment = -1;
      this.lastElapsedDays = -1;
    }

    ctx.beginPath();
    ctx.arc(endpoint.x, endpoint.y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fffcf3';
    ctx.fill();
    ctx.strokeStyle = '#df7963';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    const previous = route[route.length - 2];
    const angle = Math.atan2(endpoint.y - previous.y, endpoint.x - previous.x);
    ctx.translate(endpoint.x, endpoint.y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(-17, -6);
    ctx.lineTo(-9, 0);
    ctx.lineTo(-17, 6);
    ctx.stroke();
    ctx.restore();
  }

  private drawStart(frame: RenderFrame): void {
    const ctx = this.ctx;
    const pulse = 1 + Math.sin(frame.time / 650) * 0.045;
    ctx.save();
    ctx.translate(START_POINT.x, START_POINT.y);
    ctx.scale(pulse, pulse);
    ctx.beginPath();
    ctx.arc(0, 0, 52, 0, Math.PI * 2);
    ctx.fillStyle = '#fff9e273';
    ctx.fill();
    ctx.strokeStyle = '#cda7709c';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 6]);
    ctx.stroke();
    ctx.restore();
    if (frame.route.length > 1 || frame.drawing) return;
    ctx.save();
    const size = Math.max(13, 10 / this.scale);
    ctx.font = `700 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = 'ここから、ぐいっと！';
    const width = ctx.measureText(text).width + 28;
    roundRect(ctx, START_POINT.x - width / 2, START_POINT.y + 60, width, size + 23, 15);
    ctx.fillStyle = '#fffdf1';
    ctx.fill();
    ctx.strokeStyle = '#d5cbb1';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#79633f';
    ctx.fillText(text, START_POINT.x, START_POINT.y + 72 + size / 2);
    ctx.restore();
  }

  private buildCloudSprite(): void {
    this.cloudSprite.width = this.cloudSprite.height = 336;
    const ctx = this.cloudSprite.getContext('2d')!;
    ctx.setTransform(3, 0, 0, 3, 168, 168);
    ctx.save();
    // A continuous cloud core joins seven swept, tapering plumes. Their long
    // curved edges and smaller trailing barbs suggest feathered rain bands.
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, Math.PI * 2);
    ctx.fillStyle = '#dcece7';
    ctx.shadowColor = '#497c6d30';
    ctx.shadowOffsetY = 3;
    ctx.shadowBlur = 5;
    ctx.fill();
    ctx.shadowColor = 'transparent';

    const lengths = [46, 43, 47, 44, 46, 45, 43];
    for (let i = 0; i < 7; i++) {
      ctx.save();
      ctx.rotate((i * Math.PI * 2) / 7 + Math.sin(i * 1.7) * 0.045);
      const length = lengths[i];
      const sweep = 1.3 + (i % 3) * 0.055;
      const plumePoint = (t: number) => {
        const radius = 16 + (length - 16) * t;
        const angle = -sweep * t;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        const dx = (length - 16) * Math.cos(angle) + radius * sweep * Math.sin(angle);
        const dy = (length - 16) * Math.sin(angle) - radius * sweep * Math.cos(angle);
        const norm = Math.hypot(dx, dy);
        const width = 11.8 * Math.pow(1 - t, 0.68) * (0.87 + Math.sin(t * Math.PI) * 0.13);
        return { x, y, nx: -dy / norm, ny: dx / norm, width };
      };
      const plume = new Path2D();
      for (let side = 0; side < 2; side++) {
        for (let j = 0; j <= 32; j++) {
          const t = (side === 0 ? j : 32 - j) / 32;
          const point = plumePoint(t);
          const direction = side === 0 ? 1 : -1;
          // Very small scallops soften the cloud edge without a toothed silhouette.
          const scallop = 1 + Math.sin(t * Math.PI * 5) * Math.sin(t * Math.PI) * 0.035;
          const x = point.x + point.nx * point.width * direction * scallop;
          const y = point.y + point.ny * point.width * direction * scallop;
          if (side === 0 && j === 0) plume.moveTo(x, y);
          else plume.lineTo(x, y);
        }
      }
      plume.closePath();
      ctx.save();
      ctx.translate(0.6, 1.7);
      ctx.fillStyle = '#bcd6ce';
      ctx.fill(plume);
      ctx.restore();
      const cloud = ctx.createLinearGradient(-8, -34, 33, 8);
      cloud.addColorStop(0, '#ffffff');
      cloud.addColorStop(0.65, '#fcfefa');
      cloud.addColorStop(1, '#e8f2ee');
      ctx.fillStyle = cloud;
      ctx.fill(plume);
      ctx.strokeStyle = '#8fb2a991';
      ctx.lineWidth = 0.85;
      ctx.stroke(plume);

      // A gently curved quill and two secondary wisps follow the same sweep.
      ctx.beginPath();
      for (let j = 0; j <= 20; j++) {
        const p = plumePoint(0.26 + (j / 20) * 0.65);
        if (j === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = '#bad5ce';
      ctx.lineWidth = 1.1;
      ctx.stroke();
      for (const t of [0.34, 0.56]) {
        const root = plumePoint(t);
        const middle = plumePoint(t + 0.12);
        const tip = plumePoint(t + 0.24);
        ctx.beginPath();
        ctx.moveTo(root.x, root.y);
        ctx.quadraticCurveTo(
          middle.x + middle.nx * middle.width * 0.72,
          middle.y + middle.ny * middle.width * 0.72,
          tip.x + tip.nx * tip.width * 0.86,
          tip.y + tip.ny * tip.width * 0.86,
        );
        ctx.strokeStyle = '#b6d1c8b8';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();
    }
    // Soft inner curl connects the plumes into one continuous storm.
    ctx.beginPath();
    ctx.arc(0, 0, 23, 0, Math.PI * 2);
    ctx.fillStyle = '#f6fbf6';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, 23, -0.8, 3.75);
    ctx.strokeStyle = '#b2cfc5';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  private drawTyphoon(position: Point, strength: number, time: number, phase: RenderFrame['phase']): void {
    const ctx = this.ctx;
    const size = (0.77 + Math.max(0, strength) / 275) * Math.max(1, 0.52 / this.scale);
    ctx.save();
    ctx.translate(position.x, position.y + Math.sin(time / 250) * 1.4);
    ctx.scale(size, size);
    if (phase === 'finished') ctx.globalAlpha = 0.76;

    // Thin wind wisps turn in the same direction as the spiral cloud bands.
    ctx.save();
    ctx.rotate(-time / (phase === 'running' ? 700 : 2100));
    ctx.strokeStyle = '#88afa35e';
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(0, 0, 49 + i * 1.2, i * 2.1, i * 2.1 + 0.42);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.rotate(-time / (phase === 'running' ? 1050 : 3100));
    ctx.drawImage(this.cloudSprite, -56, -56, 112, 112);
    ctx.restore();

    // Keep the little face upright while its cloud feathers rotate around it.
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, Math.PI * 2);
    ctx.fillStyle = '#fffef8';
    ctx.fill();
    ctx.strokeStyle = '#8aafa1';
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.fillStyle = INK;
    if (phase === 'finished') {
      for (const x of [-6, 6]) {
        ctx.beginPath();
        ctx.moveTo(x - 2.5, -4);
        ctx.lineTo(x + 2.5, 0);
        ctx.moveTo(x + 2.5, -4);
        ctx.lineTo(x - 2.5, 0);
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    } else {
      for (const x of [-6, 6]) {
        ctx.beginPath();
        ctx.ellipse(x, -2, 2.1, 3, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, 3, 5, 0.12, Math.PI - 0.12);
    ctx.stroke();
    ctx.fillStyle = '#efbdab';
    ctx.beginPath();
    ctx.ellipse(-11, 4, 2.6, 1.6, 0, 0, Math.PI * 2);
    ctx.ellipse(11, 4, 2.6, 1.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawEvents(frame: RenderFrame): void {
    if (frame.phase === 'planning') {
      this.seenEvents.clear();
      this.popups = [];
      return;
    }
    if (!frame.state) return;
    for (const event of frame.state.events) {
      if (this.seenEvents.has(event.id)) continue;
      this.seenEvents.add(event.id);
      this.popups.push({ id: event.id, kind: event.kind, text: event.text, position: { ...event.position }, born: frame.time, score: event.score });
    }
    this.popups = this.popups.filter((popup) => frame.time - popup.born < 2700).slice(-4);
    const ctx = this.ctx;
    const fontSize = Math.max(13, 11 / this.scale);
    for (let index = 0; index < this.popups.length; index++) {
      const popup = this.popups[index];
      const age = frame.time - popup.born;
      const fade = this.reducedMotion.matches ? 1 : Math.min(1, age / 180, (2700 - age) / 450);
      const rise = this.reducedMotion.matches ? 0 : Math.min(30, age / 65);
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.font = `800 ${fontSize}px ${FONT}`;
      const text = popup.score && popup.score >= 1 ? `${popup.text} +${Math.round(popup.score).toLocaleString('ja-JP')}` : popup.text;
      const width = Math.min(MAP_WIDTH - 30, ctx.measureText(text).width + 26);
      const x = Math.max(15, Math.min(MAP_WIDTH - width - 15, popup.position.x - width / 2));
      const y = Math.max(12, popup.position.y - 55 - rise - index * 4);
      const height = fontSize + 22;
      ctx.shadowColor = '#224d4920';
      ctx.shadowBlur = 9;
      ctx.shadowOffsetY = 3;
      roundRect(ctx, x, y, width, height, 12);
      ctx.fillStyle = popup.kind === 'city' || popup.kind === 'hit' ? '#fff3d5' : '#fffdf2';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = popup.kind === 'city' || popup.kind === 'hit' ? '#e6b164' : '#b7c9ad';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = INK;
      ctx.fillText(text, x + width / 2, y + height / 2, width - 20);
      ctx.restore();
    }
  }
}
