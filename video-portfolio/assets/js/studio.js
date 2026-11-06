/* Studio — edit brand + upload videos, no build step, no backend required
   (a tiny optional Node server gives you real file uploads on your machine). */

const LS_DRAFT = "vp-draft";        // what index.html?draft=1 reads
const LS_WORK = "vp-studio-work";   // working copy when there is no local server
const LS_GH = "vp-gh";
const CORE_FILES = [
  "index.html",
  "studio.html",
  "assets/css/site.css",
  "assets/css/studio.css",
  "assets/js/site.js",
  "assets/js/studio.js"
];
const ACCENTS = ["#ff5a3c", "#ffd166", "#7ef0b6", "#7db8ff", "#c79bff", "#f4f1ec"];

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let D = { site: {}, videos: [] };
let MODE = "static";          // "local" when server.js is running
const pending = new Map();    // path -> File/Blob waiting for a GitHub publish
let usedPaths = new Set();

/* ---------------- tiny helpers ---------------- */
const uid = () => Math.random().toString(36).slice(2, 10);
const slug = (name) =>
  name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "video";
const prettify = (name) =>
  name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

function log(msg, cls = "") {
  const box = $("#ghlog");
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function uniquePath(dir, base, ext) {
  let path = `${dir}/${base}${ext}`;
  let n = 2;
  while (usedPaths.has(path)) path = `${dir}/${base}-${n++}${ext}`;
  usedPaths.add(path);
  return path;
}

/* ---------------- data ---------------- */
function normalize(data) {
  const d = data && typeof data === "object" ? data : {};
  d.site = d.site || {};
  d.videos = Array.isArray(d.videos) ? d.videos : [];
  d.videos = d.videos.map((v) => ({
    id: v.id || uid(),
    title: v.title || "Untitled",
    type: v.type === "reel" ? "reel" : "film",
    category: v.category || "",
    year: v.year || String(new Date().getFullYear()),
    client: v.client || "",
    src: v.src || "",
    poster: v.poster || "",
    featured: !!v.featured
  }));
  usedPaths = new Set(d.videos.flatMap((v) => [v.src, v.poster]).filter(Boolean));
  return d;
}

async function loadData() {
  let fromFile = null;
  try {
    const res = await fetch("data.json", { cache: "no-store" });
    if (res.ok) fromFile = await res.json();
  } catch {
    /* ignore */
  }
  if (MODE === "local") return normalize(fromFile || {});
  const work = localStorage.getItem(LS_WORK);
  if (work) {
    try {
      return normalize(JSON.parse(work));
    } catch {
      /* ignore */
    }
  }
  return normalize(fromFile || {});
}

const clean = (v) => ({
  id: v.id,
  title: v.title,
  type: v.type,
  category: v.category,
  year: v.year,
  client: v.client,
  src: v.src,
  poster: v.poster,
  featured: !!v.featured
});

function payload() {
  return JSON.stringify({ version: 1, site: D.site, videos: D.videos.map(clean) }, null, 2);
}

let saveTimer;
function scheduleSave() {
  localStorage.setItem(LS_DRAFT, payload());
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToDisk, 900);
}

async function saveToDisk(showToast = false) {
  localStorage.setItem(LS_DRAFT, payload());
  localStorage.setItem(LS_WORK, payload());
  if (MODE !== "local") {
    if (showToast) toast("Saved in this browser — publish to make it live");
    return true;
  }
  try {
    const res = await fetch("api/data", { method: "PUT", headers: { "content-type": "application/json" }, body: payload() });
    if (!res.ok) throw new Error(await res.text());
    if (showToast) toast("Saved ✓");
    return true;
  } catch (err) {
    toast("Could not save: " + err.message, true);
    return false;
  }
}

/* ---------------- brand tab ---------------- */
function fillBrand() {
  const s = D.site;
  $("#fName").value = s.name || "";
  $("#fRole").value = s.role || "";
  $("#fTagline").value = s.tagline || "";
  $("#fBio").value = s.bio || "";
  $("#fEmail").value = s.email || "";
  $("#fLocation").value = s.location || "";
  $("#fClients").value = s.clients || "";
  $("#fGear").value = s.gear || "";
  $("#fAccent").value = /^#[0-9a-f]{6}$/i.test(s.accent || "") ? s.accent : "#ff5a3c";
  $("#fShowReels").checked = s.showReels !== false;
  renderLogo();
  renderSwatches();
  renderMini();
  renderSocials();
}

