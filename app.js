// Odak Not Ana Uygulama Orkestratörü

import { StorageManager } from "./storage.js";
import { VirtualPDFEngine, ThumbnailGenerator, PDFOutlineAndSearch } from "./pdf-engine.js";
import { CanvasEngine, TouchGestureRecognizer, AddStrokesCommand, CollisionEngine } from "./canvas-tools.js";
import {
  GeminiAssistant,
  StickyCardManager,
  StudyGuideBuilder,
  cropSelectionHiDPI,
  exportFlattenedPDF,
  formatBasicMarkdown,
  renderMathInElementSafe
} from "./ai-study.js";

function formatRelativeTime(timestamp) {
  if (!timestamp) return "Bugün";
  const diffDays = Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "Bugün";
  if (diffDays === 1) return "Dün";
  return `${diffDays} gün önce`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 MB";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Aynı Satırdaki Çakışan Metin Vurgu Dikdörtgenlerini Birleştir
function mergeSameLineWorldRects(rects) {
  if (!rects || rects.length === 0) return [];
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = sorted[i];
    if (Math.abs(prev.y - cur.y) < 8 && cur.x <= prev.x + prev.w + 10) {
      const right = Math.max(prev.x + prev.w, cur.x + cur.w);
      prev.x = Math.min(prev.x, cur.x);
      prev.w = right - prev.x;
      prev.h = Math.max(prev.h, cur.h);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

class OdakNotApp {
  constructor() {
    this.storage = new StorageManager();
    this.notebooks = [];
    this.subjects = ["Genel", "Matematik", "Fizik"];
    this.activeNotebook = null;
    this.saveTimers = new Map();
    this.pendingTextInsertPt = null;
    this.pendingImageInsertPt = null;

    // Odak Sayacı Durumu
    this.timerMinutes = 25;
    this.timerSecondsLeft = 25 * 60;
    this.timerInterval = null;
  }

  async init() {
    await this.storage.init();
    this._initEngines();
    this._bindUIEvents();
    await this._refreshQuota();

    this.notebooks = await this.storage.listNotebooks();
    if (this.notebooks.length === 0) {
      const starter = await this.storage.saveNotebook({
        id: `nb_${Date.now()}`,
        title: "Diferansiyel Denklemler — Hafta 1",
        subject: "Matematik",
        pageCount: 2,
        pdfHash: null,
        paperSettings: { template: "ruled-medium", theme: "cream", layout: "a4-portrait" },
        updatedAt: Date.now()
      });
      this.notebooks = [starter];
    }

    this._renderNotebookTree();
    await this.openNotebook(this.notebooks[0].id);
  }

  _initEngines() {
    const viewportEl = document.getElementById("viewport");
    const worldEl = document.getElementById("worldContainer");
    const pagesLayerEl = document.getElementById("pagesLayer");

    this.canvasEngine = new CanvasEngine({
      viewportEl,
      worldEl,
      pagesLayerEl,
      overlayCanvas: document.getElementById("overlayCanvas"),
      minimapCanvas: document.getElementById("minimapCanvas"),
      onDirtyPage: (pageIndex) => this.schedulePageSave(pageIndex),
      onSelectionChange: (gizmo) => this._updateGizmoBar(gizmo),
      onTextBoxRequest: (pt) => {
        this.pendingTextInsertPt = pt;
        document.getElementById("textBoxInput").value = "";
        document.getElementById("textBoxModal").classList.remove("hidden");
      },
      onImageRequest: (pt) => {
        this.pendingImageInsertPt = pt;
        document.getElementById("imageInsertInput").click();
      },
      onLaserActivity: () => {}
    });

    this.stickyManager = new StickyCardManager({
      canvasEngine: this.canvasEngine,
      onDirtyPage: (pageIndex) => this.schedulePageSave(pageIndex)
    });

    this.pdfEngine = new VirtualPDFEngine({
      viewportEl,
      pagesLayerEl,
      onPageMount: async (pageIndex, slot, metrics) => {
        let pd = this.canvasEngine.pagesData.get(pageIndex);
        if (!pd) {
          pd = (await this.storage.loadPage(this.activeNotebook.id, pageIndex)) || {
            width: metrics.width,
            height: metrics.height,
            strokes: [],
            texts: [],
            images: [],
            stickyCards: []
          };
        }
        this.canvasEngine.registerMountedPage(pageIndex, slot, pd);
        this.stickyManager.renderPageCards(pageIndex);
      },
      onPageUnmount: (pageIndex) => {
        this.canvasEngine.unregisterMountedPage(pageIndex);
      }
    });

    this.thumbGen = new ThumbnailGenerator({
      storage: this.storage,
      listEl: document.getElementById("thumbnailList"),
      isPenActive: () => this.canvasEngine.penDown,
      getPageData: async (idx) =>
        this.canvasEngine.pagesData.get(idx) || (await this.storage.loadPage(this.activeNotebook.id, idx)),
      drawStrokesFn: (ctx, strokes) => this.canvasEngine.drawStrokesList(ctx, strokes),
      drawPaperFn: (ctx, w, h, sc) => this.canvasEngine.drawPaper(ctx, w, h, sc, false),
      onSelectPage: (idx) => this.jumpToPage(idx)
    });

    this.outlineAndSearch = new PDFOutlineAndSearch({
      storage: this.storage,
      outlineEl: document.getElementById("outlineTree"),
      resultsEl: document.getElementById("pdfSearchResults"),
      statusEl: document.getElementById("pdfSearchStatus"),
      isPenActive: () => this.canvasEngine.penDown,
      onJumpToPage: (pageIdx, boxes) => {
        this.jumpToPage(pageIdx);
        setTimeout(() => this.pdfEngine.highlightSearchMatches(pageIdx, boxes), 120);
      }
    });

    this.gemini = new GeminiAssistant({
      messagesEl: document.getElementById("aiChatMessages"),
      inputEl: document.getElementById("aiPromptInput"),
      sendBtn: document.getElementById("btnSendAi"),
      keyInput: document.getElementById("geminiApiKeyInput"),
      saveKeyBtn: document.getElementById("btnSaveApiKey"),
      keyStatus: document.getElementById("apiKeyStatus"),
      attachmentPreview: document.getElementById("aiAttachmentPreview"),
      attachmentImg: document.getElementById("aiAttachmentImg"),
      clearAttachmentBtn: document.getElementById("btnClearAttachment"),
      onPinToCanvas: (text, anchorCrop) => {
        const pageIndex = anchorCrop ? anchorCrop.pageIndex : this.canvasEngine.activePageIndex;
        const x = anchorCrop ? anchorCrop.anchorX : 120;
        const y = anchorCrop ? anchorCrop.anchorY : 120;
        this.stickyManager.addCard(pageIndex, { x, y, content: text });
      }
    });

    this.studyGuide = new StudyGuideBuilder({
      outlineAndSearch: this.outlineAndSearch,
      getAllPages: async () => {
        const count = this.activeNotebook?.pageCount || 1;
        const arr = [];
        for (let i = 0; i < count; i++) {
          arr.push(
            this.canvasEngine.pagesData.get(i) || (await this.storage.loadPage(this.activeNotebook.id, i))
          );
        }
        return arr;
      },
      onJumpToLocation: (pageIdx, x, y) => {
        document.getElementById("studyGuideModal").classList.add("hidden");
        this.jumpToPage(pageIdx, x, y);
      },
      onInsertSummaryPage: async (mdText) => {
        const newIdx = await this.addNewPageToNotebook();
        const pd = this.canvasEngine.pagesData.get(newIdx);
        if (pd) {
          pd.texts.push({ x: 48, y: 48, size: 15, color: "#0f172a", text: "ÇALIŞMA ÖZETİ\n\n" + mdText });
          this.canvasEngine.redrawPage(newIdx);
          this.schedulePageSave(newIdx);
        }
        document.getElementById("studyGuideModal").classList.add("hidden");
        this.jumpToPage(newIdx);
      },
      onGenerateQuizWithAi: (mdText) => {
        document.getElementById("studyGuideModal").classList.add("hidden");
        document.getElementById("aiPanel").classList.remove("collapsed");
        this.gemini.sendPrompt(
          "Aşağıdaki çalışma özeti ve vurgulara dayanarak 3 adet çoktan seçmeli ve 2 adet açık uçlu sınav sorusu ile çözümlerini hazırla:\n\n" +
            mdText
        );
      }
    });

    // Çakışmasız Dokunmatik Jest Durum Makinesi
    new TouchGestureRecognizer({
      element: viewportEl,
      isPenBlocked: () => this.canvasEngine.isPenBlocked(),
      onTransform: ({ dx, dy, scaleRatio, centerX, centerY }) => {
        const vr = viewportEl.getBoundingClientRect();
        const lx = centerX - vr.left;
        const ly = centerY - vr.top;
        const nextZoom = Math.max(0.35, Math.min(4.0, this.canvasEngine.zoom * scaleRatio));
        const actualRatio = nextZoom / this.canvasEngine.zoom;

        this.canvasEngine.panX = lx - (lx - this.canvasEngine.panX) * actualRatio + dx;
        this.canvasEngine.panY = ly - (ly - this.canvasEngine.panY) * actualRatio + dy;
        this.canvasEngine.zoom = nextZoom;
        this.canvasEngine.applyWorldTransform();
        document.getElementById("zoomBadge").textContent = `%${Math.round(nextZoom * 100)}`;
      },
      onTransformEnd: () => {
        this.pdfEngine.scheduleHiDPIRefresh(this.canvasEngine.zoom);
      },
      onUndo: () => this._triggerUndo(),
      onRedo: () => this._triggerRedo()
    });
  }

  async openNotebook(notebookId) {
    const nb = this.notebooks.find((n) => n.id === notebookId);
    if (!nb) return;
    this.activeNotebook = nb;
    this.canvasEngine.pagesData.clear();
    this.canvasEngine.gizmo.clear();
    this._updateGizmoBar(null);

    document.getElementById("notebookTitleInput").value = nb.title;
    if (nb.paperSettings) {
      this.canvasEngine.setPaperSettings(nb.paperSettings);
      document.getElementById("paperTemplateSelect").value = nb.paperSettings.template;
      document.getElementById("paperThemeSelect").value = nb.paperSettings.theme;
      document.getElementById("paperLayoutSelect").value = nb.paperSettings.layout;
    }

    const pdfBlob = nb.pdfHash ? await this.storage.getPdfBlob(nb.pdfHash) : null;
    const defaultDims = this.canvasEngine.getLayoutDimensions();
    await this.pdfEngine.loadDocument(pdfBlob, nb.pdfHash, nb.pageCount || 1, defaultDims);

    this.canvasEngine.panX = 24;
    this.canvasEngine.panY = 24;
    this.canvasEngine.zoom = 1;
    this.canvasEngine.applyWorldTransform();
    document.getElementById("zoomBadge").textContent = "%100";

    this.thumbGen.setup(nb.id, this.pdfEngine.pageCount, this.pdfEngine.pdfDoc, 0);
    await this.outlineAndSearch.loadOutline(this.pdfEngine.pdfDoc, nb.pdfHash);
    this._renderNotebookTree();
  }

  schedulePageSave(pageIndex) {
    const statusEl = document.getElementById("saveStatus");
    statusEl.textContent = "● Kaydediliyor...";
    statusEl.className = "save-status saving";

    clearTimeout(this.saveTimers.get(pageIndex));
    const timer = setTimeout(async () => {
      const pd = this.canvasEngine.pagesData.get(pageIndex);
      if (pd && this.activeNotebook) {
        await this.storage.savePage(this.activeNotebook.id, pageIndex, pd);
        await this.storage.saveNotebook(this.activeNotebook);
        this.thumbGen.invalidate(pageIndex);
      }
      statusEl.textContent = "● Kaydedildi";
      statusEl.className = "save-status saved";
      this._refreshQuota();
    }, 450);
    this.saveTimers.set(pageIndex, timer);
  }

  async addNewPageToNotebook() {
    if (!this.activeNotebook) return 0;
    const dims = this.canvasEngine.getLayoutDimensions();
    const idx = this.pdfEngine.appendBlankPage(dims);
    this.activeNotebook.pageCount = this.pdfEngine.pageCount;
    await this.storage.saveNotebook(this.activeNotebook);
    this.thumbGen.setup(this.activeNotebook.id, this.pdfEngine.pageCount, this.pdfEngine.pdfDoc, idx);
    return idx;
  }

  jumpToPage(pageIndex, worldX = 0, worldY = 0) {
    const wrapper = document.querySelector(`.page-wrapper[data-page-index="${pageIndex}"]`);
    if (!wrapper) return;
    this.canvasEngine.activePageIndex = pageIndex;
    this.thumbGen.setActiveCard(pageIndex);

    const topOffset = wrapper.offsetTop + worldY;
    const leftOffset = wrapper.offsetLeft + worldX;
    this.canvasEngine.panY = -(topOffset * this.canvasEngine.zoom) + 80;
    if (worldX > 0) {
      this.canvasEngine.panX = -(leftOffset * this.canvasEngine.zoom) + 120;
    }
    this.canvasEngine.applyWorldTransform();
  }

  _triggerUndo() {
    const cmd = this.canvasEngine.history.undo();
    if (!cmd) return;
    const idx = this.canvasEngine.activePageIndex;
    this.canvasEngine.redrawPage(idx, cmd.dirtyBBox);
    this.schedulePageSave(idx);
  }

  _triggerRedo() {
    const cmd = this.canvasEngine.history.redo();
    if (!cmd) return;
    const idx = this.canvasEngine.activePageIndex;
    this.canvasEngine.redrawPage(idx, cmd.dirtyBBox);
    this.schedulePageSave(idx);
  }

  _updateGizmoBar(gizmo) {
    const bar = document.getElementById("gizmoBar");
    if (!gizmo || !gizmo.active) {
      bar.classList.add("hidden");
      return;
    }
    const gw = document.querySelector(`.page-wrapper[data-page-index="${gizmo.pageIndex}"]`);
    const vr = document.getElementById("viewport").getBoundingClientRect();
    if (gw) {
      const wr = gw.getBoundingClientRect();
      const sx = wr.left - vr.left + gizmo.cx * this.canvasEngine.zoom;
      const sy = wr.top - vr.top + (gizmo.cy + gizmo.hh) * this.canvasEngine.zoom + 14;
      bar.style.left = `${Math.max(12, sx - 150)}px`;
      bar.style.top = `${Math.min(vr.height - 54, sy)}px`;
    }
    bar.classList.remove("hidden");
  }

  _renderNotebookTree() {
    const tree = document.getElementById("subjectTree");
    tree.innerHTML = "";

    const grouped = new Map();
    for (const s of this.subjects) grouped.set(s, []);
    for (const nb of this.notebooks) {
      const subj = nb.subject || "Genel";
      if (!grouped.has(subj)) grouped.set(subj, []);
      grouped.get(subj).push(nb);
    }

    for (const [subj, list] of grouped.entries()) {
      const groupDiv = document.createElement("div");
      groupDiv.className = "subject-group";
      groupDiv.innerHTML = `<div class="subject-header"><span>📁 ${subj}</span><span>${list.length}</span></div>`;

      for (const nb of list) {
        const item = document.createElement("div");
        item.className = "notebook-item" + (this.activeNotebook?.id === nb.id ? " active" : "");
        item.innerHTML = `
          <div class="nb-title-row">
            <span class="nb-title">${nb.pdfHash ? "📄" : "📓"} ${nb.title}</span>
            <button class="nb-del-btn" title="Defteri Sil">✕</button>
          </div>
          <div class="nb-meta">
            <span>${nb.pageCount || 1} sayfa</span>
            <span>${formatRelativeTime(nb.updatedAt)}</span>
          </div>
        `;
        item.addEventListener("click", (e) => {
          if (e.target.classList.contains("nb-del-btn")) return;
          this.openNotebook(nb.id);
        });
        item.querySelector(".nb-del-btn").addEventListener("click", async (e) => {
          e.stopPropagation();
          if (this.notebooks.length <= 1) return;
          await this.storage.deleteNotebook(nb.id);
          this.notebooks = await this.storage.listNotebooks();
          if (this.activeNotebook?.id === nb.id) {
            await this.openNotebook(this.notebooks[0].id);
          } else {
            this._renderNotebookTree();
          }
        });
        groupDiv.appendChild(item);
      }
      tree.appendChild(groupDiv);
    }
  }

  async _refreshQuota() {
    const info = await this.storage.getQuotaInfo();
    document.getElementById("storageQuotaText").textContent = `${formatBytes(info.usage)} / ${formatBytes(info.quota)}`;
    document.getElementById("storageQuotaBar").style.width = `${Math.max(4, info.percent)}%`;
    document.getElementById("storageDetails").textContent =
      `Kullanılan Alan: ${formatBytes(info.usage)} — Toplam Tarayıcı Kotası: ${formatBytes(info.quota)} (%${info.percent.toFixed(1)})`;
  }

  _bindUIEvents() {
    // Sol Kenar Çubuğu & Sağ Panel Aç/Kapat
    document.getElementById("btnToggleSidebar").addEventListener("click", () => {
      document.getElementById("leftSidebar").classList.toggle("collapsed");
    });
    document.getElementById("btnToggleAiPanel").addEventListener("click", () => {
      document.getElementById("aiPanel").classList.toggle("collapsed");
    });
    document.getElementById("btnToggleKeyBox").addEventListener("click", () => {
      document.getElementById("apiKeySection").classList.toggle("hidden");
    });

    // Zen Modu
    const toggleZen = () => {
      const active = document.body.classList.toggle("zen-mode");
      document.getElementById("btnExitZenFloat").classList.toggle("hidden", !active);
    };
    document.getElementById("btnZenMode").addEventListener("click", toggleZen);
    document.getElementById("btnExitZenFloat").addEventListener("click", toggleZen);

    // Defter Başlığı Güncelleme
    document.getElementById("notebookTitleInput").addEventListener("change", async (e) => {
      if (!this.activeNotebook) return;
      this.activeNotebook.title = e.target.value.trim() || "İsimsiz Defter";
      await this.storage.saveNotebook(this.activeNotebook);
      this._renderNotebookTree();
    });

    // Sol Kenar Çubuğu Sekmeleri
    document.querySelectorAll(".sidebar-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".sidebar-tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".sidebar-panel").forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById(tab.dataset.tab).classList.add("active");
      });
    });

    // Yeni Ders, Yeni Defter, PDF İçe Aktar
    document.getElementById("btnNewSubject").addEventListener("click", () => {
      const name = prompt("Yeni ders klasörü adı:");
      if (name && name.trim()) {
        this.subjects.push(name.trim());
        this._renderNotebookTree();
      }
    });

    document.getElementById("btnNewNotebook").addEventListener("click", async () => {
      const nb = await this.storage.saveNotebook({
        id: `nb_${Date.now()}`,
        title: `Çalışma Notu ${this.notebooks.length + 1}`,
        subject: this.subjects[0] || "Genel",
        pageCount: 1,
        pdfHash: null,
        paperSettings: { ...this.canvasEngine.paperSettings },
        updatedAt: Date.now()
      });
      this.notebooks.unshift(nb);
      await this.openNotebook(nb.id);
    });

    document.getElementById("btnImportPdf").addEventListener("click", () => {
      document.getElementById("pdfFileInput").click();
    });

    document.getElementById("pdfFileInput").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const hash = await this.storage.storePdfBlob(file);
      const buf = await file.arrayBuffer();
      const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
      const nb = await this.storage.saveNotebook({
        id: `nb_${Date.now()}`,
        title: file.name.replace(/\.pdf$/i, ""),
        subject: this.subjects[0] || "Genel",
        pageCount: doc.numPages,
        pdfHash: hash,
        paperSettings: { template: "blank", theme: "white", layout: "a4-portrait" },
        updatedAt: Date.now()
      });
      this.notebooks.unshift(nb);
      await this.openNotebook(nb.id);
      e.target.value = "";
    });

    document.getElementById("btnAddPage").addEventListener("click", async () => {
      const idx = await this.addNewPageToNotebook();
      this.jumpToPage(idx);
    });

    // Kitap İçi Arama
    let searchTimer = null;
    document.getElementById("pdfSearchInput").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        this.outlineAndSearch.search(e.target.value);
      }, 280);
    });

    // Sessiz Odak Sayacı (15/25/45 dk)
    const updateTimerUI = () => {
      const m = String(Math.floor(this.timerSecondsLeft / 60)).padStart(2, "0");
      const s = String(this.timerSecondsLeft % 60).padStart(2, "0");
      document.getElementById("timerDisplay").textContent = `${m}:${s}`;
    };

    document.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
        document.getElementById("btnTimerToggle").textContent = "▶";
        document.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.timerMinutes = Number(btn.dataset.min);
        this.timerSecondsLeft = this.timerMinutes * 60;
        updateTimerUI();
      });
    });

    document.getElementById("btnTimerToggle").addEventListener("click", (e) => {
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
        e.target.textContent = "▶";
      } else {
        e.target.textContent = "⏸";
        this.timerInterval = setInterval(() => {
          if (this.timerSecondsLeft > 0) {
            this.timerSecondsLeft--;
            updateTimerUI();
          } else {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
            e.target.textContent = "▶";
            document.getElementById("timerDisplay").style.color = "#16a34a";
          }
        }, 1000);
      }
    });

    document.getElementById("btnTimerReset").addEventListener("click", () => {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
      document.getElementById("btnTimerToggle").textContent = "▶";
      document.getElementById("timerDisplay").style.color = "";
      this.timerSecondsLeft = this.timerMinutes * 60;
      updateTimerUI();
    });

    // Yüzen Araç Çubuğu Sürükleme & Katlama
    const toolbar = document.getElementById("floatingToolbar");
    const grip = document.getElementById("toolbarDragHandle");
    grip.addEventListener("pointerdown", (e) => {
      grip.setPointerCapture(e.pointerId);
      const rect = toolbar.getBoundingClientRect();
      const parentRect = document.getElementById("workspace").getBoundingClientRect();
      const ox = e.clientX - rect.left;
      const oy = e.clientY - rect.top;
      toolbar.style.transform = "none";
      const onMove = (ev) => {
        toolbar.style.left = `${Math.max(8, ev.clientX - parentRect.left - ox)}px`;
        toolbar.style.top = `${Math.max(8, ev.clientY - parentRect.top - oy)}px`;
      };
      const onUp = () => {
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
    });

    document.getElementById("btnCollapseToolbar").addEventListener("click", (e) => {
      const collapsed = toolbar.classList.toggle("collapsed");
      e.target.textContent = collapsed ? "▸" : "▾";
    });

    // Çizim Araç Seçimi
    document.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tool-btn[data-tool]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const tool = btn.dataset.tool;
        this.canvasEngine.tool = tool;
        document.getElementById("eraserModeBar").classList.toggle("hidden", tool !== "eraser");
        document.getElementById("workspace").classList.toggle("text-select-mode", tool === "textselect");
      });
    });

    document.querySelectorAll(".sub-btn[data-eraser]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".sub-btn[data-eraser]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.canvasEngine.eraserMode = btn.dataset.eraser;
      });
    });

    // 5 Favori Renk Slotu + Tam Renk Seçici
    const colorPicker = document.getElementById("customColorPicker");
    document.querySelectorAll(".fav-color").forEach((slotBtn) => {
      slotBtn.addEventListener("click", () => {
        document.querySelectorAll(".fav-color").forEach((s) => s.classList.remove("active"));
        slotBtn.classList.add("active");
        const rgb = getComputedStyle(slotBtn).backgroundColor;
        this.canvasEngine.color = rgb;
      });
    });

    colorPicker.addEventListener("input", (e) => {
      const hex = e.target.value;
      this.canvasEngine.color = hex;
      const activeSlot = document.querySelector(".fav-color.active");
      if (activeSlot) activeSlot.style.background = hex;
    });

    // 3 Hızlı Kalınlık Önayarı
    document.querySelectorAll(".size-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".size-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.canvasEngine.size = Number(btn.dataset.size);
      });
    });

    document.getElementById("btnUndo").addEventListener("click", () => this._triggerUndo());
    document.getElementById("btnRedo").addEventListener("click", () => this._triggerRedo());

    // Son Yazılan Yere Dön
    document.getElementById("btnJumpLastStroke").addEventListener("click", () => {
      const loc = this.canvasEngine.lastWrittenLocation;
      this.jumpToPage(loc.pageIndex, loc.x, loc.y);
    });

    // Gizmo Mini Eylem Çubuğu
    document.getElementById("gizmoColorInput").addEventListener("input", (e) => {
      const g = this.canvasEngine.gizmo;
      if (!g.active) return;
      for (const s of g.strokes) s.color = e.target.value;
      this.canvasEngine.redrawPage(g.pageIndex);
      this.schedulePageSave(g.pageIndex);
    });

    document.getElementById("btnGizmoDuplicate").addEventListener("click", () => {
      const g = this.canvasEngine.gizmo;
      const pd = this.canvasEngine.pagesData.get(g.pageIndex);
      if (!g.active || !pd) return;
      const clones = g.strokes.map((s) => {
        const pts = new Float32Array(s.points);
        for (let i = 0; i < pts.length; i += 3) {
          pts[i] += 24;
          pts[i + 1] += 24;
        }
        return {
          ...s,
          id: `st_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          points: pts,
          bbox: CollisionEngine.computeBBox(pts, s.width)
        };
      });
      const cmd = new AddStrokesCommand(pd, clones);
      this.canvasEngine.history.push(cmd, false);
      g.setSelection(g.pageIndex, clones);
      this._updateGizmoBar(g);
      this.canvasEngine.redrawPage(g.pageIndex);
      this.schedulePageSave(g.pageIndex);
    });

    document.getElementById("btnGizmoDelete").addEventListener("click", () => {
      const g = this.canvasEngine.gizmo;
      if (!g.active) return;
      for (const s of g.strokes) s.deleted = true;
      const idx = g.pageIndex;
      g.clear();
      this._updateGizmoBar(null);
      this.canvasEngine.redrawPage(idx);
      this.schedulePageSave(idx);
    });

    document.getElementById("btnGizmoAskAi").addEventListener("click", async () => {
      const crop = await cropSelectionHiDPI({
        gizmo: this.canvasEngine.gizmo,
        pdfEngine: this.pdfEngine,
        canvasEngine: this.canvasEngine
      });
      if (crop) {
        document.getElementById("aiPanel").classList.remove("collapsed");
        this.gemini.setAttachment(crop);
      }
    });

    // PDF Metin Seçimi Yüzen Menü (180ms Debounce + Otomatik Fosforlu Vurgulama)
    let selTimer = null;
    const selMenu = document.getElementById("textSelectMenu");
    document.addEventListener("selectionchange", () => {
      if (this.canvasEngine.tool !== "textselect") {
        selMenu.classList.add("hidden");
        return;
      }
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) {
          selMenu.classList.add("hidden");
          return;
        }
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const wr = document.getElementById("workspace").getBoundingClientRect();
        selMenu.style.left = `${Math.max(12, rect.left - wr.left)}px`;
        selMenu.style.top = `${Math.max(12, rect.top - wr.top - 48)}px`;
        selMenu.classList.remove("hidden");
      }, 180);
    });

    const getSelectedText = () => (window.getSelection()?.toString() || "").trim();
    document.getElementById("btnSelTranslate").addEventListener("click", () => {
      const t = getSelectedText();
      if (t) this.gemini.sendPrompt(`Şu metni akıcı ve akademik Türkçeye çevir:\n\n"${t}"`);
      selMenu.classList.add("hidden");
    });
    document.getElementById("btnSelSummarize").addEventListener("click", () => {
      const t = getSelectedText();
      if (t) this.gemini.sendPrompt(`Şu metni kısa maddeler halinde özetle:\n\n"${t}"`);
      selMenu.classList.add("hidden");
    });
    document.getElementById("btnSelExplain").addEventListener("click", () => {
      const t = getSelectedText();
      if (t) this.gemini.sendPrompt(`Şu kavramı/formülü adım adım ve LaTeX kullanarak açıkla:\n\n"${t}"`);
      selMenu.classList.add("hidden");
    });
    document.getElementById("btnSelCopy").addEventListener("click", () => {
      const t = getSelectedText();
      if (t) navigator.clipboard?.writeText(t);
      selMenu.classList.add("hidden");
    });

    // Seçili Metni Tek Komutla Vektör Fosforlu Çizgiye Dönüştür
    document.querySelectorAll(".hl-dot").forEach((dot) => {
      dot.addEventListener("click", () => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const range = sel.getRangeAt(0);
        const clientRects = Array.from(range.getClientRects());
        const anchorNode = range.commonAncestorContainer;
        const wrapper = (anchorNode.nodeType === 1 ? anchorNode : anchorNode.parentElement)?.closest(".page-wrapper");
        if (!wrapper) return;

        const pageIndex = Number(wrapper.dataset.pageIndex);
        const pd = this.canvasEngine.pagesData.get(pageIndex);
        const wr = wrapper.getBoundingClientRect();
        const zoom = this.canvasEngine.zoom;

        const worldRects = clientRects
          .filter((r) => r.width > 2 && r.height > 2)
          .map((r) => ({
            x: (r.left - wr.left) / zoom,
            y: (r.top - wr.top) / zoom,
            w: r.width / zoom,
            h: r.height / zoom
          }));

        const merged = mergeSameLineWorldRects(worldRects);
        const color = dot.dataset.color;
        const strokes = merged.map((r) => {
          const midY = r.y + r.h * 0.5;
          const f32 = new Float32Array([r.x, midY, 0.5, r.x + r.w, midY, 0.5]);
          return {
            id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            tool: "highlighter",
            color,
            width: Math.max(3, r.h / 4.5),
            opacity: 0.42,
            lineCap: "butt",
            points: f32,
            bbox: { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h },
            deleted: false
          };
        });

        if (strokes.length > 0 && pd) {
          const cmd = new AddStrokesCommand(pd, strokes);
          this.canvasEngine.history.push(cmd, false);
          this.canvasEngine.redrawPage(pageIndex);
          this.schedulePageSave(pageIndex);
        }
        sel.removeAllRanges();
        selMenu.classList.add("hidden");
      });
    });

    // Kağıt Ayarları Modalı
    document.getElementById("btnPaperSettings").addEventListener("click", () => {
      document.getElementById("paperModal").classList.remove("hidden");
    });

    document.getElementById("btnApplyPaper").addEventListener("click", async () => {
      const settings = {
        template: document.getElementById("paperTemplateSelect").value,
        theme: document.getElementById("paperThemeSelect").value,
        layout: document.getElementById("paperLayoutSelect").value
      };
      this.canvasEngine.setPaperSettings(settings);
      if (!this.pdfEngine.pdfDoc) {
        const dims = this.canvasEngine.getLayoutDimensions();
        this.pdfEngine.updateAllPageDimensions(dims);
        for (const [idx, pd] of this.canvasEngine.pagesData.entries()) {
          pd.width = dims.width;
          pd.height = dims.height;
          const slot = this.canvasEngine.slots.get(idx);
          if (slot) this.canvasEngine.registerMountedPage(idx, slot, pd);
        }
      }
      if (this.activeNotebook) {
        this.activeNotebook.paperSettings = settings;
        await this.storage.saveNotebook(this.activeNotebook);
      }
      document.getElementById("paperModal").classList.add("hidden");
    });

    // Çalışma Özeti Modalı
    let activeGuideFilter = "all";
    const renderGuideItems = () => {
      const listEl = document.getElementById("studyGuideList");
      listEl.innerHTML = "";
      const filtered = this.studyGuide.items.filter(
        (it) => activeGuideFilter === "all" || it.colorTag === activeGuideFilter
      );
      if (filtered.length === 0) {
        listEl.innerHTML = `<p class="muted-empty">Bu filtreye uygun vurgu veya yapışkan not kartı bulunamadı.</p>`;
        return;
      }
      for (const it of filtered) {
        const div = document.createElement("div");
        div.className = "guide-item";
        div.style.borderLeftColor = it.rawColor || "#2563eb";
        div.innerHTML = `
          <div class="guide-item-meta">Sayfa ${it.pageIndex + 1} • ${it.type === "sticky" ? "📌 Yapışkan Kart" : "🖍️ Fosforlu Vurgu"}</div>
          <div>${formatBasicMarkdown(it.text)}</div>
        `;
        renderMathInElementSafe(div);
        div.addEventListener("click", () => this.studyGuide.onJumpToLocation(it.pageIndex, it.x, it.y));
        listEl.appendChild(div);
      }
    };

    document.getElementById("btnStudySummary").addEventListener("click", async () => {
      document.getElementById("studyGuideModal").classList.remove("hidden");
      await this.studyGuide.collect();
      renderGuideItems();
    });

    document.querySelectorAll("#guideFilterPills .pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        document.querySelectorAll("#guideFilterPills .pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        activeGuideFilter = pill.dataset.filter;
        renderGuideItems();
      });
    });

    document.getElementById("btnCopyGuideMd").addEventListener("click", () => {
      navigator.clipboard?.writeText(this.studyGuide.toMarkdown(activeGuideFilter));
    });
    document.getElementById("btnInsertGuidePage").addEventListener("click", () => {
      this.studyGuide.onInsertSummaryPage(this.studyGuide.toMarkdown(activeGuideFilter));
    });
    document.getElementById("btnGenerateQuiz").addEventListener("click", () => {
      this.studyGuide.onGenerateQuizWithAi(this.studyGuide.toMarkdown(activeGuideFilter));
    });

    // PDF Dışa Aktarma & Yedekleme Modalı
    document.getElementById("btnExportPdf").addEventListener("click", async () => {
      await exportFlattenedPDF({
        notebookTitle: this.activeNotebook?.title,
        pageCount: this.pdfEngine.pageCount,
        pdfEngine: this.pdfEngine,
        canvasEngine: this.canvasEngine,
        getPageData: async (i) =>
          this.canvasEngine.pagesData.get(i) || (await this.storage.loadPage(this.activeNotebook.id, i))
      });
    });

    document.getElementById("btnBackupModal").addEventListener("click", async () => {
      await this._refreshQuota();
      document.getElementById("backupModal").classList.remove("hidden");
    });

    document.getElementById("btnCleanOrphans").addEventListener("click", async () => {
      const count = await this.storage.cleanupOrphanedPdfs();
      await this._refreshQuota();
      alert(`${count} sahipsiz PDF belgesi temizlendi.`);
    });

    document.getElementById("btnExportBackup").addEventListener("click", async () => {
      const blob = await this.storage.exportOdakNotBackup();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `OdakNot_Yedek_${new Date().toISOString().slice(0, 10)}.odaknot`;
      a.click();
    });

    document.getElementById("backupFileInput").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await this.storage.importOdakNotBackup(file);
      this.notebooks = await this.storage.listNotebooks();
      if (this.notebooks.length > 0) await this.openNotebook(this.notebooks[0].id);
      document.getElementById("backupModal").classList.add("hidden");
      e.target.value = "";
    });

    // Metin Kutusu ve Görsel Ekleme
    document.getElementById("btnConfirmTextBox").addEventListener("click", () => {
      const text = document.getElementById("textBoxInput").value.trim();
      const pt = this.pendingTextInsertPt;
      if (text && pt) {
        const pd = this.canvasEngine.pagesData.get(pt.pageIndex);
        if (pd) {
          pd.texts.push({
            x: pt.x,
            y: pt.y,
            size: Number(document.getElementById("textBoxSize").value) || 18,
            color: document.getElementById("textBoxColor").value,
            text
          });
          this.canvasEngine.redrawPage(pt.pageIndex);
          this.schedulePageSave(pt.pageIndex);
        }
      }
      document.getElementById("textBoxModal").classList.add("hidden");
    });

    document.getElementById("imageInsertInput").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      const pt = this.pendingImageInsertPt;
      if (!file || !pt) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const pd = this.canvasEngine.pagesData.get(pt.pageIndex);
          if (!pd) return;
          const w = Math.min(320, img.width);
          const h = (img.height / img.width) * w;
          pd.images.push({ x: pt.x, y: pt.y, w, h, dataUrl: reader.result, _el: img });
          this.canvasEngine.redrawPage(pt.pageIndex);
          this.schedulePageSave(pt.pageIndex);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
      e.target.value = "";
    });

    // Modal Kapatma Butonları
    document.querySelectorAll(".close-modal").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById(btn.dataset.close).classList.add("hidden");
      });
    });
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const app = new OdakNotApp();
  app.init();
});
