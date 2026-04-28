# Bangumi Data Platform

A data platform that processes data from the [Bangumi Archive](https://github.com/bangumi/Archive), enriches items with TMDB metadata, and generates static JSON files for a "hot charts" widget.

The system produces static data that can be hosted on any static file server or CDN, providing a fast and scalable way to power applications and widgets without needing a dynamic backend.

---

## Data Sources

| Source | Usage |
|---|---|
| [Bangumi Archive](https://github.com/bangumi/Archive) | Primary data source — weekly ZIP dump containing all subjects with metadata, scores, rankings, and collection counts |
| [Bangumi API](https://api.bgm.tv) | Daily broadcast calendar (`/calendar`) and cover images for non-TMDB items (`/v0/subjects/:id`) |
| [TMDB API](https://api.themoviedb.org) | Enrichment — posters, backdrops, descriptions, and region data |

## How It Works

The build process is orchestrated by `build_data.js` with modular components in `src/`:
1.  **Downloads Archive**: Fetches the latest Bangumi Archive ZIP dump and extracts `subject.jsonl`.
2.  **Parses and Indexes**: Reads the JSONL file, filtering subjects by type (anime=2, real=6).
3.  **Filters and Sorts**: Applies year/season filters and sorts by rank, collection count, or trending activity (approximated by "currently watching" count).
4.  **Enriches with TMDB**: For each unique subject, searches TMDB for matching entries to pull in posters, descriptions, and ratings.
5.  **Fetches Covers**: For items without a TMDB match, fetches cover images from the Bangumi API.
6.  **Generates JSON**: Outputs `recent_data.json` or `archive/{year}.json` depending on build type.

The consumer for this data is `js/Bangumi_v2.0.0.js`.

## How to Run

1.  **Set the required environment variables**:
    ```bash
    export TMDB_API_KEY="your_tmdb_v3_api_key"
    export BGM_USER_AGENT="YourAppName/1.0 (YourContactInfo)"
    ```
2.  **Install dependencies**:
    ```bash
    npm install
    ```
3.  **Run the build** (recent data):
    ```bash
    npm run build
    ```
    Or for archive data:
    ```bash
    BUILD_TYPE=archive npm run build
    ```

## Output

- `recent_data.json` — Recent hot items + current year airtime rankings + daily calendar
- `archive/{year}.json` — Historical year data for airtime rankings

---

## Automation & Workflows

The `.github/workflows/` directory contains GitHub Actions workflows:

-   `build-recent.yml`: Runs every 8 hours to build `recent_data.json` from Bangumi Archive + TMDB.
-   `build-archive.yml`: Runs quarterly to generate historical data for the `archive/` directory.
-   `test-workflow.yml`: A workflow for running tests.
