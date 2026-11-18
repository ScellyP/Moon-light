/**
 * Moonlight Virtual Environment — Mock Android Bridge
 * Emulates com.scell.moonlight.MainActivity's @JavascriptInterface bridge in standard PC browsers.
 */
(function (root) {
  'use strict';

  // State store
  var eventsLog = [];
  var onEventListener = null;

  function logBridge(name, args, result) {
    var entry = {
      timestamp: new Date().toLocaleTimeString(),
      name: name,
      args: args,
      result: result
    };
    eventsLog.push(entry);
    if (eventsLog.length > 200) eventsLog.shift();
    if (typeof onEventListener === 'function') {
      try { onEventListener(entry); } catch (e) { /* ignore */ }
    }
  }

  // Web Audio Synthesizer for realistic playback simulation
  var audioCtx = null;
  var currentGain = null;
  var oscNodes = [];
  var isPlaying = false;
  var currentTrack = null;
  var playbackPosition = 0;
  var playbackDuration = 180;
  var positionTimer = null;
  var systemVolume = 0.8;
  var bluetoothConnected = false;

  function initAudioCtx() {
    if (!audioCtx) {
      var AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) audioCtx = new AudioContext();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  function startSynthSound(freqBase) {
    if (!audioCtx) return;
    stopSynthSound();
    var base = freqBase || 220; // A3
    var freqs = [base, base * 1.25, base * 1.5]; // Major chord
    var master = audioCtx.createGain();
    master.gain.setValueAtTime(0.08 * systemVolume, audioCtx.currentTime);
    master.connect(audioCtx.destination);
    currentGain = master;

    oscNodes = freqs.map(function (f) {
      var osc = audioCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, audioCtx.currentTime);
      osc.connect(master);
      osc.start();
      return osc;
    });
  }

  function stopSynthSound() {
    if (oscNodes && oscNodes.length) {
      oscNodes.forEach(function (osc) {
        try { osc.stop(); osc.disconnect(); } catch (e) {}
      });
      oscNodes = [];
    }
    if (currentGain) {
      try { currentGain.disconnect(); } catch (e) {}
      currentGain = null;
    }
  }

  function startPlaybackTimer() {
    stopPlaybackTimer();
    positionTimer = setInterval(function () {
      if (!isPlaying) return;
      playbackPosition += 0.25;
      if (typeof root.onNativeAudioPosition === 'function') {
        root.onNativeAudioPosition(playbackPosition);
      }
      if (playbackPosition >= playbackDuration) {
        stopPlaybackTimer();
        isPlaying = false;
        stopSynthSound();
        if (typeof root.onNativeAudioPlaying === 'function') root.onNativeAudioPlaying(false);
        if (typeof root.onNativeAudioEnded === 'function') root.onNativeAudioEnded();
      }
    }, 250);
  }

  function stopPlaybackTimer() {
    if (positionTimer) {
      clearInterval(positionTimer);
      positionTimer = null;
    }
  }

  // Helper to generate 16:9 YouTube video thumbnail for staged songs
  function makeThumbnail169(title) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360">' +
      '<defs>' +
        '<linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">' +
          '<stop offset="0%" stop-color="#1e1b4b"/>' +
          '<stop offset="50%" stop-color="#312e81"/>' +
          '<stop offset="100%" stop-color="#4338ca"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<rect width="100%" height="100%" fill="url(#bg)"/>' +
      '<circle cx="320" cy="160" r="65" fill="rgba(255,255,255,0.1)"/>' +
      '<polygon points="305,135 348,160 305,185" fill="#ffffff" opacity="0.9"/>' +
      '<text x="320" y="270" font-family="-apple-system, sans-serif" font-size="22" font-weight="700" fill="#ffffff" text-anchor="middle">' +
        (title || 'Downloaded YouTube Track').replace(/&/g, '&amp;') +
      '</text>' +
      '<text x="320" y="300" font-family="-apple-system, sans-serif" font-size="14" fill="rgba(255,255,255,0.7)" text-anchor="middle">16:9 Thumbnail (Tap to Crop)</text>' +
    '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  // Load sample data
  var sampleTracks = (root.SampleLibrary && root.SampleLibrary.tracks) || [];
  var samplePlaylists = (root.SampleLibrary && root.SampleLibrary.playlists) || [];

  // Persistence helpers
  function getStoredLibrary() {
    try {
      var raw = localStorage.getItem('moonlight_mock_tracks');
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return sampleTracks.slice();
  }

  function saveStoredLibrary(tracks) {
    try {
      localStorage.setItem('moonlight_mock_tracks', JSON.stringify(tracks));
    } catch (e) {}
  }

  function getStoredPlaylists() {
    try {
      var raw = localStorage.getItem('moonlight_mock_playlists');
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return samplePlaylists.slice();
  }

  function saveStoredPlaylists(pls) {
    try {
      localStorage.setItem('moonlight_mock_playlists', JSON.stringify(pls));
    } catch (e) {}
  }

  // Mock AndroidBridge Object
  var AndroidBridge = {
    // ---- System / Insets / Bluetooth ----
    isBluetoothAudioConnected: function () {
      logBridge('isBluetoothAudioConnected', [], bluetoothConnected);
      return bluetoothConnected;
    },
    setMockBluetooth: function (val) {
      bluetoothConnected = !!val;
    },
    getSystemVolume: function () {
      logBridge('getSystemVolume', [], systemVolume);
      return systemVolume;
    },
    setSystemVolume: function (vol) {
      systemVolume = Math.max(0, Math.min(1, Number(vol) || 0));
      if (currentGain && audioCtx) {
        currentGain.gain.setValueAtTime(0.08 * systemVolume, audioCtx.currentTime);
      }
      logBridge('setSystemVolume', [vol], true);
    },

    // ---- Audio Scanning ----
    scanAudioStartup: function () {
      logBridge('scanAudioStartup', []);
      var tracks = getStoredLibrary();
      setTimeout(function () {
        if (typeof root.onAudioListed === 'function') {
          root.onAudioListed(JSON.stringify(tracks));
        }
        if (typeof root.onNativeAudioReady === 'function') {
          root.onNativeAudioReady();
        }
      }, 50);
    },
    scanAudio: function () {
      logBridge('scanAudio', []);
      var tracks = getStoredLibrary();
      setTimeout(function () {
        if (typeof root.onAudioListed === 'function') {
          root.onAudioListed(JSON.stringify(tracks));
        }
      }, 100);
    },

    // ---- Native Audio Playback ----
    nativeAudioLoad: function (path, title, artist, album) {
      logBridge('nativeAudioLoad', [path, title, artist, album]);
      currentTrack = { path: path, title: title, artist: artist, album: album };
      var trk = getStoredLibrary().find(function (t) { return t.path === path; });
      playbackDuration = (trk && trk.durationSec) || 200;
      playbackPosition = 0;
      if (typeof root.onNativeAudioDuration === 'function') {
        root.onNativeAudioDuration(playbackDuration);
      }
      if (typeof root.onNativeAudioPosition === 'function') {
        root.onNativeAudioPosition(0);
      }
    },
    nativeAudioPlay: function () {
      logBridge('nativeAudioPlay', []);
      initAudioCtx();
      isPlaying = true;
      var hash = 0;
      if (currentTrack && currentTrack.title) {
        for (var i = 0; i < currentTrack.title.length; i++) hash += currentTrack.title.charCodeAt(i);
      }
      startSynthSound(200 + (hash % 200));
      startPlaybackTimer();
      if (typeof root.onNativeAudioPlaying === 'function') {
        root.onNativeAudioPlaying(true);
      }
    },
    nativeAudioPause: function () {
      logBridge('nativeAudioPause', []);
      isPlaying = false;
      stopSynthSound();
      stopPlaybackTimer();
      if (typeof root.onNativeAudioPlaying === 'function') {
        root.onNativeAudioPlaying(false);
      }
    },
    nativeAudioSeek: function (seconds) {
      logBridge('nativeAudioSeek', [seconds]);
      playbackPosition = Math.max(0, Math.min(playbackDuration, Number(seconds) || 0));
      if (typeof root.onNativeAudioPosition === 'function') {
        root.onNativeAudioPosition(playbackPosition);
      }
    },
    nativeAudioSetVolume: function (vol) {
      logBridge('nativeAudioSetVolume', [vol]);
      if (currentGain && audioCtx) {
        currentGain.gain.setValueAtTime(0.08 * (Number(vol) || 0), audioCtx.currentTime);
      }
    },
    nativeAudioSetBoostDb: function (db) {
      logBridge('nativeAudioSetBoostDb', [db]);
    },
    nativeAudioCrossfade: function (path, title, artist, album, seconds, outGain, inGain) {
      logBridge('nativeAudioCrossfade', [path, title, artist, album, seconds, outGain, inGain]);
      this.nativeAudioLoad(path, title, artist, album);
      this.nativeAudioPlay();
    },
    nativeAudioSyncState: function () {
      logBridge('nativeAudioSyncState', []);
      if (typeof root.onNativeAudioPlaying === 'function') {
        root.onNativeAudioPlaying(isPlaying);
      }
    },

    // ---- Artwork ----
    getArtwork: function (path) {
      var trk = getStoredLibrary().find(function (t) { return t.path === path; });
      if (trk && trk.cover) return trk.cover;
      if (path && path.indexOf('.staging') >= 0) {
        return makeThumbnail169('Downloaded Track (16:9)');
      }
      return makeThumbnail169('Sample Audio');
    },

    // ---- Playlists ----
    listPlaylists: function () {
      var pls = getStoredPlaylists();
      var formatted = pls.map(function (p) {
        return {
          id: p.id,
          name: p.name,
          title: p.title || p.name,
          source: p.source || 'user',
          description: p.description || '',
          songs: (p.songs || []).map(function (s) {
            return { ref: s, available: true };
          })
        };
      });
      var json = JSON.stringify(formatted);
      logBridge('listPlaylists', [], json.length + ' chars');
      return json;
    },
    savePlaylist: function (jsonStr, overwrite) {
      logBridge('savePlaylist', [jsonStr.slice(0, 100) + '...', overwrite]);
      try {
        var obj = JSON.parse(jsonStr);
        var pls = getStoredPlaylists();
        var idx = pls.findIndex(function (p) { return p.name === obj.name; });
        if (idx >= 0) {
          if (overwrite) pls[idx] = obj;
        } else {
          pls.push(obj);
        }
        saveStoredPlaylists(pls);
        return true;
      } catch (e) {
        return false;
      }
    },
    playlistCreate: function (name, description) {
      logBridge('playlistCreate', [name, description]);
      var pls = getStoredPlaylists();
      if (pls.some(function (p) { return p.name.toLowerCase() === name.trim().toLowerCase(); })) {
        return false; // already taken
      }
      pls.push({
        id: name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
        name: name.trim(),
        title: name.trim(),
        source: 'user',
        description: description || '',
        songs: []
      });
      saveStoredPlaylists(pls);
      return true;
    },
    playlistDelete: function (name) {
      logBridge('playlistDelete', [name]);
      var pls = getStoredPlaylists();
      var filtered = pls.filter(function (p) { return p.name !== name.trim(); });
      saveStoredPlaylists(filtered);
      return true;
    },
    playlistAddSong: function (name, path) {
      logBridge('playlistAddSong', [name, path]);
      var pls = getStoredPlaylists();
      var p = pls.find(function (x) { return x.name === name.trim(); });
      if (p) {
        p.songs = p.songs || [];
        if (p.songs.indexOf(path) < 0) p.songs.push(path);
        saveStoredPlaylists(pls);
        return true;
      }
      return false;
    },
    playlistRemoveSong: function (name, path) {
      logBridge('playlistRemoveSong', [name, path]);
      var pls = getStoredPlaylists();
      var p = pls.find(function (x) { return x.name === name.trim(); });
      if (p && p.songs) {
        p.songs = p.songs.filter(function (s) { return s !== path; });
        saveStoredPlaylists(pls);
        return true;
      }
      return false;
    },
    playlistCoverGet: function (key) {
      var covers = JSON.parse(localStorage.getItem('moonlight_playlist_covers') || '{}');
      return covers[key] || '';
    },
    playlistCoverSave: function (key, dataUri) {
      var covers = JSON.parse(localStorage.getItem('moonlight_playlist_covers') || '{}');
      covers[key] = dataUri;
      localStorage.setItem('moonlight_playlist_covers', JSON.stringify(covers));
      return true;
    },
    playlistCoverClear: function (key) {
      var covers = JSON.parse(localStorage.getItem('moonlight_playlist_covers') || '{}');
      delete covers[key];
      localStorage.setItem('moonlight_playlist_covers', JSON.stringify(covers));
      return true;
    },
    playlistShareLinks: function (fileName, text) {
      logBridge('playlistShareLinks', [fileName, text.slice(0, 100) + '...']);
      console.log('[MockBridge] Share playlist links (' + fileName + '):\n' + text);
      alert('Virtual Share Sheet opened for ' + fileName + ' with ' + text.split('\n').length + ' lines.');
      return true;
    },

    // ---- Settings File & Song Memory Data Files ----
    readSettingsFile: function () {
      var s = localStorage.getItem('moonlight_settings_txt') || '';
      logBridge('readSettingsFile', [], s.length + ' chars');
      return s;
    },
    writeSettingsFile: function (text) {
      localStorage.setItem('moonlight_settings_txt', text);
      logBridge('writeSettingsFile', [text.slice(0, 50) + '...'], true);
      return true;
    },
    readDataFile: function (name) {
      var d = localStorage.getItem('moonlight_file_' + name) || '';
      logBridge('readDataFile', [name], d.length + ' chars');
      return d;
    },
    writeDataFile: function (name, text) {
      localStorage.setItem('moonlight_file_' + name, text);
      logBridge('writeDataFile', [name, text.slice(0, 50) + '...'], true);
      return true;
    },

    // ---- Song Options & Editing ----
    songEditSave: function (path, title, artist, album) {
      logBridge('songEditSave', [path, title, artist, album]);
      var tracks = getStoredLibrary();
      var t = tracks.find(function (x) { return x.path === path; });
      if (t) {
        t.title = title || t.title;
        t.artist = artist || t.artist;
        t.album = album || t.album;
        saveStoredLibrary(tracks);
        return JSON.stringify(t);
      }
      return null;
    },
    songEditReset: function (path) {
      logBridge('songEditReset', [path]);
      return null;
    },
    songDelete: function (path) {
      logBridge('songDelete', [path]);
      var tracks = getStoredLibrary().filter(function (t) { return t.path !== path; });
      saveStoredLibrary(tracks);
      return true;
    },
    songShare: function (path) {
      logBridge('songShare', [path]);
      alert('[Virtual Android] Open Share Sheet with MP3: ' + path);
      return true;
    },
    shareText: function (text) {
      logBridge('shareText', [text]);
      alert('[Virtual Android] Open Share Sheet with link: ' + text);
      return true;
    },

    // ---- Download Wizard (SongDownloader) ----
    readClipboard: function () {
      var clip = sessionStorage.getItem('moonlight_mock_clipboard') || 'https://www.youtube.com/watch?v=sample_chapters_demo';
      logBridge('readClipboard', [], clip);
      return clip;
    },
    setMockClipboard: function (text) {
      sessionStorage.setItem('moonlight_mock_clipboard', text);
    },
    fetchPlaylistInfo: function (jobId, url) {
      logBridge('fetchPlaylistInfo', [jobId, url]);
      setTimeout(function () {
        var info = {
          title: 'Cyberpunk Odyssey (EP)',
          author: 'Synthwave Masters',
          coverArt: (root.SampleLibrary && root.SampleLibrary.makeCoverSvg('Cyberpunk Odyssey', 'Synthwave Masters', ['#4a044e', '#c026d3'])) || '',
          tracks: [
            { url: 'https://youtube.com/watch?v=cp_01', name: '01 - Awakening' },
            { url: 'https://youtube.com/watch?v=cp_02', name: '02 - Neon Rain' },
            { url: 'https://youtube.com/watch?v=cp_03', name: '03 - High Speed Chase' },
            { url: 'https://youtube.com/watch?v=cp_04', name: '04 - Sunrise Over Grid' }
          ]
        };
        if (typeof root.onPlaylistInfo === 'function') {
          root.onPlaylistInfo(jobId, JSON.stringify(info));
        }
      }, 400);
      return true;
    },
    stageSong: function (jobId, url) {
      logBridge('stageSong', [jobId, url]);
      var defaultTitle = 'Sample Downloaded Track';
      if (url && url.indexOf('watch?v=') >= 0) {
        var v = url.split('watch?v=')[1].split('&')[0];
        defaultTitle = 'Track ' + v.replace(/[^a-zA-Z0-9_-]/g, ' ').trim();
      }
      setTimeout(function () {
        var staged = '/Novel/Audio/.staging/' + jobId + '/' + defaultTitle + '.mp3';
        if (typeof root.onSongDownloadStatus === 'function') {
          root.onSongDownloadStatus(jobId, 'done', staged);
        }
      }, 600);
      return true;
    },
    placeSong: function (jobId, path, name, folder) {
      logBridge('placeSong', [jobId, path, name, folder]);
      setTimeout(function () {
        var targetFolder = folder ? '/Novel/Audio/' + folder : '/Novel/Audio';
        var finalName = (name || 'New Downloaded Song') + '.mp3';
        var finalPath = targetFolder + '/' + finalName;

        var tracks = getStoredLibrary();
        tracks.push({
          id: finalPath,
          path: finalPath,
          title: name || 'New Downloaded Song',
          artist: 'Downloaded Artist',
          album: folder || 'Downloads',
          durationSec: 195,
          folder: folder || '',
          playlist: folder || null,
          cover: (root.SampleLibrary && root.SampleLibrary.makeCoverSvg(name || 'New Song', 'Downloaded', ['#065f46', '#10b981'])) || ''
        });
        saveStoredLibrary(tracks);

        if (typeof root.onSongDownloadStatus === 'function') {
          root.onSongDownloadStatus(jobId, 'done', finalPath);
        }
      }, 300);
      return true;
    },
    songStageCrop: function (path, x, y, size) {
      logBridge('songStageCrop', [path, x, y, size]);
      return true;
    },
    discardStagedSongs: function () {
      logBridge('discardStagedSongs', []);
    },
    discardStagedSong: function (path) {
      logBridge('discardStagedSong', [path]);
      return true;
    },
    cancelSongDownload: function () {
      logBridge('cancelSongDownload', []);
    },
    notifyPlaylistProgress: function (title, done, total) {
      logBridge('notifyPlaylistProgress', [title, done, total]);
    },
    setBackgroundDownloads: function (enabled) {
      logBridge('setBackgroundDownloads', [enabled]);
    },

    // ---- Updates & YouTube Sign-in ----
    checkForUpdate: function () {
      logBridge('checkForUpdate', []);
      setTimeout(function () {
        if (typeof root.onUpdateState === 'function') {
          root.onUpdateState(JSON.stringify({ status: 'up_to_date', current: 'v1.16.19' }));
        }
      }, 500);
    },
    downloadUpdate: function () { logBridge('downloadUpdate', []); },
    installUpdate: function () { logBridge('installUpdate', []); },
    updateState: function () { return JSON.stringify({ status: 'idle' }); },
    getAutoUpdate: function () { return true; },
    setAutoUpdate: function (on) { logBridge('setAutoUpdate', [on]); },
    youtubeSignInStatus: function () { return 'signed-out'; },
    youtubeSignIn: function () {
      logBridge('youtubeSignIn', []);
      setTimeout(function () {
        if (typeof root.onYouTubeSignIn === 'function') {
          root.onYouTubeSignIn('signed-in', 'Successfully signed in as virtual user');
        }
      }, 800);
    },
    youtubeSignOut: function () {
      logBridge('youtubeSignOut', []);
      return true;
    },

    // ---- Testing Harness Hooks ----
    _getEventsLog: function () { return eventsLog; },
    _setEventListener: function (fn) { onEventListener = fn; },
    _resetData: function () {
      localStorage.removeItem('moonlight_mock_tracks');
      localStorage.removeItem('moonlight_mock_playlists');
      localStorage.removeItem('moonlight_playlist_covers');
      localStorage.removeItem('moonlight_settings_txt');
    }
  };

  root.AndroidBridge = AndroidBridge;
  console.log('[Moonlight Test Environment] Virtual AndroidBridge initialized.');

})(typeof window !== 'undefined' ? window : global);
