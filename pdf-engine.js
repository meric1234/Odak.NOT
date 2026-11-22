// Virtual Scrolling PDF Motoru, Arka Plan Thumbnail Üretici, İçindekiler ve Hızlı Arama

export class VirtualPDFEngine {
  constructor({ viewportEl, pagesLayerEl, onPageMount, onPageUnmount }) {
    this.viewportEl = viewportEl;
    this.pagesLayerEl = pagesLayerEl;
    this.onPageMount = onPageMount;
    this.onPageUnmount = onPageUnmount;

    this.pdfDoc = null;
    this.pdfHash = null;
    this.pageCount = 0;
    this.pageMetrics = [];
    this.mountedPages = new Map();
    this.observer = null;
    this.currentZoom = 1;
    this.zoomDebounceTimer = null;
  }

  async loadDocument(pdfBlob, pdfHash, fallbackPageCount = 1, defaultDims = { width: 794, height: 1123 }) {
    this.destroy();
    this.pdfHash = pdfHash || null;
    this.pageMetrics = [];

    if (pdfBlob && window.pdfjsLib) {
      const buf = await pdfBlob.arrayBuffer();
      this.pdfDoc = await window.pdfjsLib.getDocument({ data: buf }).promise;
      this.pageCount = this.pdfDoc.numPages;

      for (let i = 1; i <= this.pageCount; i++) {
        const page = await this.pdfDoc.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        this.pageMetrics.push({ width: Math.round(vp.width), height: Math.round(vp.height) });
      }
    } else {
      this.pdfDoc = null;
      this.pageCount = fallbackPageCount;
      for (let i = 0; i < this.pageCount; i++) {
        this.pageMetrics.push({ ...defaultDims });
      }
    }

    this._buildPlaceholders();
    this._setupIntersectionObserver();
  }

  appendBlankPage(dims = { width: 794, height: 1123 }) {
    const idx = this.pageCount;
    this.pageCount++;
    this.pageMetrics.push({ ...dims });
    const div = this._createPlaceholderElement(idx, dims.width, dims.height);
    this.pagesLayerEl.appendChild(div);
    if (this.observer) this.observer.observe(div);
    return idx;
  }

  updatePageDimension(pageIndex, dims) {
    if (this.pageMetrics[pageIndex]) {
      this.pageMetrics[pageIndex] = { ...dims };
    }
    const wrapper = this.pagesLayerEl.querySelector(`.page-wrapper[data-page-index="${pageIndex}"]`);
    if (wrapper) {
      wrapper.style.width = `${dims.width}px`;
      wrapper.style.height = `${dims.height}px`;
    }
  }

  updateAllPageDimensions(dims) {
    this.pageMetrics = this.pageMetrics.map(() => ({ ...dims }));
    const wrappers = this.pagesLayerEl.querySelectorAll(".page-wrapper");
    wrappers.forEach((w) => {
      w.style.width = `${dims.width}px`;
      w.style.height = `${dims.height}px`;
    });
  }

  _buildPlaceholders() {
    this.pagesLayerEl.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (let i = 0; i < this.pageCount; i++) {
      const m = this.pageMetrics[i];
      frag.appendChild(this._createPlaceholderElement(i, m.width, m.height));
    }
    this.pagesLayerEl.appendChild(frag);
  }

  _createPlaceholderElement(pageIndex, width, height) {
    const wrapper = document.createElement("div");
    wrapper.className = "page-wrapper";
    wrapper.dataset.pageIndex = String(pageIndex);
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;
    return wrapper;
  }

