#!/usr/bin/env node
/** @module main */
const { version, author, homepage } = require('../package.json');
const { ActivityType } = require('discord-api-types/v10');
const RoonApi = require('@roonlabs/node-roon-api');
const RoonApiTransport = require('node-roon-api-transport');
const RoonApiImage = require('node-roon-api-image');
const semver = require('semver');

const { DEFAULT_IMAGE, UPDATE_CHECK, UPDATE_CHECK_URL } = require('./common');
const RoonSettings = require('./settings');
const Discord = require('./discord');
const Discogs = require('./discogs');
const Imgur = require('./imgur');
const CoverArt = require('./coverart');
const { Localize } = require('./localize');

const { Info, Debug, Warn, Error } = require('./console');

var roon = new RoonApi({
    extension_id: 'com.jtpox.discord-roon',
    display_name: `Discord Presence Integration`,
    display_version: version,
    publisher: author.name,
    email: author.email,
    website: homepage,

    log_level: 'none', // 不記錄 Roon 的每一筆通訊，避免記錄檔一直變大

    core_paired: Paired,
    core_unpaired: Unpaired,
});

/** @type {import('./settings').TSettings} */
let Settings;

/**
 * The package constructor.
 * @function Initiate
 */
function Initiate() {

    CheckVersion();
    RoonSettings.Initiate(roon);
    InitiateIntegrations();

    roon.init_services({
        required_services: [RoonApiTransport, RoonApiImage],
        provided_services: [RoonSettings.Service(InitiateIntegrations)],
    });
    roon.start_discovery();

    setInterval(CheckVersion, UPDATE_CHECK);
}

/**
 * Initiate Discord, Discogs and Imgur integrations.
 * @function InitiateIntegrations
 */
function InitiateIntegrations() {
    Info('Extension: Reloading settings');
    Settings = roon.load_config('settings') || RoonSettings.DefaultSettings;

    Discord.Initiate(Settings);
    Discogs.Initiate(roon, Settings);
    Imgur.Initiate(roon, Settings);
}

/**
 * Check for latest version
 * @function CheckVersion
 */
async function CheckVersion() {
    try {
        const latest_package_json = await fetch(UPDATE_CHECK_URL);
        if(!latest_package_json.ok) return;

        const package = await latest_package_json.json();
        if(semver.gt(package.version, version)) Warn(`New discord-presence-roon update available! | Running version: ${version} | Latest version: ${package.version}`);
    } catch (err) {
        Warn(`Update check failed: ${err.message}`);
    }
}

/**
 * Paired event callback for Roon.
 * @function Paired
 * @param {object} core The Roon core.
 */
function Paired(core) {
    let transport = core.services.RoonApiTransport;
    Info('Roon Paired');

    let zone_info = {
        zone_id: null,
        display_name: null,
        outputs: [],
        state: '',
        is_next_allowed: true,
        is_previous_allowed: true,
        is_pause_allowed: false,
        is_play_allowed: true,
        is_seek_allowed: true,
        queue_items_remaining: 0,
        queue_time_remaining: 0,
        seek_position: 0,
        settings: {},
        now_playing: {},
    };

    transport.subscribe_zones((cmd, data) => {
        if(!['Changed', 'Subscribed'].includes(cmd)) return;
        switch(Object.keys(data)[0]) {
            case 'zones_removed':
                Discord.Self().user?.clearActivity();
                return;
            
            case 'zones':
            case 'zones_changed':
            case 'zones_added':
                const zones_to_check = Settings.roonZones.split(',');
                const available_zones = data.zones || data.zones_changed || data.zones_added;;
                const zones = available_zones.filter((zone_data) => zones_to_check.includes(zone_data.display_name));
                const priority_zone = zones.sort((a, b) => zones_to_check.indexOf(a.display_name) - zones_to_check.indexOf(b.display_name));

                if(priority_zone.length < 1) return;
                zone_info = { ...zone_info, ...priority_zone[0] };
                break;
            case 'zones_seek_changed':
                const correct_zone = data.zones_seek_changed.find(el => el.zone_id === zone_info.zone_id);
                if(!correct_zone) return;

                zone_info.now_playing.seek_position = correct_zone.seek_position;
                zone_info = { ...zone_info, ...correct_zone };
                break;
        }

        if(Discord.Self() === undefined) return;

        SongChanged(core, zone_info);
    });
}