function renderSwatches() {
  const current = ($("#fAccent").value || "").toLowerCase();
  $("#swatches").innerHTML = ACCENTS.map(
    (c) => `<button class="sw${c.toLowerCase() === current ? " is-active" : ""}" style="background:${c}" data-color="${c}" aria-label="${c}"></button>`
  ).join("");
}

function initials(name) {
  return (
    String(name || "?")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] || "")
      .join("")
      .toUpperCase() || "?"
  );
}

function renderLogo() {
  const logo = D.site.logo;
  $("#logoPreview").innerHTML = logo ? `<img src="${esc(logo)}" alt="logo" />` : esc(initials(D.site.name));
  $("#miniLogo").innerHTML = logo ? `<img src="${esc(logo)}" alt="" />` : esc(initials(D.site.name));
}

function renderMini() {
  $("#miniName").textContent = D.site.name || "Your Name";
  $("#miniRole").textContent = D.site.role || "Videographer";
  document.documentElement.style.setProperty("--accent", $("#fAccent").value || "#ff5a3c");
}

function renderSocials() {
  const list = D.site.socials || [];
  $("#socialList").innerHTML = list.length
    ? list
        .map(
          (s, i) => `<div class="rep-row">
            <input data-social="${i}" data-key="label" value="${esc(s.label)}" placeholder="Instagram" />
            <input data-social="${i}" data-key="url" value="${esc(s.url)}" placeholder="https://instagram.com/you" />
            <button data-remove-social="${i}" title="Remove">✕</button>
          </div>`
        )
        .join("")
    : `<p class="hint">No links yet — add Instagram, YouTube, TikTok, WhatsApp…</p>`;
}

function bindBrand() {
  const map = {
    fName: "name",
    fRole: "role",
    fTagline: "tagline",
    fBio: "bio",
    fEmail: "email",
    fLocation: "location",
    fClients: "clients",
    fGear: "gear"
  };
  for (const [id, key] of Object.entries(map)) {
    $("#" + id).addEventListener("input", (e) => {
      D.site[key] = e.target.value;
      if (key === "name") renderLogo();
      renderMini();
      scheduleSave();
    });
  }
  $("#fAccent").addEventListener("input", (e) => {
    D.site.accent = e.target.value;
    renderSwatches();
    renderMini();
    scheduleSave();
  });
  $("#swatches").addEventListener("click", (e) => {
    const b = e.target.closest("[data-color]");
    if (!b) return;
    $("#fAccent").value = b.dataset.color;
    D.site.accent = b.dataset.color;
    renderSwatches();
    renderMini();
    scheduleSave();
  });
  $("#fShowReels").addEventListener("change", (e) => {
    D.site.showReels = e.target.checked;
    scheduleSave();
  });

  $("#logoInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await setLogo(file);
    e.target.value = "";
  });
  $("#logoClear").addEventListener("click", () => {
    D.site.logo = "";
    renderLogo();
    scheduleSave();
  });

  $("#addSocial").addEventListener("click", () => {
    D.site.socials = [...(D.site.socials || []), { label: "", url: "" }];
    renderSocials();
    scheduleSave();
  });
  $("#socialList").addEventListener("input", (e) => {
    const input = e.target.closest("[data-social]");
    if (!input) return;
    const i = Number(input.dataset.social);
    D.site.socials[i][input.dataset.key] = input.value;
    scheduleSave();
  });
  $("#socialList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove-social]");
    if (!btn) return;
    D.site.socials.splice(Number(btn.dataset.removeSocial), 1);
    renderSocials();
    scheduleSave();
  });
}

async function setLogo(file) {
  const ext = (file.name.split(".").pop() || "png").toLowerCase();
  const path = `images/logo.${ext === "svg" ? "svg" : ext === "webp" ? "webp" : "png"}`;
  if (MODE === "local") {
    try {
      await putFile(path, file);
      D.site.logo = path + "?v=" + Date.now().toString(36);
    } catch (err) {
      toast("Logo upload failed: " + err.message, true);
      return;
    }
  } else {
    pending.set(path, file);
    D.site.logo = path;
    toast("Logo queued — press Publish to make it live");
  }
  renderLogo();
  scheduleSave();
}

