require("dotenv").config();
const express = require("express");
const session = require("express-session");

const fetch = require("node-fetch");
const cors = require("cors");
const qs = require("querystring");

const app = express();
app.use(cors());
app.use(express.static("public"));

app.use(session({
  secret: "spotify-secret",
  resave: false,
  saveUninitialized: false
}));

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI,
  PLAYLIST_ID,
  PORT
} = process.env;

let accessToken = null;
let refreshToken = null;

// --- Smart Playlist Generation ---
const GENRE_MAP = {
  "Rap / Hip-Hop": [
    "hip hop","rap","east coast hip hop","southern hip hop","g-funk","jazz rap","melodic rap","cloud rap",
    "french rap","french r&b","pop urbaine","rap ivoire","rap chrétien","german hip hop","moroccan rap",
    "punjabi hip hop","hindi hip hop","desi hip hop","italian trap"
  ],
  "Drill / Trap / Phonk": [
    "drill","brooklyn drill","new york drill","uk drill","uk grime","trap latino","argentine trap","phonk",
    "brazilian phonk","drift phonk","jersey club","philly club","dembow belico","corridos tumbados",
    "corridos bélicos","electro corridos"
  ],
  "Electro / Techno": [
    "house","tech house","french house","tribal house","melodic house","progressive house","slap house",
    "stutter house","tropical house","afro house","techno","melodic techno","minimal techno","hard techno",
    "hypertechno","edm","big room","future bass","future house","melbourne bounce","progressive trance",
    "trance","psytrance","hardcore","hardstyle","frenchcore","gabber","riddim","deathstep","dubstep",
    "electronica","electronic","nu disco","italo dance","italo disco"
  ],
  "Latino": [
    "reggaeton","reggaeton chileno","reggaeton mexa","urbano latino","latin","latin dance","latin house",
    "dembow","rkt","turreo","neoperreo","salsa","merengue","mambo","cumbia","música mexicana","banda",
    "sertanejo tradicional","sierreño","sad sierreño"
  ],
  "Afro": [
    "afrobeat","afrobeats","afro house","afro soul","afro r&b","afroswing","afropop","afrogospel",
    "coupé décalé","ndombolo","rumba congolaise","shatta","zouk","kompa","kuduro","gnawa","raï"
  ],
  "Rock": [
    "rock","classic rock","southern rock","j-rock","german indie","german indie pop","french indie pop",
    "alternative dance","new wave","new rave"
  ],
  "Pop": [
    "pop","soft pop","europop","moroccan pop","bangla pop","colombian pop","french pop","j-pop","mpb",
    "new mpb","bossa nova","acoustic pop"
  ],
  "Experimental": [
    "hyperpop","ambient folk","lo-fi beats","jazz beats","nu jazz","medieval","anime","electro swing",
    "swing music","flamenco","flamenco urbano","gospel","christian reggae"
  ]
};

// Helper pour mapper un genre → catégorie
function mapGenreToCategory(genre) {
  for (const [cat, genres] of Object.entries(GENRE_MAP)) {
    if (genres.includes(genre.toLowerCase())) return cat;
  }
  // fallback
  return "Experimental";
}

// --- Login / OAuth ---
app.get("/login", (req, res) => {
  const scope = "user-library-read playlist-modify-public playlist-modify-private";
  const url =
    "https://accounts.spotify.com/authorize" +
    "?client_id=" + SPOTIFY_CLIENT_ID +
    "&response_type=code" +
    "&redirect_uri=" + SPOTIFY_REDIRECT_URI + // <-- ici exactement comme Dashboard
    "&scope=" + scope;
  res.redirect(url);
});

// --- Callback Spotify ---
app.get("/callback", async (req, res) => {
  const code = req.query.code || null;
  if (!code) return res.send("No code provided");

  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(SPOTIFY_CLIENT_ID + ":" + SPOTIFY_CLIENT_SECRET).toString(
            "base64"
          ),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: qs.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI
      })
    });

    const data = await tokenRes.json();
    accessToken = data.access_token;
    refreshToken = data.refresh_token;
    req.session.access_token = data.access_token;

    res.redirect("/"); // redirection vers frontend
  } catch (err) {
    console.error(err);
    res.send("Erreur lors de l'échange du code");
  }
});

// --- Refresh token automatique ---
async function refreshAccessToken() {
  if (!refreshToken) return;

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(SPOTIFY_CLIENT_ID + ":" + SPOTIFY_CLIENT_SECRET).toString(
          "base64"
        ),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: qs.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });

  const data = await res.json();
  accessToken = data.access_token;
}

app.get("/scan-genres", async (req, res) => {
  try {
    const accessToken = req.session.access_token;
    console.log("SESSION:", req.session);

    if (!accessToken) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    let allTracks = [];
    let offset = 0;
    const limit = 50;

    // 1️⃣ Récupération complète des liked tracks (pagination)
    while (true) {
      const response = await fetch(
        `https://api.spotify.com/v1/me/tracks?limit=${limit}&offset=${offset}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        }
      );

      const data = await response.json();
      allTracks = allTracks.concat(data.items);

      if (data.items.length < limit) break;
      offset += limit;
    }

    // 2️⃣ Récupération des artistes uniques
    const artistIds = new Set();

    allTracks.forEach(item => {
      item.track.artists.forEach(artist => {
        artistIds.add(artist.id);
      });
    });

    const uniqueArtistIds = Array.from(artistIds);

    // 3️⃣ Récupération des genres par batch de 50 artistes
    let allGenres = new Set();

    for (let i = 0; i < uniqueArtistIds.length; i += 50) {
      const batch = uniqueArtistIds.slice(i, i + 50).join(",");

      const response = await fetch(
        `https://api.spotify.com/v1/artists?ids=${batch}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        }
      );

      const data = await response.json();

      data.artists.forEach(artist => {
        artist.genres.forEach(genre => {
          allGenres.add(genre);
        });
      });
    }

    res.json({
      totalTracks: allTracks.length,
      totalArtists: uniqueArtistIds.length,
      genres: Array.from(allGenres).sort()
    });

  } catch (err) {
    console.error("SCAN GENRES ERROR:", err);
    res.status(500).json({ 
      error: "Error scanning genres",
      details: err.message 
    });
  }
  
});

// --- Generate Smart Playlists ---
app.get("/generate-smart-playlists", async (req, res) => {
  try {
    const accessToken = req.session.access_token;
    if (!accessToken) return res.status(401).json({ error: "Not authenticated" });

    // 1️⃣ Récupère tous les liked tracks
    let allTracks = [];
    let offset = 0;
    const limit = 50;

    while (true) {
      const response = await fetch(`https://api.spotify.com/v1/me/tracks?limit=${limit}&offset=${offset}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      if (!response.ok) {
        const errText = await response.text();
        return res.status(response.status).json({ error: "Spotify API error (tracks)", details: errText });
      }

      const data = await response.json();
      if (!data.items) break;

      allTracks = allTracks.concat(data.items);
      if (data.items.length < limit) break;
      offset += limit;
    }

    // 2️⃣ Récupère tous les artistes uniques
    const artistIds = new Set();
    allTracks.forEach(item => item.track.artists.forEach(a => artistIds.add(a.id)));
    const uniqueArtistIds = Array.from(artistIds);

    // 3️⃣ Récupère les genres des artistes par batch
    const artistGenresMap = {}; // artistId → genres
    for (let i = 0; i < uniqueArtistIds.length; i += 50) {
      const batch = uniqueArtistIds.slice(i, i + 50).join(",");
      const r = await fetch(`https://api.spotify.com/v1/artists?ids=${batch}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const d = await r.json();
      d.artists.forEach(a => { artistGenresMap[a.id] = a.genres || []; });
      await new Promise(r => setTimeout(r, 150));
    }

    // 4️⃣ Mappe chaque track → catégorie principale
    const categorizedTracks = {}; // category → track ids
    for (const cat of Object.keys(GENRE_MAP)) categorizedTracks[cat] = [];

    allTracks.forEach(item => {
      const track = item.track;
      let trackCategories = new Set();
      track.artists.forEach(artist => {
        const genres = artistGenresMap[artist.id] || [];
        genres.forEach(g => trackCategories.add(mapGenreToCategory(g)));
      });
      // Si aucun genre → Experimental
      if (trackCategories.size === 0) trackCategories.add("Experimental");

      // Ajoute track à toutes les catégories correspondantes
      trackCategories.forEach(cat => categorizedTracks[cat].push(track.uri));
    });

    // 5️⃣ Crée / met à jour les playlists
    const meResp = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const meData = await meResp.json();
    const userId = meData.id;

    const results = {};

    for (const [cat, trackUris] of Object.entries(categorizedTracks)) {
      if (trackUris.length === 0) continue;

      // 5a️⃣ Vérifie si playlist existe déjà
      const playlistsResp = await fetch(`https://api.spotify.com/v1/me/playlists?limit=50`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const playlistsData = await playlistsResp.json();
      let playlist = playlistsData.items.find(p => p.name === `Liked - ${cat}`);

      // 5b️⃣ Crée si n'existe pas
      if (!playlist) {
        const createResp = await fetch(`https://api.spotify.com/v1/users/${userId}/playlists`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            name: `Liked - ${cat}`,
            public: false,
            description: `Tracks liked, categorized in ${cat}`
          })
        });
        playlist = await createResp.json();
      }

      // 5c️⃣ Vide la playlist existante
      const tracksInPlaylistResp = await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const tracksInPlaylistData = await tracksInPlaylistResp.json();
      const urisToRemove = tracksInPlaylistData.items.map(t => t.track.uri);
      if (urisToRemove.length > 0) {
        await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ tracks: urisToRemove.map(u => ({ uri: u })) })
        });
      }

      // 5d️⃣ Ajoute les tracks par batch de 100
      for (let i = 0; i < trackUris.length; i += 100) {
        const batch = trackUris.slice(i, i + 100);
        await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ uris: batch })
        });
      }

      results[cat] = trackUris.length;
    }

    res.json({ status: "ok", playlists: results });

  } catch (err) {
    console.error("Smart Playlist Error:", err);
    res.status(500).json({ error: "Smart Playlist Error", details: err.message });
  }
});

// --- Playlist Spotify ---
app.get("/playlist", async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: "Not logged in" });

  try {
    const response = await fetch(
      `https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/tracks`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    const data = await response.json();
    console.log("Data Spotify /playlist :", data); // <-- log ici

    if (data.error && data.error.status === 401) {
      await refreshAccessToken();
      return res.redirect("/playlist");
    }

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Spotify API error" });
  }
});

// --- Deezer preview ---
app.get("/deezer/preview", async (req, res) => {
  const { title, artist } = req.query;

  if (!title || !artist)
    return res.status(400).json({ error: "Missing title or artist" });

  try {
    const response = await fetch(
      `https://api.deezer.com/search?q=${encodeURIComponent(title + " " + artist)}`
    );
    const data = await response.json();
    const track = data.data?.find(t => t.preview);

    if (!track) return res.status(404).json({ error: "No preview found" });

    res.json({
      title: track.title,
      artist: track.artist.name,
      preview: track.preview,
      cover: track.album.cover_medium
    });
  } catch (err) {
    res.status(500).json({ error: "Deezer error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`Go to http://localhost:${PORT}/login to authenticate Spotify`);
});
