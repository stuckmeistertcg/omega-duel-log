/**
 * Omega Duel Log — Google Drive drop box.
 *
 * Receives data packs from the website's Contribute tab, checks what is inside,
 * and saves each accepted pack as
 *     <your folder>/pending/<player id>/upload_<date>[_<name>].zip
 * Look them over, then move the ones you're happy with into <your folder>/approved
 * (or run approveAll() from the script editor). Analyse the approved folder.
 * Runs as you; contributors need no Google account. See README.md for setup.
 */

// Paste the ID of the Drive folder that should receive packs
// (the long code at the end of the folder's URL: drive.google.com/drive/folders/<ID>).
const FOLDER_ID = 'PASTE_YOUR_FOLDER_ID_HERE';

// true: new packs wait in "pending" for you to approve. false: they go straight to "approved".
const REVIEW_FIRST = true;

const LIMITS = {
  packBytes: 40 * 1024 * 1024,   // whole pack
  files: 6000,                   // files in one pack
  replayBytes: 2 * 1024 * 1024,  // one replay (real ones are ~2–20 KB)
  minReplayBytes: 200,
  deckBytes: 2 * 1024 * 1024,    // Player.data or a backup (real ones are a few KB)
  metaBytes: 10 * 1024,          // contributor.json
};

// The only files a pack may contain, relative to "<player id>/".
const ALLOWED = [
  // folder prefixes are optional in case unzip reports bare file names
  { re: /^(Replays\/Client\/)?\d\d_\d\d_\d\d-\d\d_\d\d_\d\d\.bytes$/, kind: 'replay', max: LIMITS.replayBytes, min: LIMITS.minReplayBytes },
  { re: /^Player\.data$/, kind: 'decks', max: LIMITS.deckBytes, min: 10 },
  { re: /^(Backup\/)?Player_[\w-]{1,20}\.data$/, kind: 'backup', max: LIMITS.deckBytes, min: 10 },
  { re: /^contributor\.json$/, kind: 'meta', max: LIMITS.metaBytes, min: 2 },
];

/**
 * Check the files inside a pack. entries: [{name, size, bytes(optional)}].
 * Returns {ok, error?, counts}. Pure function so it can be tested outside Google.
 */
function checkPack(entries, id) {
  const counts = { replay: 0, decks: 0, backup: 0, meta: 0 };
  if (entries.length > LIMITS.files) return { ok: false, error: 'Too many files in the pack.', counts };
  for (const e of entries) {
    if (e.name.slice(-1) === '/') continue;                          // folder entries
    let rel = e.name;
    if (rel.indexOf(id + '/') === 0) rel = rel.slice(id.length + 1);
    else if (rel.indexOf('/') >= 0) return { ok: false, error: 'Unexpected file outside the player folder: ' + e.name, counts };
    const rule = ALLOWED.filter(r => r.re.test(rel))[0];
    if (!rule) return { ok: false, error: 'Unexpected file in the pack: ' + rel, counts };
    if (e.size > rule.max || e.size < rule.min) return { ok: false, error: 'File has an unexpected size: ' + rel, counts };
    if (rule.kind === 'meta' && e.bytes) {
      try { JSON.parse(e.bytes); } catch (err) { return { ok: false, error: 'contributor.json is not valid.', counts }; }
    }
    counts[rule.kind]++;
  }
  if (!counts.replay) return { ok: false, error: 'The pack has no replays.', counts };
  if (counts.decks > 1) return { ok: false, error: 'The pack has more than one Player.data.', counts };
  return { ok: true, counts };
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const body = JSON.parse(e.postData.contents);
    const id = String(body.playerId || '');
    if (!/^\d{5,25}$/.test(id)) return reply({ ok: false, error: 'Missing or invalid player ID.' });

    const bytes = Utilities.base64Decode(String(body.zip || ''));
    if (!bytes.length) return reply({ ok: false, error: 'The pack was empty.' });
    if (bytes.length > LIMITS.packBytes) return reply({ ok: false, error: 'The pack is too large.' });
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return reply({ ok: false, error: 'That is not a zip file.' });

    let files;
    try { files = Utilities.unzip(Utilities.newBlob(bytes, 'application/zip', 'pack.zip')); }
    catch (err) { return reply({ ok: false, error: 'The zip could not be opened.' }); }
    const entries = files.map(f => {
      const n = f.getName();
      return { name: n, size: f.getBytes().length, bytes: /contributor\.json$/.test(n) ? f.getDataAsString() : null };
    });
    const check = checkPack(entries, id);
    if (!check.ok) return reply({ ok: false, error: check.error });

    const name = String(body.name || '').replace(/[^\w .-]/g, '').trim().slice(0, 40);
    const stamp = Utilities.formatDate(new Date(), 'UTC', "yyyy-MM-dd'T'HH-mm-ss'Z'");
    const fileName = 'upload_' + stamp + (name ? '_' + name : '') + '.zip';

    const root = DriveApp.getFolderById(FOLDER_ID);
    const folder = child(child(root, REVIEW_FIRST ? 'pending' : 'approved'), id);
    folder.createFile(Utilities.newBlob(bytes, 'application/zip', fileName));

    return reply({ ok: true, folder: id, file: fileName, replays: check.counts.replay, pending: REVIEW_FIRST });
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

/**
 * Run this from the script editor (select approveAll, click Run) to move every pending
 * pack into approved/<player id>/. To approve only some, move those zip files by hand in Drive.
 */
function approveAll() {
  const root = DriveApp.getFolderById(FOLDER_ID), pending = child(root, 'pending'), approved = child(root, 'approved');
  let moved = 0;
  const players = pending.getFolders();
  while (players.hasNext()) {
    const p = players.next(), dest = child(approved, p.getName()), files = p.getFiles();
    while (files.hasNext()) { files.next().moveTo(dest); moved++; }
  }
  Logger.log('Moved ' + moved + ' pack(s) to approved.');
}

// Visiting the web app URL in a browser shows this: a quick way to check it is deployed.
function doGet() {
  return reply({ ok: true, service: 'Omega Duel Log drop box', folderConfigured: FOLDER_ID !== 'PASTE_YOUR_FOLDER_ID_HERE', reviewFirst: REVIEW_FIRST });
}

function child(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
