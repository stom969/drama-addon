const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

// ⚠️ PASTE YOUR TMDB API KEY HERE
const TMDB_API_KEY = '4e218cb7ac9af83106f9810ea3123897';

// ⚠️ PASTE YOUR VIKI PROVIDER IDS HERE (verify with the steps in chat)
const VIKI_PROVIDER_ID_US = '344';
const VIKI_PROVIDER_ID_UK = '344';

const manifest = {
    id: 'm3ll0n.asian.dramas',
    version: '1.0.0',
    name: 'Asian Drama Catalog',
    description: 'Japanese, Korean, and Chinese dramas from TMDB and Viki',
    resources: ['catalog'],
    types: ['series'],
    catalogs: [
        // --- Regular (all dramas) ---
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
            name: 'Chinese Dramas',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip' }]
        },
        // --- Combined Viki catalog ---
        {
            type: 'series',
            id: 'vikidramas',
            name: 'Viki Dramas',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip' }]
        }
    ],
    idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

// Helper function to call TMDB API
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

// Helper to convert TMDB item to Stremio meta
async function toStremioMeta(item) {
    let imdbId = null;
    try {
        const externalIds = await tmdbFetch(`/tv/${item.id}/external_ids`);
        imdbId = externalIds.imdb_id;
    } catch (e) {
        console.log('Could not get IMDb ID for', item.name);
    }
    
    if (!imdbId) {
        return null;
    }
    
    return {
        id: imdbId,
        type: 'series',
        name: item.name,
        poster: item.poster_path 
            ? `https://image.tmdb.org/t/p/w500${item.poster_path}` 
            : undefined,
        description: item.overview,
        releaseInfo: item.first_air_date 
            ? item.first_air_date.split('-')[0] 
            : undefined
    };
}

// Fetch a batch from Viki for a specific language and region
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

builder.defineCatalogHandler(async (args) => {
    console.log('Stremio asked for:', args);
    
    try {
        let results = [];
        const searchQuery = args.extra && args.extra.search;
        const skip = args.extra && args.extra.skip ? parseInt(args.extra.skip) : 0;
        const tmdbPage = Math.floor(skip / 20) + 1;
        const offsetInPage = skip % 20;
        
        // --- Regular (all) dramas ---
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
        } else if (args.id === 'jdramas') {
            const data = await tmdbFetch('/discover/tv', {
                with_original_language: 'ja',
                with_genres: '18',
                without_genres: '16',
                sort_by: 'popularity.desc',
                'first_air_date.gte': '2000-01-01',
                page: tmdbPage
            });
            results = data.results;
        } else if (args.id === 'cdramas') {
            const data = await tmdbFetch('/discover/tv', {
                with_original_language: 'zh',
                with_genres: '18',
                without_genres: '16',
                sort_by: 'popularity.desc',
                'first_air_date.gte': '2000-01-01',
                page: tmdbPage
            });
            results = data.results;
        }
        
        // --- Combined Viki catalog (KO + JA + ZH, US + UK, deduplicated) ---
        else if (args.id === 'vikidramas') {
            // Fetch one page from each combination in parallel
            const batches = await Promise.all([
                fetchVikiBatch('ko', 'US', VIKI_PROVIDER_ID_US, tmdbPage),
                fetchVikiBatch('ja', 'US', VIKI_PROVIDER_ID_US, tmdbPage),
                fetchVikiBatch('zh', 'US', VIKI_PROVIDER_ID_US, tmdbPage),
                fetchVikiBatch('ko', 'GB', VIKI_PROVIDER_ID_UK, tmdbPage),
                fetchVikiBatch('ja', 'GB', VIKI_PROVIDER_ID_UK, tmdbPage),
                fetchVikiBatch('zh', 'GB', VIKI_PROVIDER_ID_UK, tmdbPage)
            ]);
            
            // Flatten and deduplicate by TMDB id
            const seen = new Set();
            for (const batch of batches) {
                for (const item of batch) {
                    if (!seen.has(item.id)) {
                        seen.add(item.id);
                        results.push(item);
                    }
                }
            }
            
            // Sort combined results by popularity
            results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
        }
        
        // Slice for pagination offset within page
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

serveHTTP(builder.getInterface(), { port: 7000 });
console.log('✅ Addon is running!');
console.log('Install URL: http://127.0.0.1:7000/manifest.json');