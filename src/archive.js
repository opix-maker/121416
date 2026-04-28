/**
 * Archive download and JSONL parsing module.
 * Downloads the latest Bangumi Archive dump ZIP and extracts subject data.
 */
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const unzipper = require('unzipper');
const readline = require('readline');

const LATEST_JSON_URL = 'https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json';
const ARCHIVE_DIR = path.join(__dirname, '..', '.archive_cache');
const SUBJECT_TYPES = { ANIME: 2, REAL: 6 };

/**
 * Download the latest Archive ZIP and extract subject.jsonl.
 * @returns {string} Path to the extracted subject.jsonl file.
 */
async function downloadAndExtract() {
  const latestResp = await fetch(LATEST_JSON_URL);
  if (!latestResp.ok) throw new Error(`Failed to fetch latest.json: ${latestResp.status}`);
  const latest = await latestResp.json();
  const zipUrl = latest.browser_download_url;
  const zipName = latest.name;
  console.log(`[Archive] Latest dump: ${zipName}`);

  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  const markerPath = path.join(ARCHIVE_DIR, '.extracted_from');
  if (fs.existsSync(markerPath) && fs.readFileSync(markerPath, 'utf8') === zipName) {
    const cachedPath = path.join(ARCHIVE_DIR, 'subject.jsonlines');
    if (fs.existsSync(cachedPath)) {
      console.log('[Archive] Using cached extraction.');
      return cachedPath;
    }
  }

  console.log(`[Archive] Downloading ${zipUrl} ...`);
  const zipResp = await fetch(zipUrl);
  if (!zipResp.ok) throw new Error(`Failed to download ZIP: ${zipResp.status}`);

  const outputPath = path.join(ARCHIVE_DIR, 'subject.jsonlines');
  await extractSubjectFromStream(zipResp.body, outputPath);
  fs.writeFileSync(markerPath, zipName, 'utf8');
  console.log('[Archive] Extraction complete.');
  return outputPath;
}

/**
 * Stream-extract only subject.jsonlines from the ZIP body.
 */
async function extractSubjectFromStream(bodyStream, outputPath) {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(outputPath);
    let found = false;

    bodyStream
      .pipe(unzipper.Parse())
      .on('entry', (entry) => {
        if (entry.path.endsWith('subject.jsonlines')) {
          found = true;
          entry.pipe(writeStream);
          writeStream.on('finish', resolve);
        } else {
          entry.autodrain();
        }
      })
      .on('close', () => { if (!found) reject(new Error('subject.jsonlines not found in ZIP')); })
      .on('error', reject);
  });
}

/**
 * Parse subject.jsonl and index entries by type.
 * @param {string} filePath - Path to subject.jsonl
 * @returns {{ anime: object[], real: object[] }} Indexed subjects.
 */
async function parseSubjects(filePath) {
  const anime = [];
  const real = [];

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const subject = JSON.parse(line);
    if (subject.nsfw) continue;
    if (subject.type === SUBJECT_TYPES.ANIME) anime.push(subject);
    else if (subject.type === SUBJECT_TYPES.REAL) real.push(subject);
  }

  console.log(`[Archive] Parsed ${anime.length} anime, ${real.length} real subjects.`);
  return { anime, real };
}

module.exports = { downloadAndExtract, parseSubjects, SUBJECT_TYPES };
