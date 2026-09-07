/**
 * Subject filtering, sorting, and pagination module.
 * Replicates bgm.tv browser page functionality using Archive data.
 */

const ITEMS_PER_PAGE = 24;

/**
 * Compute total favorites count for a subject.
 */
function totalFavorites(subject) {
  const fav = subject.favorite || {};
  return (fav.wish || 0) + (fav.collect || 0) + (fav.doing || 0)
    + (fav.on_hold || 0) + (fav.dropped || 0);
}

/**
 * Filter subjects by year and month (season quarter).
 * @param {object[]} subjects - Raw subjects from archive.
 * @param {string} year - e.g. "2025"
 * @param {string} month - "all", "1", "4", "7", "10"
 * @returns {object[]} Filtered subjects.
 */
function filterByAirtime(subjects, year, month) {
  return subjects.filter(s => {
    if (!s.date) return false;
    const subjectYear = s.date.substring(0, 4);
    if (subjectYear !== year) return false;
    if (month === 'all') return true;
    const subjectMonth = parseInt(s.date.substring(5, 7), 10);
    const quarterStart = parseInt(month, 10);
    const quarterEnd = quarterStart + 2;
    return subjectMonth >= quarterStart && subjectMonth <= quarterEnd;
  });
}

/**
 * Sort subjects by a given criterion.
 * @param {object[]} subjects - Subjects to sort (mutated in-place).
 * @param {string} sortBy - "rank", "collects", "trends", "date", "title"
 * @returns {object[]} Sorted subjects.
 */
function sortSubjects(subjects, sortBy) {
  const comparators = {
    rank: (a, b) => {
      const aRank = a.rank || Number.MAX_SAFE_INTEGER;
      const bRank = b.rank || Number.MAX_SAFE_INTEGER;
      return aRank - bRank;
    },
    collects: (a, b) => {
      return (b.favorite?.collect || 0) - (a.favorite?.collect || 0);
    },
    trends: (a, b) => {
      return (b.favorite?.doing || 0) - (a.favorite?.doing || 0);
    },
    date: (a, b) => {
      return (b.date || '').localeCompare(a.date || '');
    },
    title: (a, b) => {
      const aName = a.name_cn || a.name || '';
      const bName = b.name_cn || b.name || '';
      return aName.localeCompare(bName, 'zh-CN');
    }
  };

  const comparator = comparators[sortBy];
  if (!comparator) throw new Error(`Unknown sort: ${sortBy}`);
  return subjects.sort(comparator);
}

/**
 * Paginate subjects into pages of ITEMS_PER_PAGE.
 * @param {object[]} subjects - Sorted subjects.
 * @param {number} totalPages - Number of pages to produce.
 * @returns {object[][]} Array of pages, each an array of subjects.
 */
function paginate(subjects, totalPages) {
  const pages = [];
  for (let i = 0; i < totalPages; i++) {
    const start = i * ITEMS_PER_PAGE;
    pages.push(subjects.slice(start, start + ITEMS_PER_PAGE));
  }
  return pages;
}

/**
 * Build Recent Hot data from archive.
 * Takes subjects from current + previous year, sorted by doing count.
 * @param {object[]} subjects - All subjects of the target type.
 * @param {number} totalPages - Number of pages to output.
 * @returns {object[][]} Paginated results.
 */
function buildRecentHot(subjects, totalPages) {
  const currentYear = new Date().getFullYear();
  const recent = subjects.filter(s => {
    if (!s.date) return false;
    const year = parseInt(s.date.substring(0, 4), 10);
    return year >= currentYear - 1 && totalFavorites(s) > 0;
  });
  sortSubjects(recent, 'trends');
  return paginate(recent, totalPages);
}

/**
 * Build Airtime Ranking data from archive.
 * @param {object[]} subjects - All subjects of the target type.
 * @param {string} year
 * @param {string} month
 * @param {string} sort
 * @param {number} totalPages
 * @returns {object[][]} Paginated results.
 */
function buildAirtimeRanking(subjects, year, month, sort, totalPages) {
  const filtered = filterByAirtime(subjects, year, month);
  sortSubjects(filtered, sort);
  return paginate(filtered, totalPages);
}

module.exports = {
  filterByAirtime, sortSubjects, paginate,
  buildRecentHot, buildAirtimeRanking, ITEMS_PER_PAGE
};
