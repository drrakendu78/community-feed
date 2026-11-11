// SPDX-FileCopyrightText: © 2026 Djamel Lazreg (drrakendu78) <https://djamellazreg.fr>
// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
//
// La liste des vaisseaux du flux (community-feed/vaisseaux/vaisseaux.json), tirée de la liste OFFICIELLE de RSI (la
// matrice des vaisseaux du site, publique, la même que lit SHIPSNATCHER). L'appli la télécharge à chaque démarrage
// (src-tauri/src/vaisseaux_feed.rs) : un vaisseau qui sort arrive dans le hangar sans mise à jour de l'appli.
//
// Tourne seul dans le dépôt du flux, deux fois par jour (.github/workflows/vaisseaux.yml) : il ne publie que si la liste a
// changé, et jamais une liste suspecte (moins de 150 vaisseaux, une page qui n'est pas du JSON…).
//
//   node generer.mjs [--sortie <fichier>]   en local : écrit le fichier (par défaut ./vaisseaux.json), rien d'autre
//   node generer.mjs --github                dans GitHub Actions : met à jour vaisseaux/vaisseaux.json par l'API GitHub
//                                            (GITHUB_TOKEN, GITHUB_REPOSITORY), puis vide le cache de jsDelivr
//
// Node ≥ 18, aucune dépendance.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MATRICE = 'https://robertsspaceindustries.com/ship-matrix/index';
const CHEMIN_FLUX = 'vaisseaux/vaisseaux.json';
const SCHEMA = 'stelliverse-vaisseaux/1';
const MINIMUM = 150;
const IMAGES = 'https://media.robertsspaceindustries.com/';
const AGENT = 'Mozilla/5.0 (compatible; community-feed vaisseaux)';

const args = process.argv.slice(2);
const val = (nom, defaut) => { const i = args.indexOf(nom); return i >= 0 && args[i + 1] ? args[i + 1] : defaut; };

async function lireJson(url, options = {}) {
  const r = await fetch(url, { ...options, headers: { 'User-Agent': AGENT, Accept: 'application/json', ...(options.headers || {}) }, signal: AbortSignal.timeout(60_000) });
  const texte = await r.text();
  if (!r.ok) throw new Error(`${url} : HTTP ${r.status} ${texte.slice(0, 200)}`);
  try { return JSON.parse(texte); } catch { throw new Error(`${url} : la réponse n'est pas du JSON (${texte.slice(0, 120).replace(/\s+/g, ' ')})`); }
}

const texte = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const nombre = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : null; };
const capitale = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

function image(v) {
  const u = String(v?.media?.[0]?.images?.store_small ?? '');
  return u.startsWith(IMAGES) && u.length <= 300 && !/["'<>\s]/.test(u) ? u : '';
}

// Une fiche de la matrice → les champs dont l'appli a besoin (noms et codes tels que RSI les écrit : ce sont aussi ceux
// de l'import du hangar RSI).
function fiche(v) {
  const taille = texte(v.size, 20).toLowerCase();
  const type = texte(v.type, 30).toLowerCase();
  return {
    name: texte(v.name, 80),
    maker: texte(v.manufacturer?.code, 10).toUpperCase(),
    focus: texte(v.focus, 80),
    type: capitale(type),
    size: capitale(taille === 'null' ? '' : taille),
    img: image(v),
    length: nombre(v.length, 3000),
    width: nombre(v.beam, 3000),
    height: nombre(v.height, 3000),
    mass: nombre(v.mass, 1e9),
    cargo: nombre(v.cargocapacity, 1e6),
    crewMin: nombre(v.min_crew, 500),
    crewMax: nombre(v.max_crew, 500),
    scm: nombre(v.scm_speed, 5000),
    boost: nombre(v.afterburner_speed, 5000),
    ground: taille === 'vehicle' || type === 'ground',
    concept: texte(v.production_status, 30) !== 'flight-ready',
    rsiId: Number.isInteger(Number(v.id)) ? Number(v.id) : null,
    url: /^\/pledge\/[\w\-/.]+$/.test(String(v.url ?? '')) ? String(v.url) : '',
  };
}

async function liste() {
  const j = await lireJson(MATRICE);
  if (!j || j.success !== 1 || !Array.isArray(j.data)) throw new Error('matrice RSI : format inattendu');
  const vus = new Set();
  const vaisseaux = j.data.map(fiche).filter((v) => {
    const cle = v.name.toLowerCase();
    if (!v.name || !/^[A-Z0-9_]{2,10}$/.test(v.maker) || vus.has(cle)) return false;
    vus.add(cle);
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (vaisseaux.length < MINIMUM) throw new Error(`matrice RSI : ${vaisseaux.length} vaisseaux seulement, rien n'est publié`);
  const empreinte = crypto.createHash('sha256').update(JSON.stringify(vaisseaux)).digest('hex');
  return { schema: SCHEMA, source: MATRICE, genere: new Date().toISOString(), empreinte, nombre: vaisseaux.length, vaisseaux };
}

// ── GitHub : une mise à jour d'un seul fichier par l'API (pas de clone du flux, qui pèse des centaines de Mo) ──
async function github(contenu) {
  const depot = process.env.GITHUB_REPOSITORY, jeton = process.env.GITHUB_TOKEN;
  if (!depot || !jeton) throw new Error('--github : GITHUB_REPOSITORY et GITHUB_TOKEN sont nécessaires');
  const api = `https://api.github.com/repos/${depot}/contents/${CHEMIN_FLUX}`;
  const entetes = { Authorization: `Bearer ${jeton}`, 'X-GitHub-Api-Version': '2022-11-28', Accept: 'application/vnd.github+json' };
  for (let essai = 1; essai <= 3; essai++) {
    let sha = null, ancienne = null;
    const r = await fetch(`${api}?ref=main`, { headers: { ...entetes, 'User-Agent': AGENT } });
    if (r.ok) {
      const f = await r.json();
      sha = f.sha;
      try { ancienne = JSON.parse(Buffer.from(f.content, 'base64').toString('utf8')).empreinte; } catch {}
    } else if (r.status !== 404) throw new Error(`lecture de ${CHEMIN_FLUX} : HTTP ${r.status}`);
    if (ancienne === contenu.empreinte) { console.log(`inchangée : ${contenu.nombre} vaisseaux, rien à publier`); return false; }
    const corps = { message: `data(vaisseaux): ${contenu.nombre} vaisseaux (liste officielle RSI) — ${contenu.genere.slice(0, 10)}`,
      content: Buffer.from(JSON.stringify(contenu, null, 1) + '\n').toString('base64'), branch: 'main', ...(sha ? { sha } : {}) };
    const p = await fetch(api, { method: 'PUT', headers: { ...entetes, 'User-Agent': AGENT, 'Content-Type': 'application/json' }, body: JSON.stringify(corps) });
    if (p.ok) { console.log(`publiée : ${contenu.nombre} vaisseaux`); return true; }
    // 409 / 422 : le fichier a bougé entre la lecture et l'écriture (Stelliverse Release pousse aussi dans le flux)
    if ((p.status === 409 || p.status === 422) && essai < 3) { await new Promise((ok) => setTimeout(ok, 3000 * essai)); continue; }
    throw new Error(`écriture de ${CHEMIN_FLUX} : HTTP ${p.status} ${(await p.text()).slice(0, 200)}`);
  }
  return false;
}

async function principal() {
  const contenu = await liste();
  if (args.includes('--github')) {
    if (await github(contenu)) {
      // jsDelivr garde @main en cache plusieurs heures : on le vide pour que les joueurs l'aient tout de suite
      const purge = `https://purge.jsdelivr.net/gh/${process.env.GITHUB_REPOSITORY}@main/${CHEMIN_FLUX}`;
      const r = await fetch(purge, { headers: { 'User-Agent': AGENT } }).catch(() => null);
      console.log(`cache jsDelivr : ${r ? r.status : 'injoignable'}`);
    }
    return;
  }
  const sortie = path.resolve(val('--sortie', 'vaisseaux.json'));
  fs.mkdirSync(path.dirname(sortie), { recursive: true });
  fs.writeFileSync(sortie, JSON.stringify(contenu, null, 1) + '\n');
  console.log(`${contenu.nombre} vaisseaux → ${sortie} (empreinte ${contenu.empreinte.slice(0, 12)})`);
}

principal().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
