// Sıkıştırılmış IndexedDB Depolama, Ramer-Douglas-Peucker Sadeleştirme ve .odaknot Yedekleme

const DB_NAME = "OdakNotDB";
const DB_VERSION = 1;

function pointToSegDistSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return (px - ax) * (px - ax) + (py - ay) * (py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return (px - projX) * (px - projX) + (py - projY) * (py - projY);
}

export function rdpSimplify(points, epsilon = 0.3) {
  if (points.length <= 2) return points;
  const epsSq = epsilon * epsilon;
  let maxDistSq = 0;
  let index = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const dSq = pointToSegDistSq(points[i].x, points[i].y, first.x, first.y, last.x, last.y);
    if (dSq > maxDistSq) {
      maxDistSq = dSq;
      index = i;
    }
  }

  if (maxDistSq > epsSq) {
    const left = rdpSimplify(points.slice(0, index + 1), epsilon);
    const right = rdpSimplify(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

export async function compressFloat32(float32Arr) {
  const bytes = new Uint8Array(float32Arr.buffer, float32Arr.byteOffset, float32Arr.byteLength);
  if (typeof CompressionStream === "undefined") {
    return { compressed: false, data: bytes.slice().buffer };
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return { compressed: true, data: buf };
}

export async function decompressFloat32(record) {
  if (!record || !record.data) return new Float32Array(0);
  if (!record.compressed || typeof DecompressionStream === "undefined") {
    return new Float32Array(record.data);
  }
  const stream = new Blob([record.data]).stream().pipeThrough(new DecompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Float32Array(buf);
}

export async function computeSHA256(arrayBuffer) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class StorageManager {
  constructor() {
    this.db = null;
  }

  async init() {
    await this.requestPersistence();
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("pdfs")) {
          db.createObjectStore("pdfs", { keyPath: "hash" });
        }
        if (!db.objectStoreNames.contains("notebooks")) {
          db.createObjectStore("notebooks", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("pages")) {
          db.createObjectStore("pages", { keyPath: ["notebookId", "pageIndex"] });
        }
        if (!db.objectStoreNames.contains("thumbnails")) {
          db.createObjectStore("thumbnails", { keyPath: ["notebookId", "pageIndex"] });
        }
        if (!db.objectStoreNames.contains("pdf_text_cache")) {
          db.createObjectStore("pdf_text_cache", { keyPath: ["pdfHash", "pageIndex"] });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async requestPersistence() {
    if (navigator.storage && navigator.storage.persist) {
      try {
        await navigator.storage.persist();
      } catch (_) {
        // Sessizce yoksay
      }
    }
  }

  _tx(storeNames, mode = "readonly") {
    return this.db.transaction(storeNames, mode);
  }

  _req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // SHA-256 Tekilleştirilmiş PDF Saklama
  async storePdfBlob(fileOrBlob) {
    const buf = await fileOrBlob.arrayBuffer();
    const hash = await computeSHA256(buf);
    const existing = await this._req(this._tx("pdfs").objectStore("pdfs").get(hash));
    if (!existing) {
      await this._req(
        this._tx("pdfs", "readwrite").objectStore("pdfs").put({
          hash,
          blob: new Blob([buf], { type: "application/pdf" }),
          size: buf.byteLength,
          addedAt: Date.now()
        })
      );
    }
    return hash;
  }

  async getPdfBlob(hash) {
    if (!hash) return null;
    const rec = await this._req(this._tx("pdfs").objectStore("pdfs").get(hash));
    return rec ? rec.blob : null;
  }

  // Defter İşlemleri
  async listNotebooks() {
    const list = await this._req(this._tx("notebooks").objectStore("notebooks").getAll());
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async saveNotebook(nb) {
    nb.updatedAt = Date.now();
    await this._req(this._tx("notebooks", "readwrite").objectStore("notebooks").put(nb));
    return nb;
  }

  async deleteNotebook(notebookId) {
    const tx = this._tx(["notebooks", "pages", "thumbnails"], "readwrite");
    tx.objectStore("notebooks").delete(notebookId);
    const range = IDBKeyRange.bound([notebookId, 0], [notebookId, Number.MAX_SAFE_INTEGER]);
    tx.objectStore("pages").delete(range);
    tx.objectStore("thumbnails").delete(range);
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }

  // Sayfa Serileştirme (Float32Array + Gzip)
  async savePage(notebookId, pageIndex, pageData) {
    const serializedStrokes = [];
    for (const st of pageData.strokes || []) {
      if (st.deleted) continue;
      const packed = await compressFloat32(st.points);
      serializedStrokes.push({
        id: st.id,
        tool: st.tool,
        color: st.color,
        width: st.width,
        opacity: st.opacity,
        lineCap: st.lineCap || "round",
        bbox: st.bbox,
        packedPoints: packed
      });
    }

    const record = {
      notebookId,
      pageIndex,
      width: pageData.width,
      height: pageData.height,
      strokes: serializedStrokes,
      texts: pageData.texts || [],
      images: pageData.images || [],
      stickyCards: pageData.stickyCards || [],
      updatedAt: Date.now()
    };

    await this._req(this._tx("pages", "readwrite").objectStore("pages").put(record));
  }

  async loadPage(notebookId, pageIndex) {
    const rec = await this._req(this._tx("pages").objectStore("pages").get([notebookId, pageIndex]));
    if (!rec) return null;
    const strokes = [];
    for (const s of rec.strokes || []) {
      const pts = await decompressFloat32(s.packedPoints);
      strokes.push({
        id: s.id,
        tool: s.tool,
        color: s.color,
        width: s.width,
        opacity: s.opacity,
        lineCap: s.lineCap || "round",
        bbox: s.bbox,
        points: pts,
        deleted: false
      });
    }
    return {
      notebookId: rec.notebookId,
      pageIndex: rec.pageIndex,
      width: rec.width,
      height: rec.height,
      strokes,
      texts: rec.texts || [],
      images: rec.images || [],
      stickyCards: rec.stickyCards || []
    };
  }

  async loadAllPagesForNotebook(notebookId, pageCount) {
    const pages = [];
    for (let i = 0; i < pageCount; i++) {
      const p = await this.loadPage(notebookId, i);
      pages.push(p);
    }
    return pages;
  }

  // Thumbnail Önbelleği
  async saveThumbnail(notebookId, pageIndex, blob) {
    await this._req(
      this._tx("thumbnails", "readwrite").objectStore("thumbnails").put({
        notebookId,
        pageIndex,
        blob,
        updatedAt: Date.now()
      })
    );
  }

  async getThumbnail(notebookId, pageIndex) {
    const rec = await this._req(this._tx("thumbnails").objectStore("thumbnails").get([notebookId, pageIndex]));
    return rec ? rec.blob : null;
  }

  // PDF Metin İndeksi Önbelleği
  async savePdfPageText(pdfHash, pageIndex, items) {
    await this._req(
      this._tx("pdf_text_cache", "readwrite").objectStore("pdf_text_cache").put({
        pdfHash,
        pageIndex,
        items
      })
    );
  }

  async getPdfPageText(pdfHash, pageIndex) {
    const rec = await this._req(
      this._tx("pdf_text_cache").objectStore("pdf_text_cache").get([pdfHash, pageIndex])
    );
    return rec ? rec.items : null;
  }

  // Kota ve Sahipsiz PDF Temizliği
  async getQuotaInfo() {
    if (!navigator.storage || !navigator.storage.estimate) {
      return { usage: 0, quota: 0, percent: 0 };
    }
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const percent = quota > 0 ? Math.min(100, (usage / quota) * 100) : 0;
    return { usage, quota, percent };
  }

  async cleanupOrphanedPdfs() {
    const notebooks = await this.listNotebooks();
    const usedHashes = new Set(notebooks.map((n) => n.pdfHash).filter(Boolean));
    const allPdfs = await this._req(this._tx("pdfs").objectStore("pdfs").getAll());
    let removed = 0;
    const tx = this._tx(["pdfs", "pdf_text_cache"], "readwrite");
    for (const pdf of allPdfs) {
      if (!usedHashes.has(pdf.hash)) {
        tx.objectStore("pdfs").delete(pdf.hash);
        const range = IDBKeyRange.bound([pdf.hash, 0], [pdf.hash, Number.MAX_SAFE_INTEGER]);
        tx.objectStore("pdf_text_cache").delete(range);
        removed++;
      }
    }
    await new Promise((res) => (tx.oncomplete = res));
    return removed;
  }

  // Tüm Veriyi .odaknot Dosyası Olarak Dışa/İçe Aktar
  async exportOdakNotBackup() {
    const notebooks = await this.listNotebooks();
    const pages = await this._req(this._tx("pages").objectStore("pages").getAll());
    const pdfs = await this._req(this._tx("pdfs").objectStore("pdfs").getAll());

    const encodedPages = pages.map((p) => ({
      ...p,
      strokes: (p.strokes || []).map((st) => ({
        ...st,
        packedPoints: {
          compressed: st.packedPoints.compressed,
          b64: this._bufToB64(st.packedPoints.data)
        }
      }))
    }));

    const encodedPdfs = [];
    for (const pdf of pdfs) {
      const buf = await pdf.blob.arrayBuffer();
      encodedPdfs.push({
        hash: pdf.hash,
        size: pdf.size,
        b64: this._bufToB64(buf)
      });
    }

    const payload = {
      format: "odaknot-backup-v1",
      exportedAt: new Date().toISOString(),
      notebooks,
      pages: encodedPages,
      pdfs: encodedPdfs
    };

    return new Blob([JSON.stringify(payload)], { type: "application/json" });
  }

  async importOdakNotBackup(file) {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data.format !== "odaknot-backup-v1") {
      throw new Error("Geçersiz .odaknot yedek dosyası.");
    }

    const tx = this._tx(["notebooks", "pages", "pdfs"], "readwrite");
    for (const pdf of data.pdfs || []) {
      const buf = this._b64ToBuf(pdf.b64);
      tx.objectStore("pdfs").put({
        hash: pdf.hash,
        blob: new Blob([buf], { type: "application/pdf" }),
        size: pdf.size,
        addedAt: Date.now()
      });
    }
    for (const nb of data.notebooks || []) {
      tx.objectStore("notebooks").put(nb);
    }
    for (const p of data.pages || []) {
      const decodedStrokes = (p.strokes || []).map((st) => ({
        ...st,
        packedPoints: {
          compressed: st.packedPoints.compressed,
          data: this._b64ToBuf(st.packedPoints.b64)
        }
      }));
      tx.objectStore("pages").put({ ...p, strokes: decodedStrokes });
    }
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }

  _bufToB64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  _b64ToBuf(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