/* ---------------- uploads ---------------- */
function putFile(path, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", "api/file?path=" + encodeURIComponent(path));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(xhr.responseText || "HTTP " + xhr.status)));
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(blob);
  });
}

function probe(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.playsInline = true;
    v.src = url;
    const done = (blob) => {
      URL.revokeObjectURL(url);
      resolve({ poster: blob, width: v.videoWidth || 0, height: v.videoHeight || 0, duration: v.duration || 0 });
    };
    v.onloadeddata = () => {
      try {
        v.currentTime = Math.min(1, Math.max(0.1, (v.duration || 2) * 0.25));
      } catch {
        done(null);
      }
    };
    v.onseeked = () => {
      try {
        const w = Math.min(1280, v.videoWidth || 1280);
        const h = Math.round((w * (v.videoHeight || 720)) / (v.videoWidth || 1280));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").drawImage(v, 0, 0, w, h);
        c.toBlob((b) => done(b), "image/jpeg", 0.82);
      } catch {
        done(null);
      }
    };
    v.onerror = () => done(null);
    setTimeout(() => done(null), 12000);
  });
}

function queueRow(name) {
  const row = document.createElement("div");
  row.className = "uq";
  row.innerHTML = `<span class="uq-name"></span><span class="uq-bar"><i></i></span><span class="uq-state">waiting</span>`;
  row.querySelector(".uq-name").textContent = name;
  $("#queue").appendChild(row);
  return {
    progress(p) {
      row.querySelector(".uq-bar i").style.width = Math.round(p * 100) + "%";
      row.querySelector(".uq-state").textContent = Math.round(p * 100) + "%";
    },
    done(text = "uploaded") {
      row.classList.add("done");
      row.querySelector(".uq-bar i").style.width = "100%";
      row.querySelector(".uq-state").textContent = text;
      setTimeout(() => row.remove(), 6000);
    },
    fail(text = "failed") {
      row.classList.add("error");
      row.querySelector(".uq-state").textContent = text;
    }
  };
}

async function addFiles(files) {
  if (MODE !== "local") {
    $("#dzNote").textContent =
      "No local server detected — files will be uploaded when you press “Publish to GitHub”. For instant disk uploads, run “npm start” and open http://localhost:4321/studio.html";
  }
  for (const file of files) {
    if (!file.type.startsWith("video/") && !/\.(mp4|webm|mov|m4v)$/i.test(file.name)) {
      toast(`${file.name} is not a video`, true);
      continue;
    }
    const ext = "." + (file.name.split(".").pop() || "mp4").toLowerCase().replace("mov", "mp4");
    const base = slug(file.name);
    const src = uniquePath("videos", base, ext);
    const posterPath = uniquePath("images", base, ".jpg");

    const entry = {
      id: uid(),
      title: prettify(file.name),
      type: "film",
      category: "",
      year: String(new Date().getFullYear()),
      client: "",
      src,
      poster: "",
      featured: false
    };

    const row = queueRow(file.name);
    try {
      if (MODE === "local") {
        row.progress(0.02);
        await putFile(src, file, (p) => row.progress(p * 0.96));
        row.progress(1);
        D.videos.unshift(entry);
        renderVideos();
        scheduleSave();
        row.done();

        const meta = await probe(file);
        if (meta.height > meta.width) entry.type = "reel"; // vertical clips become reels
        if (meta.poster) {
          await putFile(posterPath, meta.poster);
          entry.poster = posterPath;
        }
      } else {
        pending.set(src, file);
        D.videos.unshift(entry);
        const meta = await probe(file);
        if (meta.height > meta.width) entry.type = "reel";
        if (meta.poster) {
          pending.set(posterPath, meta.poster);
          entry.poster = posterPath;
        }
        row.done("queued");
      }
      renderVideos();
      scheduleSave();
    } catch (err) {
      row.fail("failed");
      toast(`${file.name}: ${err.message}`, true);
    }
  }
}

