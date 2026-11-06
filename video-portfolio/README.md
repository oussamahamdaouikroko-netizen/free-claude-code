# 🎬 My Video Portfolio

A complete video portfolio you own: a cinematic public site **plus** a studio page where you
upload videos, mark them as **films or reels**, change your **name, logo and colours** — then put
it online **for free**.

No database, no monthly fees, no account required for the site itself.

---

## What's inside

| File / folder | What it is |
|---|---|
| `index.html` | The public site visitors see |
| `studio.html` | Your admin panel — brand, videos, publishing |
| `data.json` | All the content (name, links, video list) |
| `videos/` | Your video files |
| `images/` | Your logo + video thumbnails |
| `demo/` | 6 sample clips so the site looks alive — delete them when yours are in |
| `server.js` | Tiny local studio server (lets the Studio write files to disk) |
| `assets/` | CSS + JS |

Everything is plain HTML/CSS/JS. Any static host will run it, forever, free.

---

## 1. Change your name, logo and colours

Open **`studio.html`** → **Brand** tab:

- **Name** → your name or studio name
- **Logo** → upload a square PNG / SVG (transparent works great). If you upload nothing, the site
  shows your initials in a coloured square — that already looks clean.
- **Accent colour** → pick a swatch or a custom colour
- **Tagline, About, Email, Location, Clients, Gear**
- **Social links** → Instagram, YouTube, TikTok, WhatsApp…
- A **live preview** on the right updates as you type.

Press **Save** (or just keep typing — it autosaves).

---

## 2. Upload your videos

There are two ways, both from **Studio → Videos**:

### A. Upload real files (recommended) — run the studio on your computer

1. Install [Node.js](https://nodejs.org) (one time, free).
2. Open a terminal in this folder and run:

   ```bash
   npm start
   ```

3. Open <http://localhost:4321/studio.html>
4. Drag your `.mp4` / `.mov` / `.webm` files into the drop zone.

What happens automatically:

- the file is copied into `videos/`
- a **thumbnail is generated from the video** into `images/`
- vertical videos are detected and marked as **reel**, horizontal ones as **film**
- the title is guessed from the file name — edit it in the list
- `data.json` is updated on disk

The badge at the top says **local server** when this is working.

### B. Add by link

Paste a direct `.mp4` / `.webm` URL (your own hosting, a CDN, etc.) using **“Add link”**.
Useful for big files you host elsewhere.

### Films vs Reels

- **Film** → appears in the “Selected work” grid (horizontal, 16:9/16:10 cards).
- **Reel** → appears in the vertical **Reels** strip (9:16 cards, swipeable), like Instagram.

Toggle the type with the dropdown on each video. **★** marks a video as featured (it becomes the
large card). Turn the whole Reels section off with the switch in the Brand tab.

---

## 3. Put it online — free

Pick **one** of these. All are free and give you a `https://` address.

### Option A · GitHub Pages (recommended: free forever, re-deploy by pushing)

1. Create a GitHub account, then a **new repository** (public is fine), e.g. `my-portfolio`.
   Tick **“Add a README file”** so the repo is initialised.
2. Upload this folder's contents to that repo (drag & drop works on github.com → *Add file →
   Upload files*). Keep the structure: `index.html`, `studio.html`, `assets/`, `videos/`, `data.json`.
3. Repo → **Settings → Pages** → *Source*: **Deploy from a branch** → Branch: **main**, folder
   **/ (root)** → **Save**.
4. Wait ~1 minute → your site is at `https://YOUR-USERNAME.github.io/my-portfolio/`

> GitHub free limits: files up to 100 MB each, ~1 GB per repository, ~100 GB/month of views.
> For a portfolio that is plenty — but compress your videos (see tips below).

#### Publish without touching git again

`studio.html` can push to that repo straight from the browser:

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens →
   Generate new token**.
2. Repository access: **only** your portfolio repo. Permissions → **Contents: Read and write**.
3. In the Studio → **Publish** tab, paste the token + owner + repo name (+ branch `main`), press
   **Publish to GitHub**.

It uploads your new videos, thumbnails, `data.json` and the site files, then reminds you to check
Pages. The token stays in your browser only (localStorage) — never in the code.

### Option B · Netlify Drop (fastest, zero git)

Go to <https://app.netlify.com/drop> and drag this whole folder in. You get a live link in ~20
seconds. Drag again to update. Free plan: 100 GB bandwidth/month.

> Netlify Drop can't upload files for you in the browser (no server in static hosting) — do your
> uploads locally first (`npm start`) or use the GitHub publish option, then drop the folder.

### Option C · Cloudflare Pages

Create a free Cloudflare account → Pages → *Upload assets* → drag the folder. Also very fast, free.

### Custom domain (optional, not required)

All three hosts let you attach a domain you buy (~$10/year) under their settings. A free
`*.github.io`, `*.netlify.app` or `*.pages.dev` address works fine without one.

---

## Tips for fast, good-looking videos

- **Export for the web**: H.264 MP4, 1080p is plenty, audio AAC 128 kbps.
- **Aim for 5–30 MB per clip.** Bigger = slow site, even on a good host.
- Compress with [HandBrake](https://handbrake.fr) (free, GUI) or ffmpeg:

  ```bash
  # horizontal film, 1080p
  ffmpeg -i input.mov -vf "scale=1920:-2" -c:v libx264 -crf 23 -preset slow -c:a aac -b:a 128k output.mp4

  # vertical reel, 1080x1920
  ffmpeg -i input.mov -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" \
         -c:v libx264 -crf 23 -preset slow -c:a aac -b:a 128k output.mp4
  ```

- The thumbnail is taken from the first second — start your clips on a strong frame.
- Very long videos (full events, 30+ min) are better hosted on YouTube/Vimeo and linked; keep this
  site for the best 6–12 pieces.

---

## Removing the demo content

1. Studio → Videos → **✕** on each sample clip.
2. Add your own.
3. Optionally delete the `demo/` folder.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Studio says **static site** but I want uploads | Start the server: `npm start` in this folder, then open `http://localhost:4321/studio.html` (not the `file://` path). |
| Videos don't play after deploying | Check the file is inside `videos/` and the path in `data.json` matches exactly (case-sensitive on Linux hosts). |
| Publish to GitHub fails with 401/403 | Token missing **Contents: write**, or wrong owner/repo/branch. |
| Publish fails with 422 | The file exists — usually fixed by retrying; also initialise the repo with a README (empty repos reject uploads). |
| Page is a 404 on GitHub Pages | Settings → Pages: branch `main`, folder `/ (root)`, and wait a minute. |
| Logo not updating | Hard-refresh (Ctrl/Cmd + Shift + R) — the logo path includes a cache-busting suffix. |

---

## Editing content by hand

`data.json` is plain, readable JSON:

```json
{
  "site": { "name": "Your Name", "accent": "#ff5a3c", "logo": "images/logo.png" },
  "videos": [
    { "id": "a1", "title": "Dunes", "type": "film", "category": "Travel",
      "year": "2025", "client": "Personal", "src": "videos/dunes.mp4",
      "poster": "images/dunes.jpg", "featured": true }
  ]
}
```

`type` is `"film"` or `"reel"`. `featured: true` makes it the big card. `poster` can be empty — the
card then shows a plain placeholder.

---

Made to be boringly simple: static files, your videos, your name, no fees. 🎥
