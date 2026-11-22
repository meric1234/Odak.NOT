// Sıfır Gecikmeli S Pen Motoru, TouchGestureRecognizer, AABB Çarpışma, SelectionGizmo ve Sıfır Kopya Undo/Redo

import { rdpSimplify } from "./storage.js";

// 2x3 Afin Dönüşüm Matrisi: [a, b, c, d, tx, ty]
export const Affine2D = {
  identity: () => [1, 0, 0, 1, 0, 0],
  translate: (tx, ty) => [1, 0, 0, 1, tx, ty],
  scaleAt: (sx, sy, cx, cy) => [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy],
  rotateAt: (rad, cx, cy) => {
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
  },
  multiply(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  },
  invert(m) {
    const [a, b, c, d, tx, ty] = m;
    const det = a * d - b * c || 1e-8;
    return [
      d / det,
      -b / det,
      -c / det,
      a / det,
      (c * ty - d * tx) / det,
      (b * tx - a * ty) / det
    ];
  },
  applyToFloat32InPlace(pts, m) {
    const [a, b, c, d, tx, ty] = m;
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i];
      const y = pts[i + 1];
      pts[i] = a * x + c * y + tx;
      pts[i + 1] = b * x + d * y + ty;
    }
  }
};

// AABB & Math.sqrt Kullanmayan Narrow-Phase Çarpışma ve Kısmi Segment Bölme Motoru
export const CollisionEngine = {
  computeBBox(pts, pad = 4) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i];
      const y = pts[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  },

  mergeBBoxes(boxes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of boxes) {
      if (!b) continue;
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
    }
    return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  },

  aabbOverlap(a, b) {
    return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
  },

  pointToSegmentDistSq(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return (px - ax) * (px - ax) + (py - ay) * (py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    return (px - cx) * (px - cx) + (py - cy) * (py - cy);
  },

  segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
    const ccw = (p1x, p1y, p2x, p2y, p3x, p3y) =>
      (p3y - p1y) * (p2x - p1x) > (p2y - p1y) * (p3x - p1x);
    return (
      ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy) &&
      ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy)
    );
  },

  isPointInPolygon(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersect =
        yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  },

  strokeHitsCircle(stroke, cx, cy, radius) {
    const rSq = radius * radius;
    const pts = stroke.points;
    if (pts.length === 3) {
      const dx = pts[0] - cx;
      const dy = pts[1] - cy;
      return dx * dx + dy * dy <= rSq;
    }
    for (let i = 0; i < pts.length - 3; i += 3) {
      if (this.pointToSegmentDistSq(cx, cy, pts[i], pts[i + 1], pts[i + 3], pts[i + 4]) <= rSq) {
        return true;
      }
    }
    return false;
  },

  // Kısmi Silgi: Çizgiyi daire ile kesişen noktalardan bölerek kalan parçaları döndürür
  splitStrokeByCircle(stroke, cx, cy, radius) {
    const rSq = radius * radius;
    const pts = stroke.points;
    const chunks = [];
    let currentChunk = [];

    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i], y = pts[i + 1], p = pts[i + 2];
      const dx = x - cx, dy = y - cy;
      const insidePoint = dx * dx + dy * dy <= rSq;

      let segmentCut = false;
      if (i > 0) {
        const px = pts[i - 3], py = pts[i - 2];
        if (this.pointToSegmentDistSq(cx, cy, px, py, x, y) <= rSq) {
          segmentCut = true;
        }
      }

      if (insidePoint || segmentCut) {
        if (currentChunk.length >= 6) {
          chunks.push(new Float32Array(currentChunk));
        }
        currentChunk = [];
        if (!insidePoint) {
          currentChunk.push(x, y, p);
        }
      } else {
        currentChunk.push(x, y, p);
      }
    }

    if (currentChunk.length >= 6) {
      chunks.push(new Float32Array(currentChunk));
    }

    return chunks.map((f32) => ({
      id: `st_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      tool: stroke.tool,
      color: stroke.color,
      width: stroke.width,
      opacity: stroke.opacity,
      lineCap: stroke.lineCap || "round",
      points: f32,
      bbox: this.computeBBox(f32, stroke.width * 1.5),
      deleted: false
    }));
  },

  strokeInsidePolygon(stroke, poly, polyBBox) {
    if (!this.aabbOverlap(stroke.bbox, polyBBox)) return false;
    const pts = stroke.points;
    let insideCount = 0;
    const total = pts.length / 3;
    for (let i = 0; i < pts.length; i += 3) {
      if (this.isPointInPolygon(pts[i], pts[i + 1], poly)) insideCount++;
    }
    return insideCount > 0 && insideCount >= total * 0.5;
  }
};

// Sıfır Kopya Komut Deseni (Command Pattern)
export class AddStrokesCommand {
  constructor(page, strokes) {
    this.page = page;
    this.strokes = strokes;
    this.dirtyBBox = CollisionEngine.mergeBBoxes(strokes.map((s) => s.bbox));
  }
  execute() {
    for (const s of this.strokes) {
      s.deleted = false;
      if (!this.page.strokes.includes(s)) this.page.strokes.push(s);
    }
  }
  undo() {
    for (const s of this.strokes) s.deleted = true;
  }
  permanentlyRemove() {
    this.page.strokes = this.page.strokes.filter((s) => !s.deleted);
  }
}

export class SplitOrEraseCommand {
  constructor(page, removedStrokes, addedStrokes = []) {
    this.page = page;
    this.removedStrokes = removedStrokes;
    this.addedStrokes = addedStrokes;
    this.dirtyBBox = CollisionEngine.mergeBBoxes([
      ...removedStrokes.map((s) => s.bbox),
      ...addedStrokes.map((s) => s.bbox)
    ]);
  }
  execute() {
    for (const s of this.removedStrokes) s.deleted = true;
    for (const s of this.addedStrokes) {
      s.deleted = false;
      if (!this.page.strokes.includes(s)) this.page.strokes.push(s);
    }
  }
  undo() {
    for (const s of this.addedStrokes) s.deleted = true;
    for (const s of this.removedStrokes) s.deleted = false;
  }
  permanentlyRemove() {
    this.page.strokes = this.page.strokes.filter((s) => !s.deleted);
  }
}

export class TransformStrokesCommand {
  constructor(page, strokes, matrix) {
    this.page = page;
    this.strokes = strokes;
    this.matrix = matrix;
    this.invMatrix = Affine2D.invert(matrix);
    this.beforeBox = CollisionEngine.mergeBBoxes(strokes.map((s) => s.bbox));
    this.dirtyBBox = this.beforeBox;
  }
  execute() {
    for (const s of this.strokes) {
      Affine2D.applyToFloat32InPlace(s.points, this.matrix);
      s.bbox = CollisionEngine.computeBBox(s.points, s.width);
    }
    const afterBox = CollisionEngine.mergeBBoxes(this.strokes.map((s) => s.bbox));
    this.dirtyBBox = CollisionEngine.mergeBBoxes([this.beforeBox, afterBox]);
  }
  undo() {
    for (const s of this.strokes) {
      Affine2D.applyToFloat32InPlace(s.points, this.invMatrix);
      s.bbox = CollisionEngine.computeBBox(s.points, s.width);
    }
  }
  permanentlyRemove() {}
}

export class HistoryManager {
  constructor(maxHistory = 60) {
    this.maxHistory = maxHistory;
    this.undoStack = [];
    this.redoStack = [];
  }

  push(cmd, alreadyExecuted = true) {
    if (!alreadyExecuted) cmd.execute();
    for (const abandoned of this.redoStack) abandoned.permanentlyRemove();
    this.redoStack = [];
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.maxHistory) {
      const oldest = this.undoStack.shift();
      oldest.permanentlyRemove();
    }
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    cmd.undo();
    this.redoStack.push(cmd);
    return cmd;
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    cmd.execute();
    this.undoStack.push(cmd);
    return cmd;
  }
}

// Çakışmasız Dokunmatik Jest Durum Makinesi (TouchGestureRecognizer)
export class TouchGestureRecognizer {
  constructor({ element, isPenBlocked, onTransform, onTransformEnd, onUndo, onRedo }) {
    this.element = element;
    this.isPenBlocked = isPenBlocked;
    this.onTransform = onTransform;
    this.onTransformEnd = onTransformEnd;
    this.onUndo = onUndo;
    this.onRedo = onRedo;

    this.MOVE_SLOP_PX = 12;
    this.TAP_MAX_MS = 280;

    this.pointers = new Map();
    this.isTransforming = false;
    this.sessionStartTime = 0;
    this.maxFingers = 0;
    this.startCentroid = { x: 0, y: 0 };
    this.anchorCentroid = { x: 0, y: 0 };
    this.anchorDist = 0;

    this._bind();
  }

  _bind() {
    this.element.addEventListener("pointerdown", (e) => this._onDown(e));
    this.element.addEventListener("pointermove", (e) => this._onMove(e));
    this.element.addEventListener("pointerup", (e) => this._onUp(e));
    this.element.addEventListener("pointercancel", (e) => this._onUp(e));
  }

  _getCentroidAndDist() {
    const pts = Array.from(this.pointers.values());
    let sx = 0, sy = 0;
    for (const p of pts) {
      sx += p.x;
      sy += p.y;
    }
    const cx = sx / pts.length;
    const cy = sy / pts.length;
    let dist = 0;
    if (pts.length >= 2) {
      dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    }
    return { cx, cy, dist };
  }

  _onDown(e) {
    if (e.pointerType !== "touch") return;
    if (this.isPenBlocked()) return;

    if (this.pointers.size === 0) {
      this.isTransforming = false;
      this.sessionStartTime = performance.now();
      this.maxFingers = 0;
    }

    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.maxFingers = Math.max(this.maxFingers, this.pointers.size);

    const { cx, cy, dist } = this._getCentroidAndDist();
    if (this.pointers.size === 1) this.startCentroid = { x: cx, y: cy };
    this.anchorCentroid = { x: cx, y: cy };
    this.anchorDist = dist;
  }

  _onMove(e) {
    if (e.pointerType !== "touch" || !this.pointers.has(e.pointerId)) return;
    if (this.isPenBlocked()) {
      this.pointers.clear();
      return;
    }

    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const { cx, cy, dist } = this._getCentroidAndDist();

    if (!this.isTransforming) {
      const moved = Math.hypot(cx - this.startCentroid.x, cy - this.startCentroid.y);
      const distDelta = this.anchorDist > 0 ? Math.abs(dist - this.anchorDist) : 0;
      if (moved > this.MOVE_SLOP_PX || distDelta > this.MOVE_SLOP_PX) {
        this.isTransforming = true;
        this.anchorCentroid = { x: cx, y: cy };
        this.anchorDist = dist;
      } else {
        return;
      }
    }

    const dx = cx - this.anchorCentroid.x;
    const dy = cy - this.anchorCentroid.y;
    const scaleRatio =
      this.pointers.size >= 2 && this.anchorDist > 10 && dist > 10 ? dist / this.anchorDist : 1;

    this.anchorCentroid = { x: cx, y: cy };
    if (dist > 10) this.anchorDist = dist;

    this.onTransform({ dx, dy, scaleRatio, centerX: cx, centerY: cy });
  }

  _onUp(e) {
    if (e.pointerType !== "touch" || !this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);

    if (this.pointers.size > 0) {
      const { cx, cy, dist } = this._getCentroidAndDist();
      this.anchorCentroid = { x: cx, y: cy };
      this.anchorDist = dist;
      return;
    }

    const elapsed = performance.now() - this.sessionStartTime;
    if (!this.isTransforming && elapsed < this.TAP_MAX_MS && !this.isPenBlocked()) {
      if (this.maxFingers === 2) this.onUndo();
      else if (this.maxFingers === 3) this.onRedo();
    } else if (this.isTransforming) {
      this.onTransformEnd();
    }
    this.isTransforming = false;
  }
}

// Etkileşimli Kement Seçim Kutusu (SelectionGizmo)
export class SelectionGizmo {
  constructor() {
    this.active = false;
    this.pageIndex = 0;
    this.strokes = [];
    this.cx = 0;
    this.cy = 0;
    this.hw = 0;
    this.hh = 0;
    this.angle = 0;
    this.dragMode = null;
    this.startPointer = { x: 0, y: 0 };
    this.accumMatrix = Affine2D.identity();
  }

  setSelection(pageIndex, strokes) {
    if (!strokes || strokes.length === 0) {
      this.clear();
      return;
    }
    this.active = true;
    this.pageIndex = pageIndex;
    this.strokes = strokes;
    const box = CollisionEngine.mergeBBoxes(strokes.map((s) => s.bbox));
    this.cx = (box.minX + box.maxX) / 2;
    this.cy = (box.minY + box.maxY) / 2;
    this.hw = Math.max(18, (box.maxX - box.minX) / 2 + 8);
    this.hh = Math.max(18, (box.maxY - box.minY) / 2 + 8);
    this.angle = 0;
  }

  clear() {
    this.active = false;
    this.strokes = [];
    this.dragMode = null;
  }

  _toLocal(wx, wy) {
    const dx = wx - this.cx;
    const dy = wy - this.cy;
    const cos = Math.cos(-this.angle);
    const sin = Math.sin(-this.angle);
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  }

  hitTest(wx, wy, zoom) {
    if (!this.active) return null;
    const local = this._toLocal(wx, wy);
    const r = 22 / zoom;
    const rotY = -this.hh - 28 / zoom;

    if (Math.hypot(local.x, local.y - rotY) <= r) return "rotate";

    const corners = [
      [-this.hw, -this.hh],
      [this.hw, -this.hh],
      [this.hw, this.hh],
      [-this.hw, this.hh]
    ];
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(local.x - corners[i][0], local.y - corners[i][1]) <= r) {
        return `scale-${i}`;
      }
    }

    if (Math.abs(local.x) <= this.hw && Math.abs(local.y) <= this.hh) {
      return "move";
    }
    return null;
  }

  draw(ctx, zoom) {
    if (!this.active) return;
    ctx.save();
    ctx.translate(this.cx, this.cy);
    ctx.rotate(this.angle);

    const lw = 1.6 / zoom;
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = lw;
    ctx.setLineDash([5 / zoom, 4 / zoom]);
    ctx.strokeRect(-this.hw, -this.hh, this.hw * 2, this.hh * 2);
    ctx.setLineDash([]);

    const rotY = -this.hh - 28 / zoom;
    ctx.beginPath();
    ctx.moveTo(0, -this.hh);
    ctx.lineTo(0, rotY);
    ctx.stroke();

    const hr = 6.5 / zoom;
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 2 / zoom;

    ctx.beginPath();
    ctx.arc(0, rotY, hr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const corners = [
      [-this.hw, -this.hh],
      [this.hw, -this.hh],
      [this.hw, this.hh],
      [-this.hw, this.hh]
    ];
    for (const [x, y] of corners) {
      ctx.beginPath();
      ctx.rect(x - hr, y - hr, hr * 2, hr * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
  }
}

// Ana Çizim Motoru
export class CanvasEngine {
  constructor({
    viewportEl,
    worldEl,
    pagesLayerEl,
    overlayCanvas,
    minimapCanvas,
    onDirtyPage,
    onSelectionChange,
    onTextBoxRequest,
    onImageRequest,
    onInfiniteExpand
  }) {
    this.viewportEl = viewportEl;
    this.worldEl = worldEl;
    this.pagesLayerEl = pagesLayerEl;
    this.overlayCanvas = overlayCanvas;
    this.overlayCtx = overlayCanvas.getContext("2d");
    this.minimapCanvas = minimapCanvas;
    this.minimapCtx = minimapCanvas.getContext("2d");

    this.onDirtyPage = onDirtyPage;
    this.onSelectionChange = onSelectionChange;
    this.onTextBoxRequest = onTextBoxRequest;
    this.onImageRequest = onImageRequest;
    this.onInfiniteExpand = onInfiniteExpand;

    this.pagesData = new Map();
    this.slots = new Map();
    this.history = new HistoryManager(60);
    this.gizmo = new SelectionGizmo();

    this.tool = "ballpoint";
    this.prevToolBeforeSideBtn = null;
    this.eraserMode = "partial";
    this.color = "#0f172a";
    this.size = 3.2;

    this.paperSettings = {
      template: "ruled-medium",
      theme: "cream",
      layout: "a4-portrait"
    };

    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.activePageIndex = 0;
    this.lastWrittenLocation = { pageIndex: 0, x: 200, y: 200 };

    this.isDrawing = false;
    this.penDown = false;
    this.lastPenLiftTime = 0;
    this.rawPoints = [];
    this.lassoPoints = [];
    this.laserTrails = [];
    this.holdTimer = null;
    this.snappedShapePoints = null;

    this._bindPointerEvents();
    this._startOverlayLoop();
  }

  isPenBlocked() {
    return this.penDown || performance.now() - this.lastPenLiftTime < 150;
  }

  setPaperSettings(settings) {
    this.paperSettings = { ...this.paperSettings, ...settings };
    for (const [idx, slot] of this.slots.entries()) {
      const m = this.pagesData.get(idx) || { width: 794, height: 1123 };
      this.drawPaper(slot.paperCanvas, m.width, m.height);
    }
  }

  getLayoutDimensions() {
    switch (this.paperSettings.layout) {
      case "a4-landscape":
        return { width: 1123, height: 794 };
      case "infinite":
        return { width: 2200, height: 2200 };
      default:
        return { width: 794, height: 1123 };
    }
  }

  registerMountedPage(pageIndex, slot, pageData) {
    this.slots.set(pageIndex, slot);
    if (!this.pagesData.has(pageIndex)) {
      this.pagesData.set(pageIndex, pageData);
    }
    const pd = this.pagesData.get(pageIndex);

    slot.paperCanvas.width = pd.width;
    slot.paperCanvas.height = pd.height;
    this.drawPaper(slot.paperCanvas, pd.width, pd.height);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    slot.strokeCanvas.width = Math.floor(pd.width * dpr);
    slot.strokeCanvas.height = Math.floor(pd.height * dpr);
    slot.strokeCanvas._dpr = dpr;

    this.redrawPage(pageIndex);
  }

  unregisterMountedPage(pageIndex) {
    this.slots.delete(pageIndex);
  }

  drawPaper(canvasOrCtx, width, height, scale = 1, isPdfPage = false) {
    const ctx = canvasOrCtx.getContext ? canvasOrCtx.getContext("2d") : canvasOrCtx;
    const { template, theme } = this.paperSettings;

    const palette = {
      white: { bg: "#ffffff", line: "#cbd5e1", accent: "#f87171" },
      cream: { bg: "#fdfbf4", line: "#e2dcc8", accent: "#ea580c" },
      dark: { bg: "#1e293b", line: "#334155", accent: "#60a5fa" }
    }[theme] || { bg: "#ffffff", line: "#cbd5e1", accent: "#f87171" };

    ctx.save();
    ctx.fillStyle = isPdfPage ? "#ffffff" : palette.bg;
    ctx.fillRect(0, 0, width, height);

    if (!isPdfPage && template !== "blank") {
      ctx.strokeStyle = palette.line;
      ctx.fillStyle = palette.line;
      ctx.lineWidth = Math.max(0.8, 1 * scale);

      if (template.startsWith("ruled-")) {
        const step = (template === "ruled-narrow" ? 24 : template === "ruled-wide" ? 46 : 34) * scale;
        ctx.beginPath();
        for (let y = step * 2; y < height - step; y += step) {
          ctx.moveTo(24 * scale, y);
          ctx.lineTo(width - 24 * scale, y);
        }
        ctx.stroke();
      } else if (template === "grid") {
        const step = 28 * scale;
        ctx.beginPath();
        for (let x = step; x < width; x += step) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
        }
        for (let y = step; y < height; y += step) {
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
        }
        ctx.stroke();
      } else if (template === "dot") {
        const step = 28 * scale;
        for (let x = step; x < width; x += step) {
          for (let y = step; y < height; y += step) {
            ctx.beginPath();
            ctx.arc(x, y, 1.3 * scale, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      } else if (template === "cornell") {
        const cueX = width * 0.28;
        const summaryY = height * 0.8;
        const headerY = 76 * scale;
        const step = 32 * scale;
        ctx.beginPath();
        for (let y = headerY + step; y < summaryY; y += step) {
          ctx.moveTo(cueX + 10 * scale, y);
          ctx.lineTo(width - 20 * scale, y);
        }
        ctx.stroke();

        ctx.strokeStyle = palette.accent;
        ctx.lineWidth = 1.6 * scale;
        ctx.beginPath();
        ctx.moveTo(0, headerY);
        ctx.lineTo(width, headerY);
        ctx.moveTo(cueX, headerY);
        ctx.lineTo(cueX, summaryY);
        ctx.moveTo(0, summaryY);
        ctx.lineTo(width, summaryY);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  redrawPage(pageIndex, dirtyBBox = null) {
    const slot = this.slots.get(pageIndex);
    const pd = this.pagesData.get(pageIndex);
    if (!slot || !pd) return;

    const canvas = slot.strokeCanvas;
    const ctx = canvas.getContext("2d");
    const dpr = canvas._dpr || 1;

    ctx.save();
    ctx.scale(dpr, dpr);

    if (dirtyBBox) {
      const x = Math.max(0, Math.floor(dirtyBBox.minX - 6));
      const y = Math.max(0, Math.floor(dirtyBBox.minY - 6));
      const w = Math.min(pd.width - x, Math.ceil(dirtyBBox.maxX - dirtyBBox.minX + 12));
      const h = Math.min(pd.height - y, Math.ceil(dirtyBBox.maxY - dirtyBBox.minY + 12));
      ctx.clearRect(x, y, w, h);
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
    } else {
      ctx.clearRect(0, 0, pd.width, pd.height);
    }

    for (const imgItem of pd.images || []) {
      if (imgItem._el && imgItem._el.complete) {
        ctx.drawImage(imgItem._el, imgItem.x, imgItem.y, imgItem.w, imgItem.h);
      }
    }

    this.drawStrokesList(ctx, pd.strokes || [], dirtyBBox);

    for (const txt of pd.texts || []) {
      ctx.save();
      ctx.fillStyle = txt.color || "#0f172a";
      ctx.font = `500 ${txt.size || 18}px -apple-system, BlinkMacSystemFont, sans-serif`;
      const lines = (txt.text || "").split("\n");
      lines.forEach((line, idx) => {
        ctx.fillText(line, txt.x, txt.y + (idx + 1) * (txt.size || 18) * 1.25);
      });
      ctx.restore();
    }

    ctx.restore();
    this.updateMinimap();
  }

  drawStrokesList(ctx, strokes, filterBBox = null) {
    for (const st of strokes) {
      if (st.deleted) continue;
      if (filterBBox && st.bbox && !CollisionEngine.aabbOverlap(st.bbox, filterBBox)) continue;
      this.drawSingleStroke(ctx, st);
    }
  }

  drawSingleStroke(ctx, st) {
    const pts = st.points;
    if (!pts || pts.length < 3) return;

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = st.lineCap || "round";

    if (st.tool === "highlighter") {
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = st.opacity ?? 0.36;
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.width * 4.5;
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 3; i < pts.length; i += 3) {
        ctx.lineTo(pts[i], pts[i + 1]);
      }
      ctx.stroke();
      ctx.restore();
      return;
    }

    ctx.strokeStyle = st.color;
    ctx.fillStyle = st.color;

    if (pts.length === 3) {
      ctx.beginPath();
      ctx.arc(pts[0], pts[1], Math.max(0.8, st.width * pts[2] * 0.5), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    // Dokulu Kurşun Kalem Efekti
    if (st.tool === "pencil") {
      for (let i = 0; i < pts.length - 3; i += 3) {
        const x0 = pts[i], y0 = pts[i + 1], p0 = pts[i + 2];
        const x1 = pts[i + 3], y1 = pts[i + 4], p1 = pts[i + 5];
        const pressure = (p0 + p1) * 0.5;
        ctx.globalAlpha = Math.min(0.92, 0.38 + pressure * 0.55);
        ctx.lineWidth = Math.max(0.7, st.width * (0.55 + pressure * 0.75));
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();

        // Grafit doku tanecikleri
        const grainX = (x0 + x1) * 0.5 + Math.sin(i * 1.7) * (st.width * 0.35);
        const grainY = (y0 + y1) * 0.5 + Math.cos(i * 2.3) * (st.width * 0.35);
        ctx.globalAlpha = 0.28;
        ctx.fillRect(grainX, grainY, 1.1, 1.1);
      }
      ctx.restore();
      return;
    }

    ctx.globalAlpha = st.opacity ?? 1;

    // Quadratic Bezier + Basınç Duyarlı Dinamik Kalınlık
    for (let i = 0; i < pts.length - 3; i += 3) {
      const x0 = pts[i], y0 = pts[i + 1], p0 = pts[i + 2];
      const x1 = pts[i + 3], y1 = pts[i + 4], p1 = pts[i + 5];
      const mx = (x0 + x1) * 0.5;
      const my = (y0 + y1) * 0.5;
      const pressure = (p0 + p1) * 0.5;
      const factor = st.tool === "ballpoint" ? 0.85 + pressure * 0.3 : 0.4 + pressure * 1.25;

      ctx.lineWidth = Math.max(0.7, st.width * factor);
      ctx.beginPath();
      if (i === 0) {
        ctx.moveTo(x0, y0);
        ctx.lineTo(mx, my);
      } else {
        const px = pts[i - 3], py = pts[i - 2];
        ctx.moveTo((px + x0) * 0.5, (py + y0) * 0.5);
        ctx.quadraticCurveTo(x0, y0, mx, my);
      }
      ctx.stroke();
    }

    ctx.restore();
  }

  _clientToPageCoords(clientX, clientY) {
    const wrappers = this.pagesLayerEl.querySelectorAll(".page-wrapper");
    let bestIdx = this.activePageIndex;
    let bestRect = null;
    let minDist = Infinity;

    wrappers.forEach((w) => {
      const r = w.getBoundingClientRect();
      const idx = Number(w.dataset.pageIndex);
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        bestIdx = idx;
        bestRect = r;
        minDist = 0;
      } else if (minDist > 0) {
        const dy = Math.max(0, r.top - clientY, clientY - r.bottom);
        if (dy < minDist) {
          minDist = dy;
          bestIdx = idx;
          bestRect = r;
        }
      }
    });

    if (!bestRect) return { pageIndex: 0, x: 0, y: 0 };
    return {
      pageIndex: bestIdx,
      x: (clientX - bestRect.left) / this.zoom,
      y: (clientY - bestRect.top) / this.zoom
    };
  }

  _bindPointerEvents() {
    // Capture fazında SelectionGizmo tutamaçlarını yakala
    this.viewportEl.addEventListener(
      "pointerdown",
      (e) => {
        if (!this.gizmo.active) return;
        const pt = this._clientToPageCoords(e.clientX, e.clientY);
        if (pt.pageIndex !== this.gizmo.pageIndex) return;
        const hit = this.gizmo.hitTest(pt.x, pt.y, this.zoom);
        if (hit) {
          e.stopPropagation();
          e.preventDefault();
          this.gizmo.dragMode = hit;
          this.gizmo.startPointer = pt;
          this.gizmo.accumMatrix = Affine2D.identity();
          this.viewportEl.setPointerCapture(e.pointerId);
        }
      },
      { capture: true }
    );

    this.viewportEl.addEventListener(
      "pointermove",
      (e) => {
        if (!this.gizmo.active || !this.gizmo.dragMode) return;
        e.stopPropagation();
        const pt = this._clientToPageCoords(e.clientX, e.clientY);
        const mode = this.gizmo.dragMode;
        let stepMat = Affine2D.identity();

        if (mode === "move") {
          const dx = pt.x - this.gizmo.startPointer.x;
          const dy = pt.y - this.gizmo.startPointer.y;
          this.gizmo.cx += dx;
          this.gizmo.cy += dy;
          stepMat = Affine2D.translate(dx, dy);
        } else if (mode === "rotate") {
          const prevA = Math.atan2(
            this.gizmo.startPointer.y - this.gizmo.cy,
            this.gizmo.startPointer.x - this.gizmo.cx
          );
          const curA = Math.atan2(pt.y - this.gizmo.cy, pt.x - this.gizmo.cx);
          let nextAngle = this.gizmo.angle + (curA - prevA);

          const snapThresh = (4 * Math.PI) / 180;
          const cardinals = [0, Math.PI / 2, Math.PI, -Math.PI / 2, -Math.PI];
          for (const c of cardinals) {
            if (Math.abs(nextAngle - c) < snapThresh) {
              nextAngle = c;
              break;
            }
          }
          const delta = nextAngle - this.gizmo.angle;
          this.gizmo.angle = nextAngle;
          stepMat = Affine2D.rotateAt(delta, this.gizmo.cx, this.gizmo.cy);
        } else if (mode.startsWith("scale-")) {
          const prevD = Math.max(10, Math.hypot(this.gizmo.startPointer.x - this.gizmo.cx, this.gizmo.startPointer.y - this.gizmo.cy));
          const curD = Math.max(10, Math.hypot(pt.x - this.gizmo.cx, pt.y - this.gizmo.cy));
          const s = curD / prevD;
          this.gizmo.hw *= s;
          this.gizmo.hh *= s;
          stepMat = Affine2D.scaleAt(s, s, this.gizmo.cx, this.gizmo.cy);
        }

        this.gizmo.startPointer = pt;
        this.gizmo.accumMatrix = Affine2D.multiply(stepMat, this.gizmo.accumMatrix);

        const beforeBox = CollisionEngine.mergeBBoxes(this.gizmo.strokes.map((s) => s.bbox));
        for (const s of this.gizmo.strokes) {
          Affine2D.applyToFloat32InPlace(s.points, stepMat);
          s.bbox = CollisionEngine.computeBBox(s.points, s.width);
        }
        const afterBox = CollisionEngine.mergeBBoxes(this.gizmo.strokes.map((s) => s.bbox));
        this.redrawPage(this.gizmo.pageIndex, CollisionEngine.mergeBBoxes([beforeBox, afterBox]));
        this.onSelectionChange(this.gizmo);
      },
      { capture: true }
    );

    this.viewportEl.addEventListener(
      "pointerup",
      (e) => {
        if (!this.gizmo.active || !this.gizmo.dragMode) return;
        e.stopPropagation();
        this.gizmo.dragMode = null;
        const pd = this.pagesData.get(this.gizmo.pageIndex);
        if (pd) {
          const cmd = new TransformStrokesCommand(pd, [...this.gizmo.strokes], this.gizmo.accumMatrix);
          this.history.push(cmd, true);
          this.onDirtyPage(this.gizmo.pageIndex);
        }
      },
      { capture: true }
    );

    // S Pen ve Fare Çizim Olayları
    this.viewportEl.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      if (e.button !== 0 && e.button !== 5) return;

      const pt = this._clientToPageCoords(e.clientX, e.clientY);
      this.activePageIndex = pt.pageIndex;

      if (this.tool === "textselect") return;
      if (this.tool === "text") {
        this.onTextBoxRequest(pt);
        return;
      }
      if (this.tool === "image") {
        this.onImageRequest(pt);
        return;
      }

      if (e.buttons === 32 || e.button === 5) {
        if (!this.prevToolBeforeSideBtn) this.prevToolBeforeSideBtn = this.tool;
        this.tool = "eraser";
      }

      if (this.gizmo.active && this.tool !== "lasso") {
        this.gizmo.clear();
        this.onSelectionChange(null);
      }

      this.penDown = true;
      this.isDrawing = true;
      this.snappedShapePoints = null;
      this.viewportEl.setPointerCapture(e.pointerId);

      const pressure = e.pressure > 0 ? e.pressure : 0.5;
      this.rawPoints = [{ x: pt.x, y: pt.y, p: pressure, t: performance.now() }];

      if (this.tool === "lasso") {
        this.lassoPoints = [{ x: pt.x, y: pt.y }];
      } else if (this.tool === "eraser") {
        this._performEraseAt(pt.pageIndex, pt.x, pt.y);
      } else if (this.tool === "laser") {
        this.laserTrails.push({ pageIndex: pt.pageIndex, points: [{ x: pt.x, y: pt.y, t: performance.now() }] });
      } else {
        this._resetHoldToSnapTimer();
      }
    });

    this.viewportEl.addEventListener("pointermove", (e) => {
      if (!this.isDrawing || e.pointerType === "touch") return;

      if ((e.buttons & 32) === 32 && this.tool !== "eraser") {
        if (!this.prevToolBeforeSideBtn) this.prevToolBeforeSideBtn = this.tool;
        this.tool = "eraser";
      } else if ((e.buttons & 32) === 0 && this.prevToolBeforeSideBtn) {
        this.tool = this.prevToolBeforeSideBtn;
        this.prevToolBeforeSideBtn = null;
      }

      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
      for (const ce of events) {
        const pt = this._clientToPageCoords(ce.clientX, ce.clientY);
        const pressure = ce.pressure > 0 ? ce.pressure : 0.5;

        if (this.tool === "lasso") {
          this.lassoPoints.push({ x: pt.x, y: pt.y });
          continue;
        }
        if (this.tool === "eraser") {
          this._performEraseAt(pt.pageIndex, pt.x, pt.y);
          continue;
        }
        if (this.tool === "laser") {
          const trail = this.laserTrails[this.laserTrails.length - 1];
          if (trail) trail.points.push({ x: pt.x, y: pt.y, t: performance.now() });
          continue;
        }

        const prev = this.rawPoints[this.rawPoints.length - 1];
        const dist = prev ? Math.hypot(pt.x - prev.x, pt.y - prev.y) : 99;
        if (dist > 6) {
          this.snappedShapePoints = null;
          this._resetHoldToSnapTimer();
        }

        let adjP = pressure;
        if (this.tool === "fountain" && prev) {
          const dt = Math.max(1, performance.now() - prev.t);
          const speed = dist / dt;
          adjP = Math.max(0.25, Math.min(1.2, pressure * (1.15 - Math.min(0.55, speed * 0.25))));
        }

        this.rawPoints.push({ x: pt.x, y: pt.y, p: adjP, t: performance.now() });
      }
    });

    const finishStroke = () => {
      if (!this.isDrawing) return;
      clearTimeout(this.holdTimer);
      this.isDrawing = false;
      this.penDown = false;
      this.lastPenLiftTime = performance.now();

      const pageIndex = this.activePageIndex;
      const pd = this.pagesData.get(pageIndex);

      if (this.tool === "lasso" && pd) {
        this._finalizeLassoSelection(pageIndex, pd);
      } else if (
        pd &&
        this.rawPoints.length >= 1 &&
        !["eraser", "laser", "lasso", "textselect"].includes(this.tool)
      ) {
        const finalPts = this.snappedShapePoints || rdpSimplify(this.rawPoints, 0.3);
        const f32 = new Float32Array(finalPts.length * 3);
        for (let i = 0; i < finalPts.length; i++) {
          f32[i * 3] = finalPts[i].x;
          f32[i * 3 + 1] = finalPts[i].y;
          f32[i * 3 + 2] = finalPts[i].p ?? 0.5;
        }

        const strokeObj = {
          id: `st_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          tool: this.tool,
          color: this.color,
          width: this.size,
          opacity: this.tool === "highlighter" ? 0.36 : 1,
          lineCap: "round",
          points: f32,
          bbox: CollisionEngine.computeBBox(f32, this.size * (this.tool === "highlighter" ? 3 : 1.5)),
          deleted: false
        };

        const cmd = new AddStrokesCommand(pd, [strokeObj]);
        this.history.push(cmd, false);

        // Sınırsız Tuval (Infinite Canvas) Otomatik Alan Genişletmesi
        if (
          this.paperSettings.layout === "infinite" &&
          (strokeObj.bbox.maxX > pd.width - 140 || strokeObj.bbox.maxY > pd.height - 140) &&
          this.onInfiniteExpand
        ) {
          this.onInfiniteExpand(
            pageIndex,
            Math.max(pd.width, Math.ceil(strokeObj.bbox.maxX + 700)),
            Math.max(pd.height, Math.ceil(strokeObj.bbox.maxY + 700))
          );
        } else {
          this.redrawPage(pageIndex, strokeObj.bbox);
        }

        this.lastWrittenLocation = { pageIndex, x: finalPts[0].x, y: finalPts[0].y };
        this.onDirtyPage(pageIndex);
      }

      if (this.prevToolBeforeSideBtn) {
        this.tool = this.prevToolBeforeSideBtn;
        this.prevToolBeforeSideBtn = null;
      }

      this.rawPoints = [];
      this.lassoPoints = [];
      this.snappedShapePoints = null;
    };

    this.viewportEl.addEventListener("pointerup", finishStroke);
    this.viewportEl.addEventListener("pointercancel", finishStroke);
  }

  _resetHoldToSnapTimer() {
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      if (!this.isDrawing || this.rawPoints.length < 4) return;
      this.snappedShapePoints = this._recognizeGeometricShape(this.rawPoints, this.tool);
    }, 500);
  }

  _recognizeGeometricShape(pts, tool) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let totalLen = 0;

    for (let i = 0; i < pts.length; i++) {
      if (pts[i].x < minX) minX = pts[i].x;
      if (pts[i].y < minY) minY = pts[i].y;
      if (pts[i].x > maxX) maxX = pts[i].x;
      if (pts[i].y > maxY) maxY = pts[i].y;
      if (i > 0) totalLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }

    const w = maxX - minX;
    const h = maxY - minY;
    const closeDist = Math.hypot(last.x - first.x, last.y - first.y);
    const p = 0.55;

    if (tool === "highlighter") {
      const yMid = Math.abs(last.y - first.y) < 22 ? (first.y + last.y) * 0.5 : last.y;
      return [{ x: first.x, y: first.y, p }, { x: last.x, y: yMid, p }];
    }

    if (closeDist < Math.max(26, totalLen * 0.18) && w > 18 && h > 18) {
      const simplified = rdpSimplify(pts, Math.max(w, h) * 0.09);
      const corners = simplified.length - 1;
      if (corners === 3) {
        return [
          { x: simplified[0].x, y: simplified[0].y, p },
          { x: simplified[1].x, y: simplified[1].y, p },
          { x: simplified[2].x, y: simplified[2].y, p },
          { x: simplified[0].x, y: simplified[0].y, p }
        ];
      }
      if (corners === 4) {
        return [
          { x: minX, y: minY, p },
          { x: maxX, y: minY, p },
          { x: maxX, y: maxY, p },
          { x: minX, y: maxY, p },
          { x: minX, y: minY, p }
        ];
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const rx = w / 2;
      const ry = h / 2;
      const circle = [];
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        circle.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, p });
      }
      return circle;
    }

    const midIdx = Math.floor(pts.length * 0.5);
    const corner = pts[midIdx];
    const v1x = corner.x - first.x, v1y = corner.y - first.y;
    const v2x = last.x - corner.x, v2y = last.y - corner.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 > 40 && l2 > 40) {
      const dot = Math.abs((v1x * v2x + v1y * v2y) / (l1 * l2));
      if (dot < 0.25 && Math.abs(v1x) < 25 && Math.abs(v2y) < 25) {
        const ox = corner.x, oy = corner.y;
        return [
          { x: ox, y: first.y, p },
          { x: ox - 6, y: first.y + 10, p },
          { x: ox, y: first.y, p },
          { x: ox + 6, y: first.y + 10, p },
          { x: ox, y: first.y, p },
          { x: ox, y: oy, p },
          { x: last.x, y: oy, p },
          { x: last.x - 10, y: oy - 6, p },
          { x: last.x, y: oy, p },
          { x: last.x - 10, y: oy + 6, p }
        ];
      }
    }

    const endSegment = pts.slice(-Math.max(4, Math.floor(pts.length * 0.2)));
    const tip = endSegment[0];
    if (Math.hypot(last.x - tip.x, last.y - tip.y) > 12 && totalLen > closeDist * 1.15) {
      const angle = Math.atan2(tip.y - first.y, tip.x - first.x);
      const headLen = 14;
      return [
        { x: first.x, y: first.y, p },
        { x: tip.x, y: tip.y, p },
        { x: tip.x - headLen * Math.cos(angle - 0.45), y: tip.y - headLen * Math.sin(angle - 0.45), p },
        { x: tip.x, y: tip.y, p },
        { x: tip.x - headLen * Math.cos(angle + 0.45), y: tip.y - headLen * Math.sin(angle + 0.45), p }
      ];
    }

    return [{ x: first.x, y: first.y, p }, { x: last.x, y: last.y, p }];
  }

  _performEraseAt(pageIndex, x, y) {
    const pd = this.pagesData.get(pageIndex);
    if (!pd) return;

    const radius = this.eraserMode === "partial" ? 11 : 14;
    const probeBox = { minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius };
    const removedStrokes = [];
    const addedStrokes = [];

    for (const st of pd.strokes) {
      if (st.deleted) continue;
      if (this.eraserMode === "highlighter-only" && st.tool !== "highlighter") continue;
      if (!CollisionEngine.aabbOverlap(st.bbox, probeBox)) continue;

      if (CollisionEngine.strokeHitsCircle(st, x, y, radius)) {
        removedStrokes.push(st);
        if (this.eraserMode === "partial" && st.points.length >= 9) {
          const fragments = CollisionEngine.splitStrokeByCircle(st, x, y, radius);
          addedStrokes.push(...fragments);
        }
      }
    }

    if (removedStrokes.length > 0) {
      const cmd = new SplitOrEraseCommand(pd, removedStrokes, addedStrokes);
      this.history.push(cmd, false);
      this.redrawPage(pageIndex, cmd.dirtyBBox);
      this.onDirtyPage(pageIndex);
    }
  }

  _finalizeLassoSelection(pageIndex, pd) {
    if (this.lassoPoints.length < 3) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.lassoPoints) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const polyBox = { minX, minY, maxX, maxY };
    const selected = pd.strokes.filter(
      (st) => !st.deleted && CollisionEngine.strokeInsidePolygon(st, this.lassoPoints, polyBox)
    );

    if (selected.length > 0) {
      this.gizmo.setSelection(pageIndex, selected);
      this.onSelectionChange(this.gizmo);
    } else {
      this.gizmo.clear();
      this.onSelectionChange(null);
    }
  }

  _startOverlayLoop() {
    const tick = () => {
      const rect = this.viewportEl.getBoundingClientRect();
      if (this.overlayCanvas.width !== Math.floor(rect.width) || this.overlayCanvas.height !== Math.floor(rect.height)) {
        this.overlayCanvas.width = Math.floor(rect.width);
        this.overlayCanvas.height = Math.floor(rect.height);
      }

      const ctx = this.overlayCtx;
      ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

      const activeWrapper = this.pagesLayerEl.querySelector(`.page-wrapper[data-page-index="${this.activePageIndex}"]`);
      if (activeWrapper) {
        const wr = activeWrapper.getBoundingClientRect();
        const ox = wr.left - rect.left;
        const oy = wr.top - rect.top;

        ctx.save();
        ctx.translate(ox, oy);
        ctx.scale(this.zoom, this.zoom);

        if (this.isDrawing && this.rawPoints.length > 0 && !["eraser", "lasso", "laser"].includes(this.tool)) {
          const previewPts = this.snappedShapePoints || this.rawPoints;
          const f32 = new Float32Array(previewPts.length * 3);
          for (let i = 0; i < previewPts.length; i++) {
            f32[i * 3] = previewPts[i].x;
            f32[i * 3 + 1] = previewPts[i].y;
            f32[i * 3 + 2] = previewPts[i].p ?? 0.5;
          }
          this.drawSingleStroke(ctx, {
            tool: this.tool,
            color: this.color,
            width: this.size,
            opacity: this.tool === "highlighter" ? 0.36 : 1,
            points: f32
          });
        }

        if (this.isDrawing && this.tool === "lasso" && this.lassoPoints.length > 1) {
          ctx.strokeStyle = "#2563eb";
          ctx.lineWidth = 1.6 / this.zoom;
          ctx.setLineDash([5 / this.zoom, 4 / this.zoom]);
          ctx.beginPath();
          ctx.moveTo(this.lassoPoints[0].x, this.lassoPoints[0].y);
          for (let i = 1; i < this.lassoPoints.length; i++) {
            ctx.lineTo(this.lassoPoints[i].x, this.lassoPoints[i].y);
          }
          ctx.closePath();
          ctx.stroke();
          ctx.setLineDash([]);
        }

        ctx.restore();
      }

      const now = performance.now();
      this.laserTrails = this.laserTrails.filter((tr) => {
        tr.points = tr.points.filter((p) => now - p.t < 1500);
        return tr.points.length > 0;
      });
      for (const tr of this.laserTrails) {
        const w = this.pagesLayerEl.querySelector(`.page-wrapper[data-page-index="${tr.pageIndex}"]`);
        if (!w || tr.points.length < 2) continue;
        const wr = w.getBoundingClientRect();
        ctx.save();
        ctx.translate(wr.left - rect.left, wr.top - rect.top);
        ctx.scale(this.zoom, this.zoom);
        for (let i = 1; i < tr.points.length; i++) {
          const age = (now - tr.points[i].t) / 1500;
          ctx.strokeStyle = `rgba(239, 68, 68, ${Math.max(0, 1 - age)})`;
          ctx.lineWidth = 5 * (1 - age * 0.5);
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(tr.points[i - 1].x, tr.points[i - 1].y);
          ctx.lineTo(tr.points[i].x, tr.points[i].y);
          ctx.stroke();
        }
        ctx.restore();
      }

      if (this.gizmo.active) {
        const gw = this.pagesLayerEl.querySelector(`.page-wrapper[data-page-index="${this.gizmo.pageIndex}"]`);
        if (gw) {
          const wr = gw.getBoundingClientRect();
          ctx.save();
          ctx.translate(wr.left - rect.left, wr.top - rect.top);
          ctx.scale(this.zoom, this.zoom);
          this.gizmo.draw(ctx, this.zoom);
          ctx.restore();
        }
      }

      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  applyWorldTransform() {
    this.worldEl.style.transform = `translate3d(${this.panX}px, ${this.panY}px, 0) scale(${this.zoom})`;
    this.updateMinimap();
  }

  updateMinimap() {
    const pd = this.pagesData.get(this.activePageIndex);
    if (!pd) return;
    const mw = this.minimapCanvas.width;
    const mh = this.minimapCanvas.height;
    const ctx = this.minimapCtx;
    ctx.clearRect(0, 0, mw, mh);

    const scale = Math.min(mw / pd.width, mh / pd.height);
    const ox = (mw - pd.width * scale) / 2;
    const oy = (mh - pd.height * scale) / 2;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(ox, oy, pd.width * scale, pd.height * scale);

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = 2 / scale;
    for (const st of pd.strokes || []) {
      if (st.deleted || !st.bbox) continue;
      ctx.strokeRect(st.bbox.minX, st.bbox.minY, st.bbox.maxX - st.bbox.minX, st.bbox.maxY - st.bbox.minY);
    }
    ctx.restore();

    const wEl = this.pagesLayerEl.querySelector(`.page-wrapper[data-page-index="${this.activePageIndex}"]`);
    if (wEl) {
      const vr = this.viewportEl.getBoundingClientRect();
      const wr = wEl.getBoundingClientRect();
      const vx = ((vr.left - wr.left) / this.zoom) * scale + ox;
      const vy = ((vr.top - wr.top) / this.zoom) * scale + oy;
      const vw = (vr.width / this.zoom) * scale;
      const vh = (vr.height / this.zoom) * scale;
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(vx, vy, vw, vh);
    }
  }
}
