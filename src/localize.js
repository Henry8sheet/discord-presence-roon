/** @module localize */
// 歌名/歌手是羅馬拼音時，用 Apple Music 日本區查原文名稱（以歌曲長度比對，避免抓錯歌）。

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;
const cache = new Map();

async function getJson(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        return res.ok ? await res.json() : null;
    } catch { return null; }
    finally { clearTimeout(t); }
}

/**
 * @returns {Promise<{track:string, artist:string, album:string}|null>} 原文名稱，查不到回傳 null
 */
async function Localize(track = '', artist = '', album = '', lengthSec = 0) {
    if(CJK.test(track) && CJK.test(artist)) return null; // 已經是原文
    if(!track || !artist) return null;

    const key = `${artist}|${track}|${lengthSec}`;
    if(cache.has(key)) return cache.get(key);

    const mainArtist = artist.split(' / ')[0];
    const cleanTrack = track.replace(/\s*[\(\[].*?[\)\]]/g, '').trim() || track;
    let found = null;

    for(const country of ['JP', 'TW']) {
        const term = encodeURIComponent(`${mainArtist} ${cleanTrack}`);
        const data = await getJson(`https://itunes.apple.com/search?term=${term}&entity=song&limit=15&country=${country}&lang=ja_jp`);
        const list = data?.results || [];
        const hit = list.find((r) => lengthSec && r.trackTimeMillis && Math.abs(r.trackTimeMillis / 1000 - lengthSec) <= 3)
                 || (!lengthSec ? list[0] : null);
        if(hit && (CJK.test(hit.trackName) || CJK.test(hit.artistName))) {
            found = {
                track: CJK.test(track) ? track : hit.trackName,
                artist: CJK.test(artist) ? artist : hit.artistName,
                album: CJK.test(album) ? album : (hit.collectionName || album),
            };
            break;
        }
    }

    cache.set(key, found);
    return found;
}

module.exports = { Localize };
