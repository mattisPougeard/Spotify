const grid = document.getElementById("grid");
const audio = document.getElementById("audio");
const playerTitle = document.getElementById("player-title");
const playerArtist = document.getElementById("player-artist");
const playerCover = document.getElementById("player-cover");

let currentPlayingCard = null;

document.getElementById("generate-playlists").addEventListener("click", async () => {
    const loader = document.getElementById("loader");
    const result = document.getElementById("result");
    loader.style.display = "block";
    result.innerHTML = "";
  
    try {
      const res = await fetch("/generate-smart-playlists");
      const data = await res.json();
      loader.style.display = "none";
  
      if (data.status === "ok") {
        let html = "<h3>Playlists générées :</h3><ul>";
        for (const [cat, count] of Object.entries(data.playlists)) {
          html += `<li>${cat}: ${count} tracks</li>`;
        }
        html += "</ul>";
        result.innerHTML = html;
      } else {
        result.innerHTML = JSON.stringify(data);
      }
    } catch (err) {
      loader.style.display = "none";
      result.innerHTML = "Erreur: " + err;
    }
  });
  

async function loadPlaylist() {
  const res = await fetch("/playlist");
  if (res.status === 401) { window.location.href = "/login"; return; }

  const data = await res.json();
  if (!data.items) {
    grid.innerHTML = "<p style='text-align:center;'>Impossible de charger la playlist.</p>";
    return;
  }

  grid.innerHTML = "";

  data.items.forEach(item => {
    const track = item.track;
    if (!track) return;

    const card = document.createElement("div");
    card.className = "card";

    const artists = track.artists.map(a => a.name).join(", ");

    card.innerHTML = `
      <img src="${track.album.images[0]?.url || ''}" alt="${track.name}" />
      <div class="overlay">
        <div class="title">${track.name}</div>
        <div class="artist">${artists}</div>
      </div>
    `;

    card.onclick = () => playTrack(track, card);

    grid.appendChild(card);
  });
}

async function playTrack(track, card) {
  // glow sur la carte en lecture
  if (currentPlayingCard) currentPlayingCard.classList.remove("playing");
  card.classList.add("playing");
  currentPlayingCard = card;

  // mettre à jour mini-player
  playerTitle.textContent = track.name;
  playerArtist.textContent = track.artists.map(a=>a.name).join(", ");
  playerCover.src = track.album.images[0]?.url || '';

  // fetch preview Deezer
  const res = await fetch(`/deezer/preview?title=${encodeURIComponent(track.name)}&artist=${encodeURIComponent(track.artists[0].name)}`);
  if (!res.ok) { alert("Preview non trouvée sur Deezer"); return; }
  const data = await res.json();

  audio.src = data.preview;
  audio.play();
}

loadPlaylist();
