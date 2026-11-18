/**
 * Moonlight Virtual Environment — Sample Audio Library
 * Provides realistic mock tracks, cover artwork, and playlist records for browser testing.
 */
(function (root) {
  'use strict';

  // Helper to generate SVG cover art as Data URI
  function makeCoverSvg(title, artist, bgGradient) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">' +
      '<defs>' +
        '<linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">' +
          '<stop offset="0%" stop-color="' + bgGradient[0] + '"/>' +
          '<stop offset="100%" stop-color="' + bgGradient[1] + '"/>' +
        '</linearGradient>' +
        '<filter id="glow"><feGaussianBlur stdDeviation="8" result="coloredBlur"/><feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
      '</defs>' +
      '<rect width="100%" height="100%" fill="url(#g)"/>' +
      '<circle cx="200" cy="180" r="90" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="4"/>' +
      '<path d="M190 140 L240 180 L190 220 Z" fill="#ffffff" opacity="0.85" filter="url(#glow)"/>' +
      '<text x="200" y="320" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="22" font-weight="700" fill="#ffffff" text-anchor="middle" opacity="0.95">' +
        title.replace(/&/g, '&amp;').replace(/</g, '&lt;') +
      '</text>' +
      '<text x="200" y="350" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="15" font-weight="500" fill="rgba(255,255,255,0.7)" text-anchor="middle">' +
        artist.replace(/&/g, '&amp;').replace(/</g, '&lt;') +
      '</text>' +
    '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  var SAMPLE_TRACKS = [
    {
      id: '/Novel/Audio/Moonlight Serenade.mp3',
      path: '/Novel/Audio/Moonlight Serenade.mp3',
      title: 'Moonlight Serenade',
      artist: 'Lunar Collective',
      album: 'Celestial Dreams',
      durationSec: 214,
      folder: '',
      playlist: null,
      source: 'https://youtube.com/watch?v=moonlight_01',
      cover: makeCoverSvg('Moonlight Serenade', 'Lunar Collective', ['#1e1b4b', '#4338ca']),
      trackNumber: 1,
      bitrateKbps: 320,
    },
    {
      id: '/Novel/Audio/Neon Horizons.mp3',
      path: '/Novel/Audio/Neon Horizons.mp3',
      title: 'Neon Horizons',
      artist: 'Cyberwave',
      album: 'Retrofuturism',
      durationSec: 188,
      folder: '',
      playlist: null,
      source: 'https://youtube.com/watch?v=neon_02',
      cover: makeCoverSvg('Neon Horizons', 'Cyberwave', ['#831843', '#db2777']),
      trackNumber: 2,
      bitrateKbps: 320,
    },
    {
      id: '/Novel/Audio/Lofi/Rainy Night In Tokyo.mp3',
      path: '/Novel/Audio/Lofi/Rainy Night In Tokyo.mp3',
      title: 'Rainy Night In Tokyo',
      artist: 'Komorebi Beats',
      album: 'Coffee & Rain',
      durationSec: 165,
      folder: 'Lofi',
      playlist: 'Lofi',
      source: 'https://youtube.com/watch?v=tokyo_rain_03',
      cover: makeCoverSvg('Rainy Night In Tokyo', 'Komorebi Beats', ['#14532d', '#15803d']),
      trackNumber: 1,
      bitrateKbps: 256,
    },
    {
      id: '/Novel/Audio/Lofi/Morning Dew.mp3',
      path: '/Novel/Audio/Lofi/Morning Dew.mp3',
      title: 'Morning Dew',
      artist: 'Komorebi Beats',
      album: 'Coffee & Rain',
      durationSec: 195,
      folder: 'Lofi',
      playlist: 'Lofi',
      source: 'https://youtube.com/watch?v=morning_dew_04',
      cover: makeCoverSvg('Morning Dew', 'Komorebi Beats', ['#14532d', '#15803d']),
      trackNumber: 2,
      bitrateKbps: 256,
    },
    {
      id: '/Novel/Audio/Rock/Electric Thunder.mp3',
      path: '/Novel/Audio/Rock/Electric Thunder.mp3',
      title: 'Electric Thunder',
      artist: 'Static Surge',
      album: 'Overdrive',
      durationSec: 242,
      folder: 'Rock',
      playlist: 'Rock',
      source: 'https://youtube.com/watch?v=thunder_05',
      cover: makeCoverSvg('Electric Thunder', 'Static Surge', ['#7f1d1d', '#dc2626']),
      trackNumber: 1,
      bitrateKbps: 320,
    },
    {
      id: '/Novel/Audio/Deep Space Wanderer.mp3',
      path: '/Novel/Audio/Deep Space Wanderer.mp3',
      title: 'Deep Space Wanderer',
      artist: 'Starlight Symphony',
      album: 'Cosmos',
      durationSec: 310,
      folder: '',
      playlist: null,
      source: 'https://youtube.com/watch?v=cosmos_06',
      cover: makeCoverSvg('Deep Space Wanderer', 'Starlight Symphony', ['#0f172a', '#334155']),
      trackNumber: 1,
      bitrateKbps: 320,
      chapters: [
        { title: 'Launch', start_time: 0, end_time: 65 },
        { title: 'Leaving Orbit', start_time: 65, end_time: 140 },
        { title: 'The Void', start_time: 140, end_time: 230 },
        { title: 'Beyond Galaxies', start_time: 230, end_time: 310 }
      ]
    },
    {
      id: '/Novel/Audio/Acoustic Memories.mp3',
      path: '/Novel/Audio/Acoustic Memories.mp3',
      title: 'Acoustic Memories',
      artist: 'Solitary Strings',
      album: 'Wood & Wire',
      durationSec: 172,
      folder: '',
      playlist: null,
      source: 'https://youtube.com/watch?v=acoustic_07',
      cover: makeCoverSvg('Acoustic Memories', 'Solitary Strings', ['#78350f', '#d97706']),
      trackNumber: 1,
      bitrateKbps: 256,
    },
    {
      id: '/Novel/Audio/Midnight Odyssey (Full Audiobook).mp3',
      path: '/Novel/Audio/Midnight Odyssey (Full Audiobook).mp3',
      title: 'Midnight Odyssey (Full Audio)',
      artist: 'Storyteller Studios',
      album: 'Midnight Chronicles',
      durationSec: 720,
      folder: '',
      playlist: null,
      source: 'https://youtube.com/watch?v=odyssey_full_08',
      cover: makeCoverSvg('Midnight Odyssey', 'Storyteller Studios', ['#311042', '#701a75']),
      trackNumber: 1,
      bitrateKbps: 320,
      chapters: [
        { title: 'Chapter 1: The Call', start_time: 0, end_time: 150 },
        { title: 'Chapter 2: Into the Shadow', start_time: 150, end_time: 320 },
        { title: 'Chapter 3: The Secret Vault', start_time: 320, end_time: 510 },
        { title: 'Chapter 4: The Final Reckoning', start_time: 510, end_time: 720 }
      ]
    }
  ];

  var SAMPLE_PLAYLISTS = [
    {
      id: 'favorites',
      name: 'Favorites',
      title: 'Favorites',
      source: 'user',
      description: 'Your favorite tracks in one place',
      songs: [
        '/Novel/Audio/Moonlight Serenade.mp3',
        '/Novel/Audio/Lofi/Rainy Night In Tokyo.mp3',
        '/Novel/Audio/Neon Horizons.mp3'
      ]
    },
    {
      id: 'night_drive',
      name: 'Night Drive',
      title: 'Night Drive',
      source: 'user',
      description: 'Atmospheric synthwave and late-night sounds',
      songs: [
        '/Novel/Audio/Neon Horizons.mp3',
        '/Novel/Audio/Deep Space Wanderer.mp3'
      ]
    },
    {
      id: 'lofi_study',
      name: 'Lofi Study',
      title: 'Lofi Study',
      source: 'folder',
      description: 'Peaceful beats to study and relax to',
      songs: [
        '/Novel/Audio/Lofi/Rainy Night In Tokyo.mp3',
        '/Novel/Audio/Lofi/Morning Dew.mp3'
      ]
    }
  ];

  root.SampleLibrary = {
    tracks: SAMPLE_TRACKS,
    playlists: SAMPLE_PLAYLISTS,
    makeCoverSvg: makeCoverSvg
  };

})(typeof window !== 'undefined' ? window : global);
