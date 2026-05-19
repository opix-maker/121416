/**
 * Daily Calendar module.
 * Fetches broadcast schedule from Bangumi API (unchanged data source).
 */
const fetch = require('node-fetch');
const { searchTmdb, formatItem, parseDate, fetchWithRetry, BGM_API_USER_AGENT } = require('./enrich');

const CONCURRENT_BATCH = 32;
const BGM_API_TYPE_MAP = { 2: 'anime', 6: 'real' };

async function httpGetJson(url, headers = {}) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
  return resp.json();
}

/**
 * Build daily calendar data from api.bgm.tv/calendar.
 * Returns enriched items with TMDB data.
 */
async function buildDailyCalendar() {
  console.log('[Calendar] Fetching from api.bgm.tv/calendar ...');
  const data = await fetchWithRetry(
    httpGetJson,
    'https://api.bgm.tv/calendar',
    { 'User-Agent': BGM_API_USER_AGENT }
  );
  if (!Array.isArray(data)) throw new Error('Calendar API response not an array');

  const allItems = [];
  data.forEach(dayData => {
    if (!dayData.items) return;
    dayData.items.forEach(item => {
      item.bgm_weekday_id = dayData.weekday?.id;
      allItems.push(item);
    });
  });
  console.log(`[Calendar] ${allItems.length} items across all days.`);

  const enhancedItems = [];
  for (let i = 0; i < allItems.length; i += CONCURRENT_BATCH) {
    const batch = allItems.slice(i, i + CONCURRENT_BATCH);
    const promises = batch.map(async (item) => {
      const categoryHint = BGM_API_TYPE_MAP[item.type] || 'unknown';
      const tmdbSearchType = categoryHint === 'anime' ? 'tv' : (categoryHint === 'real' ? 'movie' : '');

      let coverUrl = item.images?.large;
      if (coverUrl?.startsWith('//')) coverUrl = 'https:' + coverUrl;

      const baseItem = {
        id: String(item.id),
        type: 'link',
        title: item.name_cn || item.name,
        posterPath: coverUrl || '',
        backdropPath: '',
        releaseDate: item.air_date,
        mediaType: categoryHint,
        rating: item.rating?.score?.toFixed(1) || 'N/A',
        description: `[${item.weekday?.cn || ''}] ${item.summary || ''}`.trim(),
        link: item.url,
        bgm_id: String(item.id),
        bgm_score: item.rating?.score || 0,
        bgm_rating_total: item.rating?.total || 0,
        bgm_weekday_id: item.bgm_weekday_id
      };

      if (tmdbSearchType) {
        try {
          const tmdbRes = await searchTmdb(
            item.name, item.name_cn, tmdbSearchType,
            item.air_date?.substring(0, 4)
          );
          if (tmdbRes?.id) {
            baseItem.id = String(tmdbRes.id);
            baseItem.type = 'tmdb';
            baseItem.mediaType = tmdbSearchType;
            baseItem.tmdb_id = String(tmdbRes.id);
            baseItem.title = (tmdbRes.title || tmdbRes.name || baseItem.title).trim();
            baseItem.posterPath = tmdbRes.poster_path
              ? `https://image.tmdb.org/t/p/w500${tmdbRes.poster_path}` : baseItem.posterPath;
            baseItem.backdropPath = tmdbRes.backdrop_path
              ? `https://image.tmdb.org/t/p/w780${tmdbRes.backdrop_path}` : '';
            baseItem.releaseDate = parseDate(tmdbRes.release_date || tmdbRes.first_air_date) || baseItem.releaseDate;
            baseItem.rating = tmdbRes.vote_average ? tmdbRes.vote_average.toFixed(1) : baseItem.rating;
            baseItem.description = tmdbRes.overview || baseItem.description;
            baseItem.tmdb_origin_countries = tmdbRes.origin_country || [];
            baseItem.tmdb_vote_count = tmdbRes.vote_count;
            baseItem.link = null;
          }
        } catch (e) {
          console.warn(`  Calendar TMDB error for ${item.id}: ${e.message}`);
        }
      }
      return baseItem;
    });
    const settled = await Promise.all(promises.map(p => p.catch(() => null)));
    enhancedItems.push(...settled.filter(Boolean));
  }

  console.log(`[Calendar] Enriched ${enhancedItems.length} items.`);
  return enhancedItems;
}

module.exports = { buildDailyCalendar };