/* ---------------- video list ---------------- */
function renderVideos() {
  $("#videoCount").textContent = D.videos.length;
  const list = $("#vlist");
  if (!D.videos.length) {
    list.innerHTML = `<div class="emptylist">No videos yet. Drop a file above, or add one by link.<br />Mark a video as “Reel” to show it in the vertical Reels strip.</div>`;
    return;
  }
  list.innerHTML = D.videos
    .map(
      (v, i) => `
    <div class="vrow" data-id="${v.id}">
      <div class="vthumb${v.type === "reel" ? " is-reel" : ""}" data-play="${v.id}" title="Preview">
        ${v.poster ? `<img src="${esc(v.poster)}" alt="" />` : `<span class="noposter">▶</span>`}
        <span class="badge">${v.type === "reel" ? "reel" : "film"}</span>
      </div>
      <div class="vfields">
        <input class="title" data-field="title" value="${esc(v.title)}" placeholder="Video title" />
        <div class="vmeta">
          <input data-field="category" value="${esc(v.category)}" placeholder="Category (e.g. Wedding)" />
          <input data-field="client" value="${esc(v.client)}" placeholder="Client" />
          <input data-field="year" value="${esc(v.year)}" placeholder="Year" />
        </div>
        <div class="vmeta">
          <select data-field="type">
            <option value="film"${v.type === "film" ? " selected" : ""}>Film / horizontal</option>
            <option value="reel"${v.type === "reel" ? " selected" : ""}>Reel / vertical</option>
          </select>
          <input data-field="src" value="${esc(v.src)}" placeholder="video file or link" />
          <label class="check" style="font-size:12px"><input type="checkbox" data-field="featured"${v.featured ? " checked" : ""} /> Feature</label>
        </div>
      </div>
      <div class="vrow-actions">
        <button class="iconbtn" data-move="-1" title="Move up"${i === 0 ? " disabled" : ""}>↑</button>
        <button class="iconbtn" data-move="1" title="Move down"${i === D.videos.length - 1 ? " disabled" : ""}>↓</button>
        <button class="iconbtn${v.featured ? " starred" : ""}" data-feature title="Feature on the grid">★</button>
        <button class="iconbtn danger" data-delete title="Delete">✕</button>
      </div>
    </div>`
    )
    .join("");
}

function bindVideos() {
  const dz = $("#dropzone");
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("is-over");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === "dragleave" && dz.contains(e.relatedTarget)) return;
      dz.classList.remove("is-over");
    })
  );
  dz.addEventListener("drop", (e) => addFiles([...e.dataTransfer.files]));
  $("#fileInput").addEventListener("change", (e) => {
    addFiles([...e.target.files]);
    e.target.value = "";
  });

  $("#addUrlBtn").addEventListener("click", () => {
    const url = $("#urlInput").value.trim();
    if (!url) return;
    D.videos.unshift({
      id: uid(),
      title: prettify(url.split("/").pop() || "New video"),
      type: "film",
      category: "",
      year: String(new Date().getFullYear()),
      client: "",
      src: url,
      poster: "",
      featured: false
    });
    $("#urlInput").value = "";
    renderVideos();
    scheduleSave();
    toast("Link added — set a title and category");
  });

  $("#vlist").addEventListener("input", (e) => {
    const row = e.target.closest(".vrow");
    const field = e.target.dataset.field;
    if (!row || !field) return;
    const v = D.videos.find((x) => x.id === row.dataset.id);
    if (!v) return;
    v[field] = field === "featured" ? e.target.checked : e.target.value;
    scheduleSave();
  });
  $("#vlist").addEventListener("change", (e) => {
    const row = e.target.closest(".vrow");
    const field = e.target.dataset.field;
    if (!row || !field) return;
    const v = D.videos.find((x) => x.id === row.dataset.id);
    if (!v) return;
    v[field] = field === "featured" ? e.target.checked : e.target.value;
    if (field === "type" || field === "featured") renderVideos();
    scheduleSave();
  });

  $("#vlist").addEventListener("click", (e) => {
    const row = e.target.closest(".vrow");
    if (!row) return;
    const id = row.dataset.id;
    const idx = D.videos.findIndex((x) => x.id === id);
    if (idx < 0) return;

    if (e.target.closest("[data-play]")) return preview(D.videos[idx]);

    const move = e.target.closest("[data-move]");
    if (move) {
      const to = idx + Number(move.dataset.move);
      if (to < 0 || to >= D.videos.length) return;
      const [item] = D.videos.splice(idx, 1);
      D.videos.splice(to, 0, item);
      renderVideos();
      scheduleSave();
      return;
    }

    if (e.target.closest("[data-feature]")) {
      D.videos[idx].featured = !D.videos[idx].featured;
      renderVideos();
      scheduleSave();
      return;
    }

    if (e.target.closest("[data-delete]")) {
      const v = D.videos[idx];
      if (!confirm(`Remove “${v.title}” from the site?`)) return;
      D.videos.splice(idx, 1);
      if (MODE === "local" && v.src && v.src.startsWith("videos/")) {
        fetch("api/file?path=" + encodeURIComponent(v.src), { method: "DELETE" }).catch(() => {});
      }
      renderVideos();
      scheduleSave();
      return;
    }
  });
}