/**
 * Unpaired event callback for Roon.
 * @param {object} core The Roon core.
 */
function Unpaired(core) {
    if(Discord.Self() === undefined) return;
    Discord.Self().user?.clearActivity();
}

/** 目前正在顯示的 activity */
let CurrentActivity = null;
/** 上一次送出的歌曲 */
let LastSong = { key: null, start: 0 };
const SentActivities = new WeakSet();

let PreviousAlbumArt = {
    imageKey: DEFAULT_IMAGE,
    imageUrl: DEFAULT_IMAGE,
    uploading: false,
};

/**
 * Populate {@link PreviousAlbumArt} with the album art for a given Roon {@link image_key}, and update the current activity.
 * @param {object} core The Roon core.
 * @param {string} image_key The Roon image key tied to the given album.
 * @param {string} artist The artist.
 * @param {string} album The album title.
 * @param {string} track The track title.
 */
async function SetAlbumArt(core, image_key, artist, album, track) {
    if(!image_key || image_key === PreviousAlbumArt.imageKey || PreviousAlbumArt.uploading) return;
    PreviousAlbumArt.imageKey = image_key;
    PreviousAlbumArt.imageUrl = DEFAULT_IMAGE;

    if(Settings.imgurEnable) {
        PreviousAlbumArt.uploading = true;
        Imgur.GetAlbumArt(image_key, GetImage(new RoonApiImage(core))).then((art) => {
            PreviousAlbumArt.imageUrl = art;
            PreviousAlbumArt.uploading = false;
            Discord.Self().user?.setActivity({ largeImageKey: art });
        }).catch((err) => Warn(`Imgur fetch failed: ${err}`))
          .finally(() => PreviousAlbumArt.uploading = false);
    } else if(Settings.discogsEnable) {
        Discogs.Search(artist, album, track).then((result) => {
            if(result.cover_image) {
                PreviousAlbumArt.imageUrl = result.cover_image;
                Discord.Self().user?.setActivity({ largeImageKey: result.cover_image});
            } else {
                Info(`No album art found for '${track} - ${artist}' in Discogs`);
            }
        }).catch((err) => Warn(`Discogs search failed: ${err}`));
    }
}

/**
 * Formats a string for embedding in an activity.
 * @param {string} line The line to format.
 * @returns {string | undefined} The formatted line, or `undefined` if {@link line} is empty.
 */
function formatSongLine(line) {
    switch (line.length) {
        case 0: return undefined;
        case 1: line += " "; break;
    }

    return line.substring(0, 128);
}

/**
 * Song changed event which will update the Discord user activity.
 * @function SongChanged
 * @async
 * @param {object} core The Roon core.
 * @param {object} data The data provided by Roon zones.
 */
