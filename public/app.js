const grid = document.getElementById("grid");
const audio = document.getElementById("audio");
const playerTitle = document.getElementById("player-title");
const playerArtist = document.getElementById("player-artist");
const playerCover = document.getElementById("player-cover");
const authStatus = document.getElementById("auth-status");
const generateBtn = document.getElementById("generate-playlists");
const loader = document.getElementById("loader");
const result = document.getElementById("result");

let currentPlayingCard = null;
let previewRequest = 0;

function setAuthUi(authenticated) {
  authStatus.textContent = authenticated ? "Connecté à Spotify" : "Non connecté";
  authStatus.classList.toggle("is-ok", authenticated);
  generateBtn.disabled = !authenticated;
}

function setLoader(visible, message = "Génération en cours…") {
  loader.hidden = !visible;
  loader.textContent = message;
}

function showMessage(target, text, isError = false) {
  target.replaceChildren();
  const p = document.createElement("p");
  p.className = isError ? "status-error" : "status-ok";
  p.textContent = text;
  target.appendChild(p);
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    setAuthUi(false);
  }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

generateBtn.addEventListener("click", async () => {
  generateBtn.disabled = true;
  setLoader(true);
  result.replaceChildren();

  try {
    const data = await fetchJson("/generate-smart-playlists");
    setLoader(false);

    if (data.status === "ok") {
      const heading = document.createElement("h3");
      heading.textContent = "Playlists générées :";
      const list = document.createElement("ul");
      for (const [cat, count] of Object.entries(data.playlists || {})) {
        const li = document.createElement("li");
        li.textContent = `${cat}: ${count} tracks`;
        list.appendChild(li);
      }
      result.replaceChildren(heading, list);
    } else {
      showMessage(result, "Réponse inattendue du serveur.", true);
    }
  } catch (err) {
    setLoader(false);
    if (err.status === 401) {
      showMessage(result, "Connecte-toi à Spotify pour générer les playlists.", true);
    } else {
      showMessage(result, err.message || "Erreur lors de la génération.", true);
    }
  } finally {
    generateBtn.disabled = !authStatus.classList.contains("is-ok");
  }
});

function createCard(track) {
  const card = document.createElement("div");
  card.className = "card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `Écouter ${track.name}`);

  const img = document.createElement("img");
  img.src = track.album?.images?.[0]?.url || "";
  img.alt = "";
  img.loading = "lazy";

  const overlay = document.createElement("div");
  overlay.className = "overlay";

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = track.name || "";

  const artist = document.createElement("div");
  artist.className = "artist";
  artist.textContent = (track.artists || []).map((a) => a.name).join(", ");

  overlay.append(title, artist);
  card.append(img, overlay);

  const play = () => playTrack(track, card);
  card.addEventListener("click", play);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      play();
    }
  });

  return card;
}

async function loadPlaylist() {
  showMessage(grid, "Chargement de la playlist…");

  try {
    const data = await fetchJson("/playlist");
    const items = data.items || [];
    grid.replaceChildren();

    if (!items.length) {
      showMessage(grid, "Aucun titre dans la playlist.");
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of items) {
      if (!item?.track) continue;
      fragment.appendChild(createCard(item.track));
    }
    grid.appendChild(fragment);
  } catch (err) {
    if (err.status === 401) {
      showMessage(grid, "Connecte-toi à Spotify pour afficher la playlist.", true);
      return;
    }
    showMessage(grid, "Impossible de charger la playlist.", true);
  }
}

async function playTrack(track, card) {
  if (currentPlayingCard) currentPlayingCard.classList.remove("playing");
  card.classList.add("playing");
  currentPlayingCard = card;

  const artistName = track.artists?.[0]?.name || "";
  playerTitle.textContent = track.name || "";
  playerArtist.textContent = (track.artists || []).map((a) => a.name).join(", ");
  playerCover.src = track.album?.images?.[0]?.url || "";
  playerCover.alt = track.name || "cover";

  const requestId = ++previewRequest;

  try {
    const params = new URLSearchParams({
      title: track.name || "",
      artist: artistName,
    });
    const data = await fetchJson(`/deezer/preview?${params.toString()}`);
    if (requestId !== previewRequest) return;
    audio.src = data.preview;
    await audio.play();
  } catch {
    if (requestId !== previewRequest) return;
    showMessage(result, "Preview introuvable sur Deezer.", true);
  }
}

async function init() {
  try {
    const status = await fetchJson("/auth/status");
    setAuthUi(status.authenticated);
  } catch {
    setAuthUi(false);
  }

  await loadPlaylist();
}

init();