function preview(v) {
  if (!v.src) return toast("No video file or link yet", true);
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<button class="lb-close" aria-label="Close">✕</button>
    <figure class="lb-stage"><video src="${esc(v.src)}" controls autoplay playsinline style="max-height:78vh;margin:0 auto;border-radius:14px"></video>
    <figcaption><strong>${esc(v.title)}</strong><span>${esc([v.client, v.category, v.year].filter(Boolean).join(" · "))}</span></figcaption></figure>`;
  document.body.appendChild(box);
  const close = () => box.remove();
  box.querySelector(".lb-close").addEventListener("click", close);
  box.addEventListener("click", (e) => {
    if (e.target === box) close();
  });
}

/* ---------------- GitHub publish ---------------- */
function ghConfig() {
  return {
    token: $("#ghToken").value.trim(),
    owner: $("#ghOwner").value.trim(),
    repo: $("#ghRepo").value.trim(),
    branch: ($("#ghBranch").value.trim() || "main"),
    path: $("#ghPath").value.trim().replace(/^\/+|\/+$/g, "")
  };
}

function saveGhConfig() {
  const c = ghConfig();
  localStorage.setItem(LS_GH, JSON.stringify(c));
}

async function ghApi(cfg, path, options = {}) {
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(options.headers || {})
    }
  });
  return res;
}

function fileToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(new Error("could not read file"));
    r.readAsDataURL(blob);
  });
}

async function ghPut(cfg, path, blobOrText, message) {
  const isText = typeof blobOrText === "string";
  const content = isText ? btoa(unescape(encodeURIComponent(blobOrText))) : await fileToBase64(blobOrText);
  const full = cfg.path ? `${cfg.path}/${path}` : path;
  const body = { message, content, branch: cfg.branch };

  let res = await ghApi(cfg, full, { method: "PUT", body: JSON.stringify(body) });
  if (res.status === 422 || res.status === 409) {
    const head = await ghApi(cfg, `${full}?ref=${encodeURIComponent(cfg.branch)}`);
    if (head.ok) {
      const meta = await head.json();
      body.sha = meta.sha;
      res = await ghApi(cfg, full, { method: "PUT", body: JSON.stringify(body) });
    }
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${path}: ${res.status} ${txt.slice(0, 160)}`);
  }
}

