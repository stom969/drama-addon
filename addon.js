const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

// ⚠️ API key now comes from Render's environment variables
const TMDB_API_KEY = process.env.TMDB_API_KEY;

// ⚠️ Viki provider IDs (default 344 for both, adjust if you verified different values)
const VIKI_PROVIDER_ID_US = '344';
const VIKI_PROVIDER_ID_UK = '344';

// Netflix's TMDB provider ID (same worldwide, but content varies by region)
const NETFLIX_PROVIDER_ID = '8';

const manifest = {
    id: 'org.myname.asian.dramas',
    version: '1.0.2',
    name: 'Asian Drama Catalog',
    description: 'Japanese, Korean, and Chinese dramas from TMDB, Viki, and Netflix',
    resources: ['catalog'],
    types: ['series'],
    catalogs: [
        {
            type: 'series',
            id: 'kdramas',
            name: 'Korean Dramas',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip' }]
        },
        {
            type: 'series',
            id: 'jdramas',
            name: 'Japanese Dramas',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip' }]
        },
        {
            type: 'series',
            id: 'cdramas',
            name: 'Chinese Dramas (non-Viki)',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip' }]
        },
        {
            type: 'series',
            id: 'vikidramas',
            name: 'Viki Dramas',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip' }]
        },
        {
            type: 'series',
            id: 'netflix_kdramas',
            name: 'Netflix K-Dramas',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip' }]
        }
    ],
    idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

async function tmdbFetch(path, params = {}) {
    const url = new URL(`https://api.themoviedb.org/3${path}`);
    url.searchParams.set('api_key', TMDB_API_KEY);
    url.searchParams.set('language', 'en-US');

    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
        throw new Error(`TMDB error: ${response.status}`);
    }
    return response.json();
}

// Helper with posters, backgrounds, and logos
async function toStremioMeta(item) {
    let imdbId = null;
    let images = { backdrops: [], logos: [] };

    try {
        const [externalIds, imageData] = await Promise.all([
            tmdbFetch(`/tv/${item.id}/external_ids`),
            tmdbFetch(`/tv/${item.id}/images`, { include_image_language: 'en,null' })
        ]);
        imdbId = externalIds.imdb_id;
        images = imageData;
    } catch (e) {
        console.log('Could not get extra data for', item.name, '-', e.message);
    }

    if (!imdbId) {
        return null;
    }

    // Pick the best English logo, or fall back to any logo
    let logoPath = null;
    if (images.logos && images.logos.length > 0) {
        const englishLogo = images.logos.find(l => l.iso_639_1 === 'en');
        logoPath = englishLogo ? englishLogo.file_path : images.logos[0].file_path;
    }

    return {
        id: imdbId,
        type: 'series',
        name: item.name,
        poster: item.poster_path
            ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
            : undefined,
        background: images.backdrops && images.backdrops.length > 0
            ? `https://image.tmdb.org/t/p/w1280${images.backdrops[0].file_path}`
            : undefined,
        logo: logoPath
            ? `https://image.tmdb.org/t/p/w500${logoPath}`
            : undefined,
        description: item.overview,
        releaseInfo: item.first_air_date
            ? item.first_air_date.split('-')[0]
            : undefined
    };
}

async function fetchVikiBatch(language, region, providerId, page) {
    const data = await tmdbFetch('/discover/tv', {
        watch_region: region,
        with_watch_providers: providerId,
        with_original_language: language,
        with_genres: '18',
        without_genres: '16',
        sort_by: 'popularity.desc',
        'first_air_date.gte': '2000-01-01',
        page: page
    });
    return data.results;
}

async function fetchNonVikiChinese(region, providerId, page) {
    const data = await tmdbFetch('/discover/tv', {
        with_original_language: 'zh',
        with_genres: '18',
        without_genres: '16',
        sort_by: 'popularity.desc',
        'first_air_date.gte': '2000-01-01',
        watch_region: region,
        without_watch_providers: providerId,
        page: page
    });
    return data.results;
}

