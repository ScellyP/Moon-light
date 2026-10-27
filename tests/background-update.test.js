// Run with: node tests/background-update.test.js
// The background updater (BackgroundUpdater.kt). It needs a device, so this checks that the pieces
// agree with each other: manifest entries, the JobScheduler setup, the safety rules, the switch.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KT = path.join(ROOT, 'app/src/main/java/com/scell/moonlight');
const read = (p) => fs.readFileSync(p, 'utf8');
const bg = read(path.join(KT, 'BackgroundUpdater.kt'));
const main = read(path.join(KT, 'MainActivity.kt'));
const playback = read(path.join(KT, 'PlaybackService.kt'));
const updater = read(path.join(KT, 'AppUpdater.kt'));
const manifest = read(path.join(ROOT, 'app/src/main/AndroidManifest.xml'));

let n = 0;
function check(name, fn) { try { fn(); } catch (e) { console.log('FAIL -', name); throw e; } n++; console.log('ok -', name); }

check('the job service and the install receiver are in the manifest, private, and bound correctly', () => {
  assert.ok(/<service[^>]*android:name="\.UpdateJobService"[^>]*android:permission="android\.permission\.BIND_JOB_SERVICE"[^>]*android:exported="false"/s.test(manifest));
  assert.ok(/<receiver[^>]*android:name="\.UpdateInstallReceiver"[^>]*android:exported="false"/s.test(manifest));
  assert.ok(/class UpdateJobService : JobService\(\)/.test(bg));
  assert.ok(/class UpdateInstallReceiver : BroadcastReceiver\(\)/.test(bg));
});

check('a persisted job needs RECEIVE_BOOT_COMPLETED (without it schedule() throws)', () => {
  assert.ok(/setPersisted\(true\)/.test(bg));
  assert.ok(manifest.includes('android.permission.RECEIVE_BOOT_COMPLETED'));
});

check('the periodic job: unmetered network, 6 hours, API-guarded calls only', () => {
  assert.ok(/NETWORK_TYPE_UNMETERED/.test(bg));
  assert.ok(/PERIOD_MS = 6L \* 60 \* 60 \* 1000/.test(bg));
  assert.ok(/SDK_INT >= Build\.VERSION_CODES\.O\) builder\.setRequiresBatteryNotLow/.test(bg));   // API 26, minSdk is 24
  assert.ok(/getPendingJob\(JOB_PERIODIC\) != null\) return/.test(bg), 'must not reschedule on every launch');
  assert.ok(/NotificationChannel/.test(bg) && /SDK_INT >= Build\.VERSION_CODES\.O/.test(bg));
});

check('it reads the same repo and the same version rules as the in-app updater', () => {
  assert.ok(bg.includes('${AppUpdater.OWNER_REPO}'));
  assert.ok(/AppUpdater\.isNewer\(/.test(bg) && /AppUpdater\.versionFromScript\(/.test(bg));
  assert.ok(/const val OWNER_REPO/.test(updater));
});

check('it obeys the "Update automatically" switch, and the switch (de)schedules the job', () => {
  assert.ok(/getSharedPreferences\("updater"/.test(bg) && /getBoolean\("auto", true\)/.test(bg));
  assert.ok(/PREFS = "updater"/.test(updater) && /KEY_AUTO = "auto"/.test(updater));
  assert.ok(/if \(!autoEnabled\(context\)\) \{[^}]*scheduler\.cancel\(JOB_PERIODIC\)/s.test(bg));
  assert.ok(/fun setAutoUpdate\(on: Boolean\) \{[^}]*BackgroundUpdater\.schedule\(/s.test(main));
  assert.ok(/BackgroundUpdater\.schedule\(applicationContext\)/.test(main));
});

check('it stays out of the way: app open, music playing, a download running', () => {
  assert.ok(/if \(MainActivity\.inForeground\) return/.test(bg));
  assert.ok(/PlaybackService\.playingNow/.test(bg) && /MainActivity\.busyCheck\?\.invoke\(\) == true/.test(bg));
  assert.ok(/scheduleRetry\(context\)/.test(bg));
  assert.ok(/inForeground = true/.test(main) && /inForeground = false/.test(main));
  assert.ok(/busyCheck = \{ songDownloader\.isBusy\(\) \|\| appUpdater\.isBusy\(\) \}/.test(main));
  assert.ok(/var playingNow: Boolean = false/.test(playback) && /playingNow = isPlaybackActive\(p\)/.test(playback));
});

check('downloads are verified and use their own temp name (the in-app updater deletes *.part)', () => {
  assert.ok(/"\$name\.bg"/.test(bg));
  assert.ok(/written != release\.size/.test(bg) && /got != expected/.test(bg));
  assert.ok(/isMetered\(\)\) return null/.test(bg));
});

check('install: silent when Android allows it, otherwise a notification (no activity from the background)', () => {
  assert.ok(/USER_ACTION_NOT_REQUIRED/.test(bg));
  assert.ok(/STATUS_PENDING_USER_ACTION/.test(bg) && /notifyUpdate\(/.test(bg));
  assert.ok(/FLAG_IMMUTABLE/.test(bg));
  assert.ok(!/startActivity\(/.test(bg), 'a background service may not start the install screen');
  assert.ok(/setClass\(context, UpdateInstallReceiver::class\.java\)/.test(bg));
});

check('the notification icon exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'app/src/main/res/drawable/ic_stat_music.xml')));
  assert.ok(/R\.drawable\.ic_stat_music/.test(bg));
});

console.log(n + ' checks passed');