async function publishGitHub() {
  const cfg = ghConfig();
  if (!cfg.token || !cfg.owner || !cfg.repo) {
    toast("Fill in token, owner and repo first", true);
    return;
  }
  saveGhConfig();
  const btn = $("#ghPublish");
  btn.disabled = true;
  $("#ghlog").innerHTML = "";
  log(`Publishing to ${cfg.owner}/${cfg.repo} (${cfg.branch})…`);

  try {
    await saveToDisk();

    log("→ site files");
    for (const f of CORE_FILES) {
      const res = await fetch(f, { cache: "no-store" });
      if (!res.ok) {
        log(`  skip ${f} (not found)`, "err");
        continue;
      }
      const text = await res.text();
      try {
        await ghPut(cfg, f, text, `Update ${f}`);
        log(`  ✓ ${f}`, "ok");
      } catch (err) {
        log(`  ✗ ${err.message}`, "err");
      }
    }

    if (pending.size) {
      log(`→ ${pending.size} media file(s)`);
      for (const [path, blob] of pending) {
        const mb = (blob.size / 1048576).toFixed(1);
        if (blob.size > 95 * 1048576) {
          log(`  ✗ ${path} is ${mb} MB — GitHub rejects files over 100 MB, compress it first`, "err");
          continue;
        }
        try {
          await ghPut(cfg, path, blob, `Add ${path}`);
          log(`  ✓ ${path} (${mb} MB)`, "ok");
        } catch (err) {
          log(`  ✗ ${err.message}`, "err");
        }
      }
    }

    log("→ data.json");
    await ghPut(cfg, "data.json", payload(), "Update portfolio content");
    log("  ✓ data.json", "ok");
    pending.clear();

    try {
      const pages = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/pages`, {
        headers: { authorization: `Bearer ${cfg.token}`, accept: "application/vnd.github+json" }
      });
      if (pages.status === 404) {
        log("→ enabling GitHub Pages…");
        const created = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/pages`, {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.token}`, accept: "application/vnd.github+json" },
          body: JSON.stringify({ source: { branch: cfg.branch, path: cfg.path ? `/${cfg.path}` : "/" } })
        });
        log(created.ok ? "  ✓ Pages enabled" : "  ! enable Pages manually: Settings → Pages", created.ok ? "ok" : "err");
      }
    } catch {
      /* non-fatal */
    }

    log("");
    log(`Live in ~1 minute: https://${cfg.owner}.github.io/${cfg.repo}/${cfg.path ? cfg.path + "/" : ""}`, "ok");
    toast("Published ✓");
  } catch (err) {
    log(`✗ ${err.message}`, "err");
    toast("Publish failed: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- wiring ---------------- */
function bindTabs() {
  $$(".stab").forEach((tab) =>
    tab.addEventListener("click", () => {
      $$(".stab").forEach((t) => t.classList.toggle("is-active", t === tab));
      $$(".spanel").forEach((p) => p.classList.toggle("is-active", p.id === "tab-" + tab.dataset.tab));
      location.hash = tab.dataset.tab;
    })
  );
  const initial = location.hash.replace("#", "");
  if (["brand", "videos", "publish"].includes(initial)) {
    document.querySelector(`.stab[data-tab="${initial}"]`)?.click();
  }
}

function bindPublish() {
  const save = () => saveToDisk(true);
  $("#saveBtn").addEventListener("click", save);
  $("#saveBtn2").addEventListener("click", save);

  $("#exportBtn").addEventListener("click", () => {
    const blob = new Blob([payload()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "data.json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("data.json downloaded");
  });

  $("#ghPublish").addEventListener("click", publishGitHub);
  ["ghToken", "ghOwner", "ghRepo", "ghBranch", "ghPath"].forEach((id) =>
    $("#" + id).addEventListener("change", saveGhConfig)
  );
}

async function detectMode() {
  try {
    const res = await fetch("api/health", { cache: "no-store" });
    const type = res.headers.get("content-type") || "";
    if (res.ok && type.includes("application/json")) {
      const health = await res.json();
      if (!health || health.ok !== true) throw new Error("no local server");
      MODE = "local";
      const badge = $("#modeBadge");
      badge.textContent = "local server";
      badge.className = "mode local";
      $("#saveExplain").textContent =
        "You are running the local studio server: uploads are written straight into the videos/ and images/ folders and data.json is saved on disk. Copy the folder to your host (or push it) when you are done.";
      return;
    }
  } catch {
    /* no server */
  }
  MODE = "static";
  const badge = $("#modeBadge");
  badge.textContent = "static site";
  badge.className = "mode static";
  $("#saveExplain").textContent =
    "No local server: changes are kept in this browser. Press “Publish to GitHub” to make them live, or download data.json and upload it to your host.";
}

(async function boot() {
  bindTabs();
  bindPublish();
  await detectMode();
  D = await loadData();
  if (!D.site.name) D.site.name = "Your Name";
  fillBrand();
  bindBrand();
  renderVideos();
  bindVideos();

  const cfg = JSON.parse(localStorage.getItem(LS_GH) || "{}");
  if (cfg.token) $("#ghToken").value = cfg.token;
  if (cfg.owner) $("#ghOwner").value = cfg.owner;
  if (cfg.repo) $("#ghRepo").value = cfg.repo;
  if (cfg.branch) $("#ghBranch").value = cfg.branch;
  if (cfg.path) $("#ghPath").value = cfg.path;

  if (MODE === "static") {
    $("#dzNote").textContent = "Tip: run “npm start” in the site folder to upload files straight to disk.";
  }
})();
