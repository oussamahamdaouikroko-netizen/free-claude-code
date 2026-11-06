/* Public portfolio — reads data.json (or a local draft from the studio). */
const DRAFT_KEY = "vp-draft";
const SOURCE = new URLSearchParams(location.search).has("draft") ? "draft" : "file";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let state = { site: {}, videos: [] };
let visible = [];
let activeFilter = "All";
let currentIndex = -1;

function initials(name) {
  return String(name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || "")
    .join("")
    .toUpperCase() || "?";
}

async function loadData() {
  if (SOURCE === "draft") {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return JSON.parse(raw);
  }
  const res = await fetch("data.json", { cache: "no-store" });
  if (!res.ok) throw new Error("data.json not found");
  return res.json();
}

function applyTheme(site) {
  if (site.accent) {
    document.documentElement.style.setProperty("--accent", site.accent);
    document.documentElement.style.setProperty("--accent-ink", pickInk(site.accent));
  }
  document.title = `${site.name || "Video Portfolio"} — ${site.role || "Video"}`;

  const logo = $("#brandLogo");
  logo.innerHTML = site.logo
    ? `<img src="${esc(site.logo)}" alt="" />`
    : esc(initials(site.name));

  const set = (sel, value) => {
    const el = $(sel);
    if (el) el.textContent = value || "";
  };
  set("#brandName", site.name);
  set("#footerName", `© ${new Date().getFullYear()} ${site.name || ""}`.trim());
  set("#heroName", site.name);
  set("#heroRole", site.role);
  set("#heroTagline", site.tagline);
  set("#heroLocation", site.location);
  set("#aboutBio", site.bio);
  set("#contactMail", site.email);

  const mail = $("#contactMail");
  if (site.email) mail.href = `mailto:${site.email}`;

  const socials = $("#socials");
  socials.innerHTML = (site.socials || [])
    .filter((s) => s.label && s.url)
    .map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)} ↗</a></li>`)
    .join("");

  const facts = [];
  if (site.role) facts.push(["Focus", site.role]);
  if (site.location) facts.push(["Based in", site.location]);
  if (site.clients) facts.push(["Worked with", site.clients]);
  if (site.gear) facts.push(["Gear", site.gear]);
  facts.push(["Films", String(state.videos.filter((v) => v.type !== "reel").length)]);
  facts.push(["Reels", String(state.videos.filter((v) => v.type === "reel").length)]);
  $("#facts").innerHTML = facts.map(([k, v]) => `<li><span>${esc(k)}</span><span>${esc(v)}</span></li>`).join("");

  const films = state.videos.filter((v) => v.type !== "reel").length + state.videos.filter((v) => v.type === "reel").length;
  $("#heroCount").textContent = `${films} ${films === 1 ? "piece" : "pieces"}`;
}

function pickInk(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return "#120604";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.62 ? "#101012" : "#ffffff";
}

function posterFor(video) {
  if (video.poster) return `<img src="${esc(video.poster)}" alt="${esc(video.title)}" loading="lazy" />`;
  return `<div class="poster-fallback" style="width:100%;height:100%;display:grid;place-items:center;background:linear-gradient(150deg,#1b1b20,#0d0d10);font-size:2rem;color:#3a3a42">▶</div>`;
}

function renderReels() {
  const reels = state.videos.filter((v) => v.type === "reel");
  const section = $("#reels");
  const navReel = document.querySelector('[data-if="reels"]');
  if (!reels.length || state.site.showReels === false) {
    section.hidden = true;
    if (navReel) navReel.hidden = true;
    return;
  }
  if (navReel) navReel.hidden = false;
  section.hidden = false;
  $("#reelTrack").innerHTML = reels
    .map(
      (v) => `
      <article class="reel" role="listitem" data-id="${esc(v.id)}" tabindex="0">
        ${posterFor(v)}
        <span class="play-badge">▶</span>
        <div class="reel-info">
          <strong>${esc(v.title)}</strong>
          <span>${esc(v.client || v.category || "Reel")}</span>
        </div>
      </article>`
    )
    .join("");
}

function renderFilters() {
  const cats = ["All", ...new Set(state.videos.filter((v) => v.type !== "reel").map((v) => v.category).filter(Boolean))];
  const box = $("#filters");
  box.innerHTML =
    cats.length > 2
      ? cats.map((c) => `<button class="chip${c === activeFilter ? " is-active" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("")
      : "";
}

