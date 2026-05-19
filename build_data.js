/**
 * =================================================================================================
 *   Bangumi Charts Widget - DATA BUILD SCRIPT (v2.0)
 *   Data source: Bangumi Archive (https://github.com/bangumi/Archive)
 *                + Bangumi API (https://api.bgm.tv) for calendar & cover images
 *                + TMDB API for enrichment
 * =================================================================================================
 */
const fs = require('fs').promises;
const { downloadAndExtract, parseSubjects } = require('./src/archive');
const { buildRecentHot, buildAirtimeRanking } = require('./src/filter');
const { enrichSubjects } = require('./src/enrich');
const { buildDailyCalendar } = require('./src/calendar');

// --- Build configuration ---
const BUILD_TYPE = process.env.BUILD_TYPE || 'recent';
const CURRENT_YEAR = new Date().getFullYear();
const RECENT_YEARS = [String(CURRENT_YEAR), String(CURRENT_YEAR - 1)];
const ARCHIVE_YEAR_RANGE = { start: 1940, end: CURRENT_YEAR };
const SORTS = ['collects', 'rank', 'trends'];
const MONTHS = ['all', '1', '4', '7', '10'];
const PAGES_PER_SECTION = 5;
const RECENT_HOT_ANIME_PAGES = 5;
const RECENT_HOT_REAL_PAGES = 2;

/**
 * Collect unique subjects across all paginated sections to minimize TMDB API calls.
 * Returns a Map<subjectId, subject> of unique subjects.
 */
function collectUniqueSubjects(paginatedSections) {
  const unique = new Map();
  for (const pages of paginatedSections) {
    for (const page of pages) {
      for (const subject of page) {
        if (!unique.has(subject.id)) unique.set(subject.id, subject);
      }
    }
  }
  return unique;
}

/**
 * Build the enrichment lookup: subjectId -> formatted item.
 * Enriches all unique subjects with TMDB + Bangumi API covers in one batch.
 */
async function buildEnrichmentLookup(uniqueSubjects) {
  const subjects = Array.from(uniqueSubjects.values());
  console.log(`\n[Enrich] Enriching ${subjects.length} unique subjects with TMDB...`);
  const items = await enrichSubjects(subjects, (done, total) => {
    if (done % 64 === 0 || done === total) {
      console.log(`  Progress: ${done}/${total}`);
    }
  });
  const lookup = new Map();
  items.forEach(item => lookup.set(item.bgm_id, item));
  return lookup;
}

/**
 * Replace raw archive subjects in paginated arrays with enriched items.
 */
function applyEnrichment(paginatedSections, lookup) {
  return paginatedSections.map(pages =>
    pages.map(page =>
      page.map(subject => lookup.get(String(subject.id)) || null).filter(Boolean)
    )
  );
}

/**
 * Build recent_data.json (BUILD_TYPE=recent).
 */
async function buildRecent(archiveSubjects) {
  const data = {
    buildTimestamp: new Date().toISOString(),
    recentHot: {},
    airtimeRanking: {},
    dailyCalendar: {}
  };

  console.log('\n[1/4] Building Recent Hot...');
  const recentAnimeRaw = buildRecentHot(archiveSubjects.anime, RECENT_HOT_ANIME_PAGES);
  const recentRealRaw = buildRecentHot(archiveSubjects.real, RECENT_HOT_REAL_PAGES);

  console.log('\n[2/4] Building Airtime Rankings...');
  const allSections = [recentAnimeRaw, recentRealRaw];
  const airtimeRawMap = {};

  for (const year of RECENT_YEARS) {
    airtimeRawMap[year] = {};
    for (const month of MONTHS) {
      airtimeRawMap[year][month] = {};
      for (const sort of SORTS) {
        console.log(`  Anime ${year}/${month}/${sort}`);
        const raw = buildAirtimeRanking(archiveSubjects.anime, year, month, sort, PAGES_PER_SECTION);
        airtimeRawMap[year][month][sort] = raw;
        allSections.push(raw);
      }
    }
  }

  console.log('\n[3/4] Enriching all subjects with TMDB...');
  const unique = collectUniqueSubjects(allSections);
  const lookup = await buildEnrichmentLookup(unique);

  // Apply enrichment
  const [enrichedAnime] = applyEnrichment([recentAnimeRaw], lookup);
  const [enrichedReal] = applyEnrichment([recentRealRaw], lookup);
  data.recentHot.anime = enrichedAnime;
  data.recentHot.real = enrichedReal;

  data.airtimeRanking.anime = {};
  for (const year of RECENT_YEARS) {
    data.airtimeRanking.anime[year] = {};
    for (const month of MONTHS) {
      data.airtimeRanking.anime[year][month] = {};
      for (const sort of SORTS) {
        const [enrichedPages] = applyEnrichment([airtimeRawMap[year][month][sort]], lookup);
        data.airtimeRanking.anime[year][month][sort] = enrichedPages;
      }
    }
  }

  console.log('\n[4/4] Building Daily Calendar...');
  data.dailyCalendar.all_week = await buildDailyCalendar();

  await fs.writeFile('recent_data.json', JSON.stringify(data, null, 2));
  console.log('recent_data.json generated successfully.');
}

/**
 * Build archive/{year}.json files (BUILD_TYPE=archive).
 */
async function buildArchive(archiveSubjects) {
  for (let year = ARCHIVE_YEAR_RANGE.start; year <= ARCHIVE_YEAR_RANGE.end; year++) {
    const yearStr = String(year);
    console.log(`\n[Archive] Building year ${yearStr}...`);

    const allSections = [];
    const airtimeRaw = {};
    for (const month of MONTHS) {
      airtimeRaw[month] = {};
      for (const sort of SORTS) {
        const raw = buildAirtimeRanking(archiveSubjects.anime, yearStr, month, sort, PAGES_PER_SECTION);
        airtimeRaw[month][sort] = raw;
        allSections.push(raw);
      }
    }

    const unique = collectUniqueSubjects(allSections);
    if (unique.size === 0) {
      console.log(`  Skipping ${yearStr} (no subjects).`);
      continue;
    }

    const lookup = await buildEnrichmentLookup(unique);

    const yearData = { airtimeRanking: { anime: { [yearStr]: {} } } };
    for (const month of MONTHS) {
      yearData.airtimeRanking.anime[yearStr][month] = {};
      for (const sort of SORTS) {
        const [enriched] = applyEnrichment([airtimeRaw[month][sort]], lookup);
        yearData.airtimeRanking.anime[yearStr][month][sort] = enriched;
      }
    }

    await fs.mkdir('archive', { recursive: true });
    await fs.writeFile(`archive/${yearStr}.json`, JSON.stringify(yearData));
    console.log(`  archive/${yearStr}.json generated.`);
  }
}

// --- Main ---
async function main() {
  if (!process.env.TMDB_API_KEY) {
    throw new Error('TMDB_API_KEY environment variable is not set!');
  }
  console.log(`Build type: ${BUILD_TYPE}`);
  const startTime = Date.now();

  const subjectFile = await downloadAndExtract();
  const archiveSubjects = await parseSubjects(subjectFile);

  if (BUILD_TYPE === 'archive') {
    await buildArchive(archiveSubjects);
  } else {
    await buildRecent(archiveSubjects);
  }

  const duration = (Date.now() - startTime) / 1000;
  console.log(`\nBuild finished in ${duration.toFixed(2)} seconds.`);
}

main().catch(err => {
  console.error('\nFATAL ERROR:', err);
  process.exit(1);
});
