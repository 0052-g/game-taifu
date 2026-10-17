import { LANDMASSES, MAP_HEIGHT, MAP_WIDTH, MOUNTAIN_ZONES, START_POINT } from './data/map';
import { CITIES } from './data/cities';
import { SIMULATION_CONFIG } from './config';
import type { Point, SimulationState } from './types';

export interface RenderFrame {
  route: Point[];
  state: SimulationState | null;
  phase: 'planning' | 'running' | 'finished';
  time: number;
  drawing: boolean;
}

type Label = { id: string; x: number; y: number; width: number; height: number; align: CanvasTextAlign; leader?: Point };
type Popup = { id: number | string; text: string; position: Point; born: number; kind: string; score?: number };

const INK = '#234f4b';
const CORAL = '#f47b65';
const FONT = '"Noto Sans JP", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif';

function polygon(ctx: CanvasRenderingContext2D, points: readonly Point[]): void {
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

/** Canvas coordinates stay in map units; pointer input uses the same fitted transform. */
export class CanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly background: HTMLCanvasElement;
  private cssWidth = MAP_WIDTH;
  private cssHeight = MAP_HEIGHT;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private dpr = 1;
  private labels: Label[] = [];
  private cityFontSize = 14;
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
    const context = canvas.getContext('2d');
    if (!context) throw new Error('このブラウザでは Canvas 2D を利用できません。');
    this.ctx = context;
    this.background = document.createElement('canvas');
    this.buildBackground();
    this.resize();
  }

  resize(): void {
    const bounds = this.canvas.getBoundingClientRect();
    this.cssWidth = Math.max(1, bounds.width);
    this.cssHeight = Math.max(1, bounds.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(this.cssWidth * this.dpr);
    this.canvas.height = Math.round(this.cssHeight * this.dpr);
    this.scale = Math.min(this.cssWidth / MAP_WIDTH, this.cssHeight / MAP_HEIGHT);
    this.offsetX = (this.cssWidth - MAP_WIDTH * this.scale) / 2;
    this.offsetY = (this.cssHeight - MAP_HEIGHT * this.scale) / 2;
    this.placeCityLabels();
  }

  screenToWorld(clientX: number, clientY: number): Point {
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - bounds.left - this.offsetX) / this.scale,
      y: (clientY - bounds.top - this.offsetY) / this.scale,
    };
  }

  render(frame: RenderFrame): void {
    // A retry may replace the simulation directly without an intervening planning frame.
    if (frame.state !== this.renderedState) {
      this.renderedState = frame.state;
      this.seenEvents.clear();
      this.popups = [];
      this.traveledRoute = null;
      this.traveledSegment = -1;
      this.lastElapsedDays = -1;
    }
    const motionFrame = this.reducedMotion.matches ? { ...frame, time: 0 } : frame;
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.fillStyle = '#e7f3ef';
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    ctx.clip();
    ctx.drawImage(this.background, 0, 0, MAP_WIDTH, MAP_HEIGHT);
    this.drawSeaMotion(motionFrame.time);
    this.drawCities(frame.state);
    this.drawRoute(motionFrame);
    if (frame.phase === 'planning') this.drawStart(motionFrame);
    const position = frame.state?.position ?? START_POINT;
    this.drawTyphoon(position, frame.state?.strength ?? SIMULATION_CONFIG.initialStrength, motionFrame.time, frame.phase);
    this.drawEvents(frame);
    ctx.restore();
  }

  private buildBackground(): void {
    // A fixed high-resolution layer keeps every animation frame inexpensive.
    this.background.width = MAP_WIDTH * 2;
    this.background.height = MAP_HEIGHT * 2;
    const ctx = this.background.getContext('2d')!;
    ctx.scale(2, 2);
    ctx.fillStyle = '#e4f3ef';
    ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    const warm = ctx.createRadialGradient(200, 800, 30, 220, 750, 600);
    warm.addColorStop(0, '#f5edcf');
    warm.addColorStop(0.55, '#edf1de');
    warm.addColorStop(1, '#e4f3ef00');
    ctx.fillStyle = warm;
    ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

    // A quiet survey grid adds texture without competing with a drawn course.
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

    for (const land of LANDMASSES) {
      ctx.save();
      ctx.translate(0, 4);
      polygon(ctx, land.points);
      ctx.fillStyle = '#80b7a53f';
      ctx.fill();
      ctx.restore();
      polygon(ctx, land.points);
      ctx.fillStyle = '#aed6ad';
      ctx.fill();
      ctx.strokeStyle = '#4e8a73';
      ctx.lineWidth = 2.1;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.save();
      ctx.clip();
      ctx.translate(-2, -3);
      polygon(ctx, land.points);
      ctx.strokeStyle = '#d5e8b7';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.restore();
    }

    // Mountain shading uses the simulation polygons, so the visual hint matches play.
    ctx.save();
    ctx.beginPath();
    for (const land of LANDMASSES) {
      if (!land.points.length) continue;
      ctx.moveTo(land.points[0].x, land.points[0].y);
      for (const p of land.points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.closePath();
    }
    ctx.clip();
    for (const mountain of MOUNTAIN_ZONES) {
      ctx.save();
      polygon(ctx, mountain.points);
      ctx.fillStyle = '#739f7865';
      ctx.fill();
      ctx.clip();
      const minX = Math.min(...mountain.points.map((p) => p.x));
      const maxX = Math.max(...mountain.points.map((p) => p.x));
      const minY = Math.min(...mountain.points.map((p) => p.y));
      const maxY = Math.max(...mountain.points.map((p) => p.y));
      ctx.strokeStyle = '#5f8d7388';
      ctx.lineWidth = 1.4;
      for (let y = minY; y <= maxY + 12; y += 20) {
        for (let x = minX + (Math.round(y / 20) % 2) * 13; x <= maxX; x += 26) {
          ctx.beginPath();
          ctx.moveTo(x - 6, y + 5);
          ctx.lineTo(x, y - 5);
          ctx.lineTo(x + 6, y + 5);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
    ctx.restore();

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
    ctx.textAlign = 'left';
    ctx.font = `500 11px ${FONT}`;
    ctx.fillStyle = '#7b9e92';
    ctx.fillText('ゲーム用の簡略地図', 30, MAP_HEIGHT - 24);
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
      if (majorOnly && city.weight < 35_000 && priority.indexOf(city) > 7) continue;
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

  private drawCities(state: SimulationState | null): void {
    const ctx = this.ctx;
    for (const city of CITIES) {
      const { x, y } = city.position;
      const asset = state?.cityDamage[city.id];
      const damaged = asset ? Math.min(1, asset.damage / (asset.remaining + asset.damage || 1)) : 0;
      const markerSize = 5 + Math.min(3, city.weight / 40_000);
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = '#789e8875';
      ctx.fillRect(-15, -7, 6, 5);
      ctx.fillRect(-9, -14, 5, 7);
      ctx.fillRect(8, 3, 6, 7);
      if (damaged > 0.01) {
        ctx.beginPath();
        ctx.arc(0, 0, 16 + damaged * 5, -Math.PI / 2, -Math.PI / 2 + damaged * Math.PI * 2);
        ctx.strokeStyle = '#e8987080';
        ctx.lineWidth = 5;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(0, 0, markerSize + 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fffdf4';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, markerSize, 0, Math.PI * 2);
      ctx.fillStyle = damaged > 0.8 ? '#c49b7b' : CORAL;
      ctx.fill();
      ctx.strokeStyle = '#bd6655';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(-1.5, -1.5, 1.7, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd6b6';
      ctx.fill();
      ctx.restore();
    }
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