function renderGrid() {
  const films = state.videos.filter((v) => v.type !== "reel");
  visible = activeFilter === "All" ? films : films.filter((v) => v.category === activeFilter);
  const grid = $("#grid");

  if (!state.videos.length) {
    grid.innerHTML = `<div class="empty">
      <strong>No videos yet.</strong>
      Open <a href="studio.html">the studio</a> to add your first video.
    </div>`;
    return;
  }
  if (!visible.length) {
    grid.innerHTML = `<div class="empty"><strong>Nothing here yet.</strong>Try another category.</div>`;
    return;
  }

  grid.innerHTML = visible
    .map(
      (v, i) => `
      <article class="card${v.featured && i === 0 ? " wide" : ""}" data-id="${esc(v.id)}" tabindex="0">
        ${posterFor(v)}
        <div class="card-body">
          <div>
            <div class="card-title">${esc(v.title)}</div>
            <div class="card-meta">${esc([v.category, v.year].filter(Boolean).join(" · "))}</div>
          </div>
          <span class="card-play">▶</span>
        </div>
      </article>`
    )
    .join("");
}

/* ---------------- lightbox ---------------- */
function openVideo(id) {
  const list = state.videos;
  currentIndex = list.findIndex((v) => v.id === id);
  if (currentIndex < 0) return;
  const v = list[currentIndex];
  const box = $("#lightbox");
  const vid = $("#lbVideo");
  vid.src = v.src || "";
  vid.poster = v.poster || "";
  if (v.type === "reel") {
    vid.style.maxHeight = "82vh";
    vid.style.maxWidth = "min(430px, 92vw)";
    vid.style.margin = "0 auto";
    vid.style.aspectRatio = "9 / 16";
  } else {
    vid.style.maxHeight = "76vh";
    vid.style.maxWidth = "100%";
    vid.style.margin = "0 auto";
    vid.style.aspectRatio = "16 / 9";
  }
  $("#lbTitle").textContent = v.title;
  $("#lbMeta").textContent = [v.client, v.category, v.year].filter(Boolean).join(" · ");
  box.hidden = false;
  document.body.style.overflow = "hidden";
  vid.play().catch(() => {});
  window._lbList = list;
}

function closeVideo() {
  const vid = $("#lbVideo");
  vid.pause();
  vid.removeAttribute("src");
  $("#lightbox").hidden = true;
  document.body.style.overflow = "";
}

function step(dir) {
  const list = window._lbList || [];
  if (!list.length) return;
  currentIndex = (currentIndex + dir + list.length) % list.length;
  openVideo(list[currentIndex].id);
}

/* ---------------- wire up ---------------- */
function bind() {
  document.addEventListener("click", (e) => {
    const card = e.target.closest(".card, .reel");
    if (card) return openVideo(card.dataset.id);

    const chip = e.target.closest(".chip");
    if (chip) {
      activeFilter = chip.dataset.cat;
      renderFilters();
      renderGrid();
      return;
    }
    if (e.target.id === "lightbox") closeVideo();
  });

  $("#lbClose").addEventListener("click", closeVideo);
  $("#lbPrev").addEventListener("click", () => step(-1));
  $("#lbNext").addEventListener("click", () => step(1));

  document.addEventListener("keydown", (e) => {
    if ($("#lightbox").hidden) return;
    if (e.key === "Escape") closeVideo();
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const card = e.target.closest?.(".card, .reel");
    if (card) openVideo(card.dataset.id);
  });

  const nav = $("#nav");
  const onScroll = () => nav.classList.toggle("is-stuck", window.scrollY > 12);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

(async function init() {
  try {
    state = await loadData();
  } catch (err) {
    console.error(err);
    state = { site: { name: "Your Name" }, videos: [] };
  }
  state.videos = (state.videos || []).filter((v) => v && v.title);
  applyTheme(state.site || {});
  renderReels();
  renderFilters();
  renderGrid();
  bind();

  if (location.hash.startsWith("#watch=")) openVideo(location.hash.slice(7));
})();
