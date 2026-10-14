// Foldernator on a real Mac (GitHub Actions): starts the packaged app and uses it through its own window API —
// list, new folder, rename, status colour (+ the Finder tag), copy, Move to Trash, disks, sidebar places — and takes a
// screenshot. Run from the repo root after mac/build.sh packaged it:  node mac/foldernator-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron } = require(path.join(__dirname, '..', 'Foldernator', 'node_modules', 'playwright-core'));

const OUT = path.join(__dirname, '..', 'out');
const APP = path.join(OUT, 'apps', 'Foldernator.app', 'Contents', 'MacOS', 'Foldernator');
let fail = 0;
const ok = (t) => console.log('PASS  ' + t);
const bad = (t) => { console.log('FAIL  ' + t); fail = 1; };
const check = (cond, t) => (cond ? ok(t) : bad(t));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'old.txt'), 'bye');
  fs.mkdirSync(path.join(dir, 'Inbox'));

  const app = await _electron.launch({ executablePath: APP, args: [dir], env: { ...process.env, ALVA_QA: '1' }, timeout: 60000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.api && document.querySelector('#tabs'), null, { timeout: 30000 });
  await page.waitForTimeout(2500);

  const call = (fn, ...args) => page.evaluate(([f, a]) => window.api[f](...a), [fn, args]);
  try {
    const l = await call('list', dir);
    check(l.items.map((i) => i.n).sort().join(',') === 'Inbox,notes.txt,old.txt', `lists a folder (${l.items.map((i) => i.n).join(', ')})`);

    const made = await call('mkdir', dir, 'New Folder');
    check(fs.existsSync(made), 'makes a new folder');
    const renamed = await call('rename', made, 'Projects');
    check(renamed === path.join(dir, 'Projects') && fs.existsSync(renamed), 'renames it');

    const st = await call('setStatus', { paths: [renamed], status: 'Done', color: '#22c55e' });
    check(st.results[0] && st.results[0].ok, `gives it a status colour ${JSON.stringify(st.results[0])}`);
    let tags = '';
    try { tags = execFileSync('/usr/bin/xattr', ['-p', 'com.apple.metadata:_kMDItemUserTags', renamed], { encoding: 'latin1' }); } catch {}
    check(/Done/.test(tags), 'the status shows as a Finder tag');
    const l2 = await call('list', dir);
    const pj = l2.items.find((i) => i.n === 'Projects');
    check(pj && pj.st === 'Done' && pj.col === '#22c55e', 'reads the status back');
    check(!l2.items.some((i) => i.n === '.foldernator'), 'keeps its status file hidden');

    await call('fileOp', { op: 'copy', paths: [path.join(dir, 'notes.txt')], to: path.join(dir, 'Inbox') });
    check(fs.existsSync(path.join(dir, 'Inbox', 'notes.txt')), 'copies a file');
    await call('fileOp', { op: 'copy', paths: [path.join(dir, 'notes.txt')], to: dir });
    check(fs.existsSync(path.join(dir, 'notes 2.txt')), 'a copy into the same folder becomes "notes 2.txt"');
    await call('fileOp', { op: 'recycle', paths: [path.join(dir, 'old.txt')] });
    check(!fs.existsSync(path.join(dir, 'old.txt')), 'moves a file to the Trash');

    const drives = await call('drives');
    check(drives.some((d) => d.path === '/' && d.total > 0), `reads the disks (${drives.map((d) => d.label).join(', ')})`);
    const qa = await call('quickAccess');
    check(qa.some((x) => /Documents$/.test(x.path)), `sidebar places (${qa.map((x) => x.name).join(', ')})`);

    await call('setClipboardFiles', { paths: [path.join(dir, 'notes.txt')], cut: false });
    const clip = await call('getClipboardFiles');
    check(clip.paths[0] === path.join(dir, 'notes.txt'), 'copies a file to the clipboard (Finder can paste it)');

    fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
    await page.screenshot({ path: path.join(OUT, 'shots', 'foldernator-mac.png') });
    ok('screenshot');
  } catch (e) {
    bad('test crashed: ' + (e.stack || e.message));
  } finally {
    await app.close().catch(() => {});
  }
  process.exit(fail);
})();
