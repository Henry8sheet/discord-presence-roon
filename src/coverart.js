/** @module coverart */
// 免 Token 的專輯封面搜尋：先找 iTunes (Apple Music)，找不到再找 Deezer。

const stripFeat = (s = '') => s.replace(/\s*[\(\[](feat\.|ft\.|with ).*?[\)\]]/ig, '').trim();
const norm = (s = '') => s.toLowerCase().replace(/[\s\-–—_:;,.!?'"’()\[\]]/g, '');

async function getJson(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if(!res.ok) return null;
        return await res.json();
    } catch { return null; }
    finally { clearTimeout(t); }
}

function pick(list, album, getAlbum) {
    if(!list || list.length < 1) return null;
    const a = norm(album);
    return list.find((r) => norm(getAlbum(r)) === a)
        || list.find((r) => a && (norm(getAlbum(r)).includes(a) || a.includes(norm(getAlbum(r)))))
        || list[0];
}

async function iTunes(artist, album) {
    const term = encodeURIComponent(`${artist} ${album}`.trim());
    for(const country of ['TW', 'US', 'JP']) {
        const data = await getJson(`https://itunes.apple.com/search?term=${term}&entity=album&limit=10&country=${country}`);
        const hit = pick(data?.results, album, (r) => r.collectionName);
        if(hit?.artworkUrl100) return hit.artworkUrl100.replace('100x100bb', '600x600bb');
    }
    return null;
}

async function Deezer(artist, album) {
    const q = encodeURIComponent(`artist:"${artist}" album:"${album}"`);
    let data = await getJson(`https://api.deezer.com/search/album?q=${q}&limit=10`);
    if(!data?.data?.length) data = await getJson(`https://api.deezer.com/search/album?q=${encodeURIComponent(`${artist} ${album}`)}&limit=10`);
    const hit = pick(data?.data, album, (r) => r.title);
    return hit?.cover_xl || hit?.cover_big || null;
}

/**
 * 找專輯封面網址，找不到回傳 null。
 * @param {string} artist
 * @param {string} album
 * @param {string} track
 * @returns {Promise<string|null>}
 */
async function Search(artist, album, track) {
    if(!artist) return null;
    const mainArtist = artist.split(' / ')[0].trim();
    const albumName = stripFeat(album || track || '');
    return (await iTunes(mainArtist, albumName)) || (await Deezer(mainArtist, albumName));
}

module.exports = { Search };
