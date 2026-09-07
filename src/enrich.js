/**
 * TMDB enrichment and Bangumi API cover fetching module.
 * Shared HTTP utilities, TMDB search, and item formatting.
 */
const fetch = require('node-fetch');

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const BGM_API_USER_AGENT = process.env.BGM_USER_AGENT || 'Bangumi-Data-Builder/2.0';

const TMDB_SEARCH_MIN_SCORE = 6;
const MAX_TMDB_QUERIES = 4;
const TMDB_ANIMATION_GENRE_ID = 16;
const CONCURRENT_TMDB = 16;
const CONCURRENT_BGM_API = 8;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;
const BGM_BASE_URL = 'https://bgm.tv';

// --- HTTP helpers ---

async function fetchWithRetry(fn, ...args) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn(...args);
    } catch (err) {
      if (attempt >= MAX_RETRIES) {
        console.error(`  Final attempt failed: ${err.message}`);
        throw err;
      }
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
}

async function tmdbGet(path, params = {}) {
  const qs = new URLSearchParams({ ...params, api_key: TMDB_API_KEY });
  const url = `https://api.themoviedb.org/3${path}?${qs}`;
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`TMDB ${resp.status}: ${url}`);
  return resp.json();
}

async function bgmApiGet(subjectId) {
  const url = `https://api.bgm.tv/v0/subjects/${subjectId}`;
  const resp = await fetch(url, { headers: { 'User-Agent': BGM_API_USER_AGENT } });
  if (!resp.ok) throw new Error(`BGM API ${resp.status}: ${url}`);
  return resp.json();
}

// --- TMDB search scoring (preserved from original) ---