  _setupIntersectionObserver() {
    if (this.observer) this.observer.disconnect();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const idx = Number(entry.target.dataset.pageIndex);
          if (entry.isIntersecting) {
            this._mountPage(idx, entry.target);
          } else {
            this._unmountPage(idx);
          }
        }
      },
      {
        root: this.viewportEl,
        rootMargin: "120% 0px"
      }
    );

    const wrappers = this.pagesLayerEl.querySelectorAll(".page-wrapper");
    wrappers.forEach((el) => this.observer.observe(el));
  }

  async _mountPage(pageIndex, wrapper) {
    if (this.mountedPages.has(pageIndex)) return;

    const m = this.pageMetrics[pageIndex];
    const paperCanvas = document.createElement("canvas");
    paperCanvas.className = "paper-canvas";

    const pdfCanvas = document.createElement("canvas");
    pdfCanvas.className = "pdf-canvas";

    const textLayer = document.createElement("div");
    textLayer.className = "pdf-text-layer";

    const strokeCanvas = document.createElement("canvas");
    strokeCanvas.className = "stroke-canvas";

    const highlightLayer = document.createElement("div");
    highlightLayer.className = "search-highlight-layer";

    const stickyLayer = document.createElement("div");
    stickyLayer.className = "sticky-layer";

    wrapper.append(paperCanvas, pdfCanvas, textLayer, strokeCanvas, highlightLayer, stickyLayer);

    const slot = {
      pageIndex,
      wrapper,
      paperCanvas,
      pdfCanvas,
      textLayer,
      strokeCanvas,
      highlightLayer,
      stickyLayer,
      renderTask: null,
      renderedScale: 0
    };
    this.mountedPages.set(pageIndex, slot);

    if (this.pdfDoc) {
      await this._renderPdfPageHiDPI(slot, this.currentZoom);
    }

    if (this.onPageMount) {
      await this.onPageMount(pageIndex, slot, m);
    }
  }

  _unmountPage(pageIndex) {
    const slot = this.mountedPages.get(pageIndex);
    if (!slot) return;

    if (slot.renderTask) {
      try {
        slot.renderTask.cancel();
      } catch (_) {}
      slot.renderTask = null;
    }

    slot.pdfCanvas.width = 0;
    slot.pdfCanvas.height = 0;
    slot.paperCanvas.width = 0;
    slot.paperCanvas.height = 0;
    slot.strokeCanvas.width = 0;
    slot.strokeCanvas.height = 0;

    slot.wrapper.innerHTML = "";
    this.mountedPages.delete(pageIndex);

    if (this.onPageUnmount) {
      this.onPageUnmount(pageIndex);
    }
  }

  async _renderPdfPageHiDPI(slot, zoom) {
    if (!this.pdfDoc) return;
    if (slot.renderTask) {
      try {
        slot.renderTask.cancel();
      } catch (_) {}
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const targetScale = Math.min(3.5, Math.max(1.25, zoom * dpr));
    if (Math.abs(slot.renderedScale - targetScale) < 0.08 && slot.pdfCanvas.width > 0) return;

    const page = await this.pdfDoc.getPage(slot.pageIndex + 1);
    const vp = page.getViewport({ scale: targetScale });
    const cssVp = page.getViewport({ scale: 1 });

    slot.pdfCanvas.width = Math.floor(vp.width);
    slot.pdfCanvas.height = Math.floor(vp.height);
    const ctx = slot.pdfCanvas.getContext("2d", { alpha: false });

    const task = page.render({ canvasContext: ctx, viewport: vp });
    slot.renderTask = task;

    try {
      await task.promise;
      slot.renderedScale = targetScale;

      slot.textLayer.innerHTML = "";
      slot.textLayer.style.setProperty("--scale-factor", "1");
      const textContent = await page.getTextContent();
      if (window.pdfjsLib && window.pdfjsLib.renderTextLayer) {
        await window.pdfjsLib.renderTextLayer({
          textContentSource: textContent,
          container: slot.textLayer,
          viewport: cssVp,
          textDivs: []
        }).promise;
      }
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") {
        console.warn("PDF sayfa çizim uyarısı:", err);
      }
    } finally {
      if (slot.renderTask === task) slot.renderTask = null;
    }
  }

  scheduleHiDPIRefresh(zoom) {
    this.currentZoom = zoom;
    clearTimeout(this.zoomDebounceTimer);
    this.zoomDebounceTimer = setTimeout(() => {
      for (const slot of this.mountedPages.values()) {
        this._renderPdfPageHiDPI(slot, this.currentZoom);
      }
    }, 180);
  }

  async renderPdfRegionToContext(pageIndex, cropRect, targetCtx, scale = 2.5) {
    if (!this.pdfDoc) return;
    const page = await this.pdfDoc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale });
    const temp = document.createElement("canvas");
    temp.width = Math.ceil(vp.width);
    temp.height = Math.ceil(vp.height);
    const tCtx = temp.getContext("2d", { alpha: false });
    await page.render({ canvasContext: tCtx, viewport: vp }).promise;

    targetCtx.drawImage(
      temp,
      cropRect.x * scale,
      cropRect.y * scale,
      cropRect.w * scale,
      cropRect.h * scale,
      0,
      0,
      cropRect.w * scale,
      cropRect.h * scale
    );
    temp.width = 0;
    temp.height = 0;
  }

  highlightSearchMatches(pageIndex, boxes) {
    const slot = this.mountedPages.get(pageIndex);
    if (!slot) return;
    slot.highlightLayer.innerHTML = "";
    for (const b of boxes) {
      const div = document.createElement("div");
      div.className = "search-hit-box";
      div.style.left = `${b.x}px`;
      div.style.top = `${b.y}px`;
      div.style.width = `${b.w}px`;
      div.style.height = `${b.h}px`;
      slot.highlightLayer.appendChild(div);
    }
  }

  destroy() {
    clearTimeout(this.zoomDebounceTimer);
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    for (const idx of Array.from(this.mountedPages.keys())) {
      this._unmountPage(idx);
    }
    this.pagesLayerEl.innerHTML = "";
  }
}