async function SongChanged(core, data) {
    switch(data.state) {
        case 'playing': break;
        case 'paused': Discord.Self().user?.clearActivity();
        default: LastSong = { key: null, start: 0 }; return;
    }

    const {
        image_key,
        length,
        seek_position,
        three_line,
    } = data.now_playing;

    const {
        line1: track,
        line2: artist,
        line3: album,
    } = three_line;

    const startTimestamp = Date.now() - (seek_position ?? 0) * 1000;
    const endTimestamp = startTimestamp + length * 1000;
    const songKey = `${data.zone_id}|${track}|${artist}|${album}|${length}`;

    // 同一首歌、進度正常前進 → 不重送，避免閃爍
    if(songKey === LastSong.key) {
        if(Math.abs(startTimestamp - LastSong.start) < 3000) return;
        // 使用者拖動進度條 → 只更新時間
        LastSong.start = startTimestamp;
        if(CurrentActivity) {
            CurrentActivity.startTimestamp = startTimestamp;
            CurrentActivity.endTimestamp = endTimestamp;
            Discord.Self()?.user?.setActivity(CurrentActivity);
        }
        return;
    }
    LastSong = { key: songKey, start: startTimestamp };

    const activity = {
        type: ActivityType.Listening,
        details: formatSongLine(track), // Track title
        state: formatSongLine(artist), // Track artist
        startTimestamp,
        endTimestamp,
        instance: false,
        smallImageKey: DEFAULT_IMAGE,
        smallImageText: `Listening at: ${data.display_name}`,
        largeImageKey: image_key === PreviousAlbumArt.imageKey ? PreviousAlbumArt.imageUrl : DEFAULT_IMAGE,
        largeImageText: (album)? formatSongLine(album) : `Listening at: ${data.display_name}`,
    };
    CurrentActivity = activity;

    // 先查原文名稱（有快取就是瞬間），查完才送，避免先顯示羅馬拼音再跳成日文
    const loc = await Localize(track, artist, album, length).catch(() => null);
    if(CurrentActivity !== activity) return;
    if(loc) {
        activity.details = formatSongLine(loc.track);
        activity.state = formatSongLine(loc.artist);
        if(loc.album) activity.largeImageText = formatSongLine(loc.album);
        Info(`Localized: ${loc.track} - ${loc.artist}`);
    }
    Discord.Self()?.user?.setActivity(activity);
    SentActivities.add(activity);

    if(
        !image_key
        || image_key === PreviousAlbumArt.imageKey
        || PreviousAlbumArt.uploading
    ) return;

    if(Settings.imgurEnable) {
        PreviousAlbumArt.uploading = true;
        Imgur.GetAlbumArt(image_key, GetImage(new RoonApiImage(core))).then((art) => {
            PreviousAlbumArt.imageKey = image_key;
            PreviousAlbumArt.imageUrl = art;
            PreviousAlbumArt.uploading = false;
            Discord.Self().user?.setActivity({ largeImageKey: art });
        }).catch(() => {});
    }

    if(!Settings.imgurEnable) {
        PreviousAlbumArt.imageKey = image_key;
        CoverArt.Search(artist, album, track).then(async (url) => {
            if(!url && Settings.discogsEnable) {
                const result = await Discogs.Search(artist, album, track).catch(() => ({}));
                url = result.cover_image;
            }
            if(url) Info(`Cover art: ${url}`);
            else Info(`No album art found for '${track} - ${artist}'`);
            PreviousAlbumArt.imageUrl = url || DEFAULT_IMAGE;
            if(CurrentActivity !== activity) return;
            activity.largeImageKey = PreviousAlbumArt.imageUrl;
            // 文字還沒送出時只改圖片，等文字一起送，避免先跳羅馬拼音
            if(SentActivities.has(activity)) Discord.Self()?.user?.setActivity(activity);
        }).catch(() => {});
    }

    if(false) {
        Discogs.Search(artist, album, track).then((result) => {
            if(result.cover_image) {
                PreviousAlbumArt.imageKey = image_key;
                PreviousAlbumArt.imageUrl = result.cover_image;
                Discord.Self().user?.setActivity({ largeImageKey: result.cover_image });
            } else {
                PreviousAlbumArt.imageKey = image_key;
                PreviousAlbumArt.imageUrl = DEFAULT_IMAGE;
                Discord.Self().user?.setActivity({ largeImageKey: DEFAULT_IMAGE });
            }
        }).catch(() => {});
    }
}

/**
 * Get buffer of image from Roon's API.
 * @function GetImage
 * @param {RoonApiImage} api Instance of RoonApiImage (node-roon-api-image)
 * @return {GetBuffer}
 */
function GetImage(api) {
    /**
     * Inner function for GetImage. Uses the RoonAPIImage instance to get the file buffer of the album image.
     * @function
     * @param {string} image_key Key of the album image.
     * @return {Promise<Buffer|string>} File buffer of the album image.
     */
    const GetBuffer = function(image_key) {
        return new Promise((resolve, reject) => {
            api.get_image(image_key, (error, content_type, image) => {
                if(error) reject(error);
    
                resolve(Buffer.from(image));
            });
        });
    }

    return GetBuffer;
}

if(require.main === module) {
    Initiate();
}

module.exports = {
    Initiate,
    InitiateIntegrations,
}
