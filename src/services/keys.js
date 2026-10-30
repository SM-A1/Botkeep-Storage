// Redis key layout (schema v2). Keys marked [A] are AUTHORITATIVE (included in backups);
// keys marked [D] are DERIVED indexes that can always be rebuilt from the authoritative ones.
export const K = {
  file: (id) => `file:${id}`, // [A] hash  file metadata (legacy layout, extended in v2)
  share: (token) => `share:${token}`, // [A] hash  one share link
  profile: (uid) => `u:${uid}`, // [A] hash  user profile + settings (counters inside are [D])
  folders: (uid) => `folders:${uid}`, // [A] hash  folderId -> name
  hist: (id) => `hist:${id}`, // [A] list  per-file history (capped)
  report: (id) => `report:${id}`, // [A] hash  abuse report
  audit: 'audit', // [A] stream audit log (capped)
  users: 'users', // [A] set    legacy user index
  maintenance: 'state:maintenance', // [A]
  downloadsTotal: 'stats:downloads', // [A]
  coll: (id) => `coll:${id}`, // [A] hash  file collection (one upload batch = one collection)
  collFiles: (id) => `collf:${id}`, // [A] zset  file ids of a collection (score = position)
  cshare: (token) => `cshare:${token}`, // [A] hash  the ONE public share link of a collection
  fsubChannel: (id) => `fsub:ch:${id}`, // [A] hash  one Force Subscribe channel (name, chat id, button, url, enabled, ...)
  fsubIds: 'fsub:ids', // [A] zset  Force Subscribe channel ids by creation time (display order)
  fsubSeeded: 'fsub:seeded', // [A] string  set once FORCE_SUB_SEED has been applied (a deleted channel is never re-seeded)
  schema: 'meta:schema', // [A]
  dbId: 'meta:dbid', // [A] database fingerprint
  dbCreated: 'meta:created', // [A]

  userFiles: (uid) => `user:${uid}:files`, // [D] zset  fileId by upload time
  userCat: (uid, cat) => `user:${uid}:files:${cat}`, // [D] zset
  userFolder: (uid, fid) => `user:${uid}:folder:${fid}`, // [D] zset
  userShares: (uid) => `ushares:${uid}`, // [D] zset  share token by creation time
  fileShares: (id) => `fshares:${id}`, // [D] set   share tokens of a file
  search: (uid, prefix) => `sx:${uid}:${prefix}`, // [D] set   file ids by filename-word prefix
  ustats: (uid) => `ustats:${uid}`, // [D] hash
  gstats: 'gstats', // [D] hash
  uname: (lower) => `uname:${lower}`, // [D] string username -> user id
  ref: (ref) => `ref:${ref}`, // [D] string short ref -> file id
  expFiles: 'exp:files', // [D] zset  file ids by expiry time
  usersCreated: 'users:created', // [D] zset
  usersActive: 'users:active', // [D] zset
  reportsOpen: 'reports:open', // [D] zset
  userColls: (uid) => `ucoll:${uid}`, // [D] zset  collection id by creation time
  allColls: 'colls:all', // [D] zset  every collection id by creation time (admin list)
  collRef: (ref) => `collref:${ref}`, // [D] string short ref -> collection id

  // transient (never backed up): rl:*, lock:*, await:*, unlock:*, sq:*, sec:*, rpt:*, state:lastBackup, upl:*, cdl:*,
  // fsub:ok:* (short membership cache), fsub:draft:* (admin wizard), fsub:pending:* (deep link waiting for verification)
  fsubOk: (uid, id) => `fsub:ok:${uid}:${id}`,
  fsubDraft: (uid) => `fsub:draft:${uid}`,
  fsubPending: (uid) => `fsub:pending:${uid}`,
};

/** SCAN patterns of the authoritative key families (used by backup / empty-database checks). */
export const AUTHORITATIVE_PATTERNS = ['file:*', 'share:*', 'u:*', 'folders:*', 'hist:*', 'report:*', 'coll:*', 'collf:*', 'cshare:*', 'fsub:ch:*'];
export const AUTHORITATIVE_FIXED = [K.audit, K.users, K.maintenance, K.downloadsTotal, K.schema, K.dbId, K.dbCreated, K.fsubIds, K.fsubSeeded];
/** SCAN patterns of derived indexes (safe to delete + rebuild). */
export const DERIVED_PATTERNS = ['user:*', 'ushares:*', 'fshares:*', 'sx:*', 'ustats:*', 'uname:*', 'ref:*', 'ucoll:*', 'collref:*'];
export const DERIVED_FIXED = [K.gstats, K.expFiles, K.usersCreated, K.usersActive, K.reportsOpen, K.allColls];