// Arka Plan Thumbnail Üretici (Ortak 160px Offscreen Tuval + S Pen Öncelikli)
export class ThumbnailGenerator {
  constructor({ storage, listEl, isPenActive, getPageData, drawStrokesFn, drawPaperFn, onSelectPage }) {
    this.storage = storage;
    this.listEl = listEl;
    this.isPenActive = isPenActive;
    this.getPageData = getPageData;
    this.drawStrokesFn = drawStrokesFn;
    this.drawPaperFn = drawPaperFn;
    this.onSelectPage = onSelectPage;

    this.offscreen = document.createElement("canvas");
    this.offscreen.width = 160;
    this.offscreen.height = 226;
    this.ctx = this.offscreen.getContext("2d");

    this.queue = [];
    this.processing = false;
    this.observer = null;
    this.notebookId = null;
    this.pdfDoc = null;
  }

  setup(notebookId, pageCount, pdfDoc, activePageIndex = 0) {
    this.notebookId = notebookId;
    this.pdfDoc = pdfDoc;
    this.queue = [];
    this.listEl.innerHTML = "";

    if (this.observer) this.observer.disconnect();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const idx = Number(e.target.dataset.pageIndex);
            this.enqueue(idx, true);
          }
        }
      },
      { root: this.listEl, rootMargin: "100px" }
    );

    for (let i = 0; i < pageCount; i++) {
      const card = document.createElement("div");
      card.className = "thumb-card" + (i === activePageIndex ? " active" : "");
      card.dataset.pageIndex = String(i);
      card.innerHTML = `<img alt="Sayfa ${i + 1}" /><div class="thumb-label">Sayfa ${i + 1}</div>`;
      card.addEventListener("click", () => this.onSelectPage(i));
      this.listEl.appendChild(card);
      this.observer.observe(card);
    }
  }

  setActiveCard(pageIndex) {
    this.listEl.querySelectorAll(".thumb-card").forEach((el) => {
      el.classList.toggle("active", Number(el.dataset.pageIndex) === pageIndex);
    });
  }

  enqueue(pageIndex, front = false) {
    this.queue = this.queue.filter((x) => x !== pageIndex);
    if (front) this.queue.unshift(pageIndex);
    else this.queue.push(pageIndex);
    this._schedule();
  }

  _schedule() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const run = async () => {
      if (this.isPenActive()) {
        this.processing = false;
        setTimeout(() => this._schedule(), 250);
        return;
      }
      const idx = this.queue.shift();
      if (idx !== undefined) {
        await this._renderOne(idx);
      }
      this.processing = false;
      if (this.queue.length > 0) this._schedule();
    };

    if ("requestIdleCallback" in window) {
      requestIdleCallback(() => run(), { timeout: 600 });
    } else {
      setTimeout(run, 60);
    }
  }

  async _renderOne(pageIndex, forceRegen = false) {
    const card = this.listEl.querySelector(`.thumb-card[data-page-index="${pageIndex}"]`);
    if (!card) return;
    const img = card.querySelector("img");

    if (!forceRegen) {
      const cached = await this.storage.getThumbnail(this.notebookId, pageIndex);
      if (cached) {
        img.src = URL.createObjectURL(cached);
        return;
      }
    }

    const pageData = await this.getPageData(pageIndex);
    const w = pageData?.width || 794;
    const h = pageData?.height || 1123;
    const scale = 160 / w;
    this.offscreen.width = 160;
    this.offscreen.height = Math.round(h * scale);

    this.ctx.clearRect(0, 0, this.offscreen.width, this.offscreen.height);
    if (this.pdfDoc) {
      const page = await this.pdfDoc.getPage(pageIndex + 1);
      const vp = page.getViewport({ scale });
      await page.render({ canvasContext: this.ctx, viewport: vp }).promise;
    } else if (this.drawPaperFn) {
      this.drawPaperFn(this.ctx, this.offscreen.width, this.offscreen.height, scale);
    }

    if (pageData && pageData.strokes && this.drawStrokesFn) {
      this.ctx.save();
      this.ctx.scale(scale, scale);
      this.drawStrokesFn(this.ctx, pageData.strokes);
      this.ctx.restore();
    }

    const blob = await new Promise((res) => this.offscreen.toBlob(res, "image/jpeg", 0.78));
    if (blob) {
      await this.storage.saveThumbnail(this.notebookId, pageIndex, blob);
      img.src = URL.createObjectURL(blob);
    }
  }

  invalidate(pageIndex) {
    this._renderOne(pageIndex, true);
  }
}