builder.defineCatalogHandler(async (args) => {
    console.log('Stremio asked for:', args);

    try {
        let results = [];
        const searchQuery = args.extra && args.extra.search;
        const skip = args.extra && args.extra.skip ? parseInt(args.extra.skip) : 0;
        const tmdbPage = Math.floor(skip / 20) + 1;
        const offsetInPage = skip % 20;

        // --- Regular Korean dramas ---
        if (args.id === 'kdramas') {
            const data = await tmdbFetch('/discover/tv', {
                with_original_language: 'ko',
                with_genres: '18',
                without_genres: '16',
                sort_by: 'popularity.desc',
                'first_air_date.gte': '2000-01-01',
                page: tmdbPage
            });
            results = data.results;
        }

        // --- Regular Japanese dramas ---
        else if (args.id === 'jdramas') {
            const data = await tmdbFetch('/discover/tv', {
                with_original_language: 'ja',
                with_genres: '18',
                without_genres: '16',
                sort_by: 'popularity.desc',
                'first_air_date.gte': '2000-01-01',
                page: tmdbPage
            });
            results = data.results;
        }

        // --- Chinese dramas EXCLUDING Viki (US + UK) ---
        else if (args.id === 'cdramas') {
            const [nonVikiUS, nonVikiUK] = await Promise.all([
                fetchNonVikiChinese('US', VIKI_PROVIDER_ID_US, tmdbPage),
                fetchNonVikiChinese('GB', VIKI_PROVIDER_ID_UK, tmdbPage)
            ]);

            const seen = new Set();
            for (const item of [...nonVikiUS, ...nonVikiUK]) {
                if (!seen.has(item.id)) {
                    seen.add(item.id);
                    results.push(item);
                }
            }

            results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
        }

        // --- Combined Viki catalog ---
        else if (args.id === 'vikidramas') {
            const batches = await Promise.all([
                fetchVikiBatch('ko', 'US', VIKI_PROVIDER_ID_US, tmdbPage),
                fetchVikiBatch('ja', 'US', VIKI_PROVIDER_ID_US, tmdbPage),
                fetchVikiBatch('zh', 'US', VIKI_PROVIDER_ID_US, tmdbPage),
                fetchVikiBatch('ko', 'GB', VIKI_PROVIDER_ID_UK, tmdbPage),
                fetchVikiBatch('ja', 'GB', VIKI_PROVIDER_ID_UK, tmdbPage),
                fetchVikiBatch('zh', 'GB', VIKI_PROVIDER_ID_UK, tmdbPage)
            ]);

            const seen = new Set();
            for (const batch of batches) {
                for (const item of batch) {
                    if (!seen.has(item.id)) {
                        seen.add(item.id);
                        results.push(item);
                    }
                }
            }

            results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
        }

        // --- Netflix K-Dramas ---
        else if (args.id === 'netflix_kdramas') {
            const data = await tmdbFetch('/discover/tv', {
                watch_region: 'US',              // Change to 'GB', 'CA', etc. if you prefer
                with_watch_providers: NETFLIX_PROVIDER_ID,
                with_original_language: 'ko',
                with_genres: '18',
                without_genres: '16',
                sort_by: 'popularity.desc',
                'first_air_date.gte': '2000-01-01',
                page: tmdbPage
            });
            results = data.results;
        }

        results = results.slice(offsetInPage, offsetInPage + 20);

        console.log(`Found ${results.length} results (skip: ${skip})`);

        const metaPromises = results.map(toStremioMeta);
        const metasRaw = await Promise.all(metaPromises);
        const metas = metasRaw.filter(m => m !== null);

        console.log(`Returning ${metas.length} items with IMDb IDs`);

        return {
            metas,
            cacheMaxAge: 3600
        };

    } catch (error) {
        console.log('Error:', error.message);
        return { metas: [] };
    }
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
console.log('✅ Addon is running!');
console.log('Install URL: http://127.0.0.1:7000/manifest.json');
