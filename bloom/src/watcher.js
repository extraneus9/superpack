// Watches Windows' own notification store (wpndatabase.db) and reports every new toast.
// Read-only: Windows keeps writing it, we only read new rows. A folder watch wakes us instantly,
// a slow poll is the safety net in case a write slips past the watch.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DIR = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Notifications');
const DB = path.join(DIR, 'wpndatabase.db');

const SQL = `
  select n.[Order] o, n.Id id, n.Payload payload, h.PrimaryId aumid, tt.SuppressPopup suppress, n.Tag tag,
         (select AssetValue from HandlerAssets a where a.HandlerId = h.RecordId and a.AssetKey = 'DisplayName') displayName
  from Notification n
  join NotificationHandler h on h.RecordId = n.HandlerId
  left join TransientTable tt on tt.NotificationId = n.Id
  where (n.[Order] > ? or n.Id > ?) and n.Type = 'toast'
  order by n.[Order]`;

class Watcher {
  constructor(onToast, { acceptSuppressed = false } = {}) {
    this.onToast = onToast;
    this.acceptSuppressed = acceptSuppressed;
    this.seen = new Set(); // toast ids already shown: an app updating its toast (progress etc.) must not pop again
  }

  open() {
    this.db = new DatabaseSync(DB, { readOnly: true });
    this.q = this.db.prepare(SQL);
    this.qMax = this.db.prepare('select coalesce(max([Order]), 0) m, coalesce(max(Id), 0) i from Notification');
  }

  // catchUpSec > 0: also deliver toasts that arrived in the last N seconds (used at sign-in, when apps like
  // NVIDIA post before bloom is up; on 2026-10-17 one landed 17 s before bloom started and was missed).
  start(catchUpSec = 0) {
    this.open();
    if (catchUpSec > 0) {
      const cutoff = BigInt(Date.now() - catchUpSec * 1000 + 11644473600000) * 10000n; // FILETIME of (now - catchUp)
      const r = this.db.prepare("select coalesce(max([Order]), 0) m, coalesce(max(Id), 0) i from Notification where ArrivalTime < ?").get(cutoff);
      this.last = Number(r.m); this.lastId = Number(r.i);
      setTimeout(() => this.check(), 1500); // after the overlay and sound are loaded
    } else {
      const r = this.qMax.get(); this.last = Number(r.m); this.lastId = Number(r.i); // only what arrives from now on
    }
    try {
      this.fsw = fs.watch(DIR, (_e, f) => { if (!f || String(f).startsWith('wpndatabase')) this.kick(); });
    } catch { /* poll still covers it */ }
    this.timer = setInterval(() => this.check(), 1500);
  }

  kick() { clearTimeout(this.k); this.k = setTimeout(() => this.check(), 40); }

  check() {
    let rows;
    try {
      // A toast that REPLACES an earlier one (Snipping Tool on every new screenshot) gets a new Id but keeps the old
      // one's Order, so Order alone missed it (the author's 2nd screenshot, 2026-10-19). New Ids count too.
      rows = this.q.all(this.last, this.lastId);
      if (!rows.length) {
        const r = this.qMax.get();
        if (Number(r.m) < this.last) this.last = Number(r.m); // store was compacted/reset
        if (Number(r.i) < this.lastId) this.lastId = Number(r.i);
        return;
      }
    } catch {
      try { this.db.close(); } catch {}
      try { this.open(); } catch {}
      return;
    }
    for (const r of rows) {
      this.last = Math.max(this.last, Number(r.o));
      const id = Number(r.id);
      this.lastId = Math.max(this.lastId, id);
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
      if (r.suppress && !this.acceptSuppressed) continue; // the app asked for no popup
      if (r.tag === 'bloomqa' && !this.acceptSuppressed) continue; // bloom's own silent QA toast: never on screen
      try { this.onToast({ id, aumid: r.aumid, displayName: r.displayName, payload: r.payload }); } catch (e) { console.error(e); }
    }
  }

  stop() {
    clearInterval(this.timer); clearTimeout(this.k);
    try { this.fsw && this.fsw.close(); } catch {}
    try { this.db && this.db.close(); } catch {}
  }
}

module.exports = { Watcher, DB };
