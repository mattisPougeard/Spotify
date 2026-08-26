(() => {
  "use strict";

  const grid = document.getElementById("grid");
  const emptyState = document.getElementById("empty-state");
  const searchInput = document.getElementById("search");
  const loginLink = document.getElementById("login-link");
  const generateBtn = document.getElementById("generate-playlists");
  const loader = document.getElementById("loader");
  const result = document.getElementById("result");

  const audio = document.getElementById("audio");
  const playerTitle = document.getElementById("player-title");
  const playerArtist = document.getElementById("player-artist");
  const playerCover = document.getElementById("player-cover");
  const playerToggle = document.getElementById("player-toggle");
  const volumeSlider = document.getElementById("volume");

  // Headphone logo (same as the favicon) used wherever there's no cover art:
  // idle player, and any track missing/failing to load its artwork.
  const PLACEHOLDER_COVER =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<rect width="100" height="100" rx="16" fill="#181818"/>' +
      '<text x="50" y="62" font-size="46" text-anchor="middle">🎧</text>' +
      "</svg>"
    );

  let allTracks = [];
  let currentPlayingCard = null;
  let currentTrackKey = null;
  const previewCache = new Map();

  audio.volume = 0.5;
  volumeSlider.addEventListener("input", () => {
    audio.volume = Number(volumeSlider.value);
  });

  function resetPlayer() {
    playerCover.src = PLACEHOLDER_COVER;
    playerCover.alt = "";
    playerCover.classList.add("placeholder");
    playerTitle.textContent = "Aucune lecture en cours";
    playerArtist.textContent = "Sélectionnez un morceau";
    playerToggle.textContent = "▶";
  }

  resetPlayer();

  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function trackKey(track) {
    return `${track.name}::${track.artists[0]?.name || ""}`.toLowerCase();
  }

  // --- Rendering ------------------------------------------------------

  function renderTracks(tracks) {
    grid.innerHTML = "";
    emptyState.hidden = tracks.length > 0;
    if (tracks.length === 0) return;

    const fragment = document.createDocumentFragment();

    tracks.forEach(track => {
      const artists = track.artists.map(a => a.name).join(", ");
      // images[0] is the largest artwork Spotify returns — pick that one,
      // not the last (smallest/blurry) entry in the array.
      const cover = track.album.images[0]?.url || PLACEHOLDER_COVER;

      const card = document.createElement("div");
      card.className = "card";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `Écouter ${track.name} par ${artists}`);
      if (trackKey(track) === currentTrackKey) card.classList.add("playing");

      const img = document.createElement("img");
      img.src = cover;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", () => { img.src = PLACEHOLDER_COVER; }, { once: true });

      const overlay = document.createElement("div");
      overlay.className = "overlay";
      overlay.innerHTML = `
        <div class="title"></div>
        <div class="artist"></div>
      `;
      overlay.querySelector(".title").textContent = track.name;
      overlay.querySelector(".artist").textContent = artists;

      card.append(img, overlay);
      card.addEventListener("click", () => playTrack(track, card));
      card.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          playTrack(track, card);
        }
      });

      fragment.appendChild(card);
    });

    grid.appendChild(fragment);
  }

  function applyFilter(query) {
    const q = query.trim().toLowerCase();
    if (!q) return renderTracks(allTracks);

    const filtered = allTracks.filter(track => {
      const artists = track.artists.map(a => a.name).join(" ").toLowerCase();
      return track.name.toLowerCase().includes(q) || artists.includes(q);
    });
    renderTracks(filtered);
  }

  searchInput.addEventListener("input", debounce(e => applyFilter(e.target.value), 150));

  // --- Playlist loading -------------------------------------------------

  async function loadPlaylist() {
    grid.innerHTML = `<p class="empty-state">Chargement de la playlist…</p>`;
    emptyState.hidden = true;

    try {
      const res = await fetch("/playlist");

      if (res.status === 401) {
        grid.innerHTML = "";
        loginLink.hidden = false;
        emptyState.hidden = false;
        emptyState.textContent = "Connectez-vous à Spotify pour voir votre playlist.";
        return;
      }

      const data = await res.json();
      if (!data.items) {
        grid.innerHTML = "";
        emptyState.hidden = false;
        emptyState.textContent = "Impossible de charger la playlist.";
        return;
      }

      allTracks = data.items.map(item => item.track).filter(Boolean);
      renderTracks(allTracks);
    } catch (err) {
      grid.innerHTML = "";
      emptyState.hidden = false;
      emptyState.textContent = "Erreur réseau lors du chargement de la playlist.";
      console.error(err);
    }
  }

  // --- Playback -----------------------------------------------------

  async function playTrack(track, card) {
    const key = trackKey(track);

    // Same track clicked again → toggle play/pause instead of refetching.
    if (key === currentTrackKey && audio.src) {
      togglePlayback();
      return;
    }

    if (currentPlayingCard) currentPlayingCard.classList.remove("playing");
    card.classList.add("playing", "loading");
    currentPlayingCard = card;
    currentTrackKey = key;

    playerTitle.textContent = track.name;
    playerArtist.textContent = track.artists.map(a => a.name).join(", ");
    playerCover.src = track.album.images[0]?.url || PLACEHOLDER_COVER;
    playerCover.alt = `Pochette de ${track.name}`;
    playerCover.classList.remove("placeholder");
    playerCover.addEventListener("error", () => { playerCover.src = PLACEHOLDER_COVER; }, { once: true });

    try {
      let data = previewCache.get(key);
      if (!data) {
        const res = await fetch(
          `/deezer/preview?title=${encodeURIComponent(track.name)}&artist=${encodeURIComponent(track.artists[0].name)}`
        );
        if (!res.ok) throw new Error("preview_not_found");
        data = await res.json();
        previewCache.set(key, data);
      }

      audio.src = data.preview;
      await audio.play();
      playerToggle.textContent = "⏸";
    } catch (err) {
      card.classList.remove("playing");
      currentPlayingCard = null;
      currentTrackKey = null;
      resetPlayer();
      console.error(err);
      showTransientMessage("Preview non trouvée sur Deezer pour ce morceau.");
    } finally {
      card.classList.remove("loading");
    }
  }

  function togglePlayback() {
    if (audio.paused) {
      audio.play();
      playerToggle.textContent = "⏸";
    } else {
      audio.pause();
      playerToggle.textContent = "▶";
    }
  }

  playerToggle.addEventListener("click", togglePlayback);
  audio.addEventListener("ended", () => {
    if (currentPlayingCard) currentPlayingCard.classList.remove("playing");
    currentPlayingCard = null;
    currentTrackKey = null;
    resetPlayer();
  });

  function showTransientMessage(msg) {
    result.textContent = msg;
    setTimeout(() => { if (result.textContent === msg) result.textContent = ""; }, 4000);
  }

  // --- Smart playlist generation ----------------------------------------

  const loaderLabel = loader.querySelector(".loader-text");
  const GENERATE_TIMEOUT_MS = 3 * 60 * 1000; // this endpoint makes many Spotify calls; a big library can take a while

  generateBtn.addEventListener("click", async () => {
    loader.hidden = false;
    result.innerHTML = "";
    generateBtn.disabled = true;

    const startedAt = Date.now();
    const tick = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      loaderLabel.textContent = `Génération en cours… (${elapsed}s, peut prendre quelques minutes pour une grande bibliothèque)`;
    }, 1000);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);

    try {
      const res = await fetch("/generate-smart-playlists", { signal: controller.signal });

      if (res.status === 401) {
        loginLink.hidden = false;
        showTransientMessage("Connectez-vous à Spotify pour générer les playlists.");
        return;
      }

      const data = await res.json();

      if (data.status === "ok") {
        const items = Object.entries(data.playlists)
          .map(([cat, count]) => `<li>${escapeHtml(cat)}: ${count} morceaux</li>`)
          .join("");
        result.innerHTML = `<h3>Playlists générées :</h3><ul>${items}</ul>`;
      } else {
        result.textContent = data.error || "Une erreur est survenue.";
      }
    } catch (err) {
      result.textContent = err.name === "AbortError"
        ? "La génération prend trop de temps et a été interrompue. Réessayez, ou vérifiez la console serveur."
        : "Erreur: " + err.message;
      console.error(err);
    } finally {
      clearInterval(tick);
      clearTimeout(timeout);
      loaderLabel.textContent = "Génération en cours…";
      loader.hidden = true;
      generateBtn.disabled = false;
    }
  });

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  loadPlaylist();
})();