function normalize(q) {
  if (!q || typeof q !== 'string') return '';
  return q.toLowerCase().trim()
    .replace(/[\[\]【】（）()「」『』:：\-－_,\.・]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function scoreTmdbResult(result, query, validYear, searchType, origTitle, cnTitle) {
  let score = 0;
  const rTitle = normalize(result.title || result.name);
  const rOrigTitle = normalize(result.original_title || result.original_name);
  const q = normalize(query);
  const primaryBgm = normalize(origTitle || cnTitle);

  if (rTitle === q || rOrigTitle === q) {
    score += 15;
    if (primaryBgm && (rTitle === primaryBgm || rOrigTitle === primaryBgm)) score += 5;
  } else if (rTitle.includes(q) || rOrigTitle.includes(q)) {
    score += 7;
    if (primaryBgm && (rTitle.includes(primaryBgm) || rOrigTitle.includes(primaryBgm))) score += 3;
  } else {
    const words = q.split(/\s+/).filter(w => w.length > 1);
    if (words.length > 0) {
      const titleWords = new Set([...rTitle.split(/\s+/), ...rOrigTitle.split(/\s+/)]);
      let common = 0;
      words.forEach(w => { if (titleWords.has(w)) common++; });
      score += (common / words.length) * 6;
    } else { score -= 2; }
  }

  if (validYear) {
    const resDate = result.release_date || result.first_air_date;
    if (resDate) {
      const resYear = parseInt(resDate.substring(0, 4), 10);
      const diff = Math.abs(resYear - validYear);
      if (diff === 0) score += 6;
      else if (diff === 1) score += 3;
      else if (diff <= 2) score += 1;
      else score -= diff * 1.5;
    } else { score -= 2; }
  } else { score += 1; }

  if (result.original_language === 'ja' && (searchType === 'tv' || searchType === 'movie')) score += 2.5;
  score += Math.log10((result.popularity || 0) + 1) * 2.2
         + Math.log10((result.vote_count || 0) + 1) * 1.2;
  if (result.adult) score -= 10;
  return score;
}

function generateSearchQueries(origTitle, cnTitle) {
  const queries = new Set();
  const refine = (text) => {
    if (!text) return '';
    let r = text.trim()
      .replace(/\s*\((\d{4}|S\d{1,2}|Season\s*\d{1,2}|第[一二三四五六七八九十零〇]+[季期部篇章])\)/gi, '')
      .replace(/\s*\[(\d{4}|S\d{1,2}|Season\s*\d{1,2}|第[一二三四五六七八九十零〇]+[季期部篇章])\]/gi, '')
      .replace(/\s*【(\d{4}|S\d{1,2}|Season\s*\d{1,2}|第[一二三四五六七八九十零〇]+[季期部篇章])】/gi, '');
    return normalize(r);
  };
  const add = (text) => {
    if (!text) return;
    const refined = refine(text);
    if (refined) queries.add(refined);
    const norm = normalize(text);
    if (norm && norm !== refined) queries.add(norm);
    const firstPart = normalize(text.split(/[:：\-\s（(【\[]/)[0].trim());
    if (firstPart) queries.add(firstPart);
    const noSeason = normalize(text.replace(/第.+[期季部篇章]$/g, '').trim());
    if (noSeason && noSeason !== norm && noSeason !== refined) queries.add(noSeason);
  };
  add(origTitle);
  add(cnTitle);
  return Array.from(queries).filter(Boolean).slice(0, MAX_TMDB_QUERIES);
}

async function searchTmdb(origTitle, cnTitle, searchType, year) {
  const validYear = year && /^\d{4}$/.test(year) ? parseInt(year, 10) : null;
  const queries = generateSearchQueries(origTitle, cnTitle);
  if (queries.length === 0) return null;

  let best = null;
  let bestScore = -Infinity;

  const tasks = queries.flatMap(query => {
    const params = { query, language: 'zh-CN', include_adult: false };
    const list = [async () => ({ data: await fetchWithRetry(tmdbGet, `/search/${searchType}`, params), query })];
    if (validYear) {
      const yp = { ...params };
      if (searchType === 'tv') yp.first_air_date_year = validYear;
      else yp.primary_release_year = validYear;
      list.push(async () => ({ data: await fetchWithRetry(tmdbGet, `/search/${searchType}`, yp), query }));
    }
    return list;
  });

  for (let i = 0; i < tasks.length; i += CONCURRENT_TMDB) {
    const batch = tasks.slice(i, i + CONCURRENT_TMDB).map(t => t().catch(() => null));
    const results = await Promise.all(batch);
    for (const r of results) {
      if (!r?.data?.results) continue;
      for (const item of r.data.results) {
        if (searchType === 'tv' && !(item.genre_ids?.includes(TMDB_ANIMATION_GENRE_ID))) continue;
        const s = scoreTmdbResult(item, r.query, validYear, searchType, origTitle, cnTitle);
        if (s > bestScore) { bestScore = s; best = item; }
      }
    }
  }
  return bestScore >= TMDB_SEARCH_MIN_SCORE ? best : null;
}

// --- Item formatting ---

function parseDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const d = dateStr.trim();
  const m = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  const m2 = d.match(/^(\d{4})-(\d{1,2})/);
  if (m2) return `${m2[1]}-${String(m2[2]).padStart(2, '0')}-01`;
  const m3 = d.match(/^(\d{4})/);
  if (m3) return `${m3[1]}-01-01`;
  return '';
}

function detectTmdbSearchType(subject) {
  const platform = String(subject.platform || '').toLowerCase();
  if (platform.includes('剧场版') || platform.includes('movie') || platform === '电影') return 'movie';
  return 'tv';
}

/**
 * Convert an archive subject + optional TMDB result into the output item format.
 */
function formatItem(subject, tmdbResult, searchType, coverUrl) {
  const bgmScore = subject.score || 0;
  const base = {
    id: String(subject.id),
    type: 'link',
    title: subject.name_cn || subject.name,
    posterPath: coverUrl || '',
    backdropPath: '',
    releaseDate: parseDate(subject.date),
    mediaType: subject.type === 2 ? 'anime' : 'real',
    rating: bgmScore ? String(bgmScore) : '0',
    description: subject.summary || '',
    link: `${BGM_BASE_URL}/subject/${subject.id}`,
    bgm_id: String(subject.id),
    bgm_score: bgmScore
  };

  if (tmdbResult?.id) {
    base.id = String(tmdbResult.id);
    base.type = 'tmdb';
    base.mediaType = searchType;
    base.tmdb_id = String(tmdbResult.id);
    base.title = (tmdbResult.title || tmdbResult.name || base.title).trim();
    base.posterPath = tmdbResult.poster_path
      ? `https://image.tmdb.org/t/p/w500${tmdbResult.poster_path}` : base.posterPath;
    base.backdropPath = tmdbResult.backdrop_path
      ? `https://image.tmdb.org/t/p/w780${tmdbResult.backdrop_path}` : '';
    base.releaseDate = parseDate(tmdbResult.release_date || tmdbResult.first_air_date) || base.releaseDate;
    base.rating = tmdbResult.vote_average ? tmdbResult.vote_average.toFixed(1) : base.rating;
    base.description = tmdbResult.overview || base.description;
    base.tmdb_origin_countries = tmdbResult.origin_country || [];
    base.tmdb_vote_count = tmdbResult.vote_count;
    base.link = null;
  }
  return base;
}

// --- Batch enrichment ---

/**
 * Enrich a list of archive subjects with TMDB data and Bangumi cover images.
 * @param {object[]} subjects - Archive subjects.
 * @param {function} onProgress - Optional progress callback.
 * @returns {object[]} Formatted items.
 */
async function enrichSubjects(subjects, onProgress) {
  const items = [];
  const needCover = [];

  for (let i = 0; i < subjects.length; i += CONCURRENT_TMDB) {
    const batch = subjects.slice(i, i + CONCURRENT_TMDB);
    const promises = batch.map(async (subj) => {
      const searchType = detectTmdbSearchType(subj);
      const year = subj.date ? subj.date.substring(0, 4) : '';
      const tmdb = await searchTmdb(subj.name, subj.name_cn, searchType, year);
      return { subject: subj, tmdb, searchType };
    });
    const results = await Promise.all(promises.map(p => p.catch(e => {
      console.warn(`  TMDB enrich error: ${e.message}`);
      return null;
    })));
    for (const r of results) {
      if (!r) continue;
      const item = formatItem(r.subject, r.tmdb, r.searchType, '');
      items.push(item);
      if (!r.tmdb) needCover.push({ item, subjectId: r.subject.id });
    }
    if (onProgress) onProgress(Math.min(i + CONCURRENT_TMDB, subjects.length), subjects.length);
  }

    console.log(`[Enrich] Fetching ${needCover.length} covers and summaries from Bangumi API...`);
    for (let i = 0; i < needCover.length; i += CONCURRENT_BGM_API) {
      const batch = needCover.slice(i, i + CONCURRENT_BGM_API);
      const promises = batch.map(async ({ item, subjectId }) => {
        try {
          const data = await fetchWithRetry(bgmApiGet, subjectId);
          if (data.images?.common && !item.posterPath) {
            item.posterPath = data.images.common;
          }
          if (data.summary && !item.description) {
            item.description = data.summary;
          }
        } catch (e) {
          // Errors are handled in fetchWithRetry (Final attempt failed)
        }
      });
      await Promise.all(promises);
      if (i % 32 === 0 || i + CONCURRENT_BGM_API >= needCover.length) {
        console.log(`  BGM API Progress: ${Math.min(i + CONCURRENT_BGM_API, needCover.length)}/${needCover.length}`);
      }
    }

  return items;
}

module.exports = {
  searchTmdb, enrichSubjects, formatItem, parseDate,
  detectTmdbSearchType, bgmApiGet, fetchWithRetry, CONCURRENT_TMDB, BGM_API_USER_AGENT
};