// PDF İçindekiler (Tembel Çözümleme) ve 5'erli Paketler Halinde Metin Arama
export class PDFOutlineAndSearch {
  constructor({ storage, outlineEl, resultsEl, statusEl, isPenActive, onJumpToPage }) {
    this.storage = storage;
    this.outlineEl = outlineEl;
    this.resultsEl = resultsEl;
    this.statusEl = statusEl;
    this.isPenActive = isPenActive;
    this.onJumpToPage = onJumpToPage;

    this.pdfDoc = null;
    this.pdfHash = null;
  }

  async loadOutline(pdfDoc, pdfHash) {
    this.pdfDoc = pdfDoc;
    this.pdfHash = pdfHash;
    this.resultsEl.innerHTML = "";
    this.statusEl.textContent = pdfDoc ? "Arama hazır" : "PDF yüklü değil";

    if (!pdfDoc) {
      this.outlineEl.innerHTML = `<p class="muted-empty">Açık PDF belgesinde içindekiler tablosu bulunmuyor.</p>`;
      return;
    }

    const outline = await pdfDoc.getOutline();
    if (!outline || outline.length === 0) {
      this.outlineEl.innerHTML = `<p class="muted-empty">Bu PDF belgesinde gömülü içindekiler ağacı yok.</p>`;
      return;
    }

    this.outlineEl.innerHTML = "";
    const renderItems = (items, depth = 0) => {
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "outline-item";
        row.style.paddingLeft = `${8 + depth * 14}px`;
        row.innerHTML = `<span>${item.title}</span><span class="outline-pg">→</span>`;
        row.addEventListener("click", async () => {
          const pageIdx = await this._resolveDestinationPage(item.dest);
          if (pageIdx !== null) {
            row.querySelector(".outline-pg").textContent = `S.${pageIdx + 1}`;
            this.onJumpToPage(pageIdx, []);
          }
        });
        this.outlineEl.appendChild(row);
        if (item.items && item.items.length > 0) {
          renderItems(item.items, depth + 1);
        }
      }
    };
    renderItems(outline);
  }

  async _resolveDestinationPage(dest) {
    if (!this.pdfDoc || !dest) return null;
    try {
      const explicitDest = typeof dest === "string" ? await this.pdfDoc.getDestination(dest) : dest;
      if (!explicitDest || !explicitDest[0]) return null;
      const pageIndex = await this.pdfDoc.getPageIndex(explicitDest[0]);
      return pageIndex;
    } catch (_) {
      return null;
    }
  }

  async ensurePageIndexed(pageIndex) {
    if (!this.pdfDoc) return [];
    if (this.pdfHash) {
      const cached = await this.storage.getPdfPageText(this.pdfHash, pageIndex);
      if (cached) return cached;
    }

    const page = await this.pdfDoc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.map((it) => {
      const tx = window.pdfjsLib.Util.transform(vp.transform, it.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]) || 12;
      return {
        str: it.str,
        x: tx[4],
        y: tx[5] - fontHeight,
        w: it.width || it.str.length * (fontHeight * 0.5),
        h: fontHeight * 1.2
      };
    });
    if (this.pdfHash) {
      await this.storage.savePdfPageText(this.pdfHash, pageIndex, items);
    }
    return items;
  }

  async search(query) {
    const q = query.trim().toLowerCase();
    this.resultsEl.innerHTML = "";
    if (!q || !this.pdfDoc) {
      this.statusEl.textContent = "Arama hazır";
      return;
    }

    const total = this.pdfDoc.numPages;
    let totalHits = 0;

    for (let start = 0; start < total; start += 5) {
      while (this.isPenActive()) {
        await new Promise((r) => setTimeout(r, 120));
      }

      const end = Math.min(total, start + 5);
      this.statusEl.textContent = `Taranıyor: ${end} / ${total} sayfa (${totalHits} eşleşme)`;

      for (let p = start; p < end; p++) {
        const items = await this.ensurePageIndexed(p);
        const pageBoxes = [];
        let snippet = "";

        for (const it of items) {
          if (it.str && it.str.toLowerCase().includes(q)) {
            pageBoxes.push({ x: it.x, y: it.y, w: it.w, h: it.h });
            if (!snippet) snippet = it.str;
          }
        }

        if (pageBoxes.length > 0) {
          totalHits += pageBoxes.length;
          const div = document.createElement("div");
          div.className = "search-result-item";
          const safeSnippet = snippet.replace(/</g, "&lt;");
          div.innerHTML = `<strong>Sayfa ${p + 1}</strong> (${pageBoxes.length} eşleşme)<br/><span>${safeSnippet}</span>`;
          div.addEventListener("click", () => this.onJumpToPage(p, pageBoxes));
          this.resultsEl.appendChild(div);
        }
      }

      await new Promise((r) => setTimeout(r, 0));
    }

    this.statusEl.textContent = `Tamamlandı: ${totalHits} eşleşme bulundu`;
  }
}
