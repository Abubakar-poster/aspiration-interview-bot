const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "../../data/interview.db");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new sqlite3.Database(DB_FILE);

// Initialize tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id INTEGER UNIQUE,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      approved INTEGER DEFAULT 0,
      created_at INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS interviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      started_at INTEGER,
      finished_at INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      q_idx INTEGER,
      answer_text TEXT,
      meta TEXT,
      created_at INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      code TEXT,
      severity INTEGER,
      details TEXT,
      created_at INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      event TEXT,
      payload TEXT,
      created_at INTEGER
    )
  `);
});

// ------------------ HELPERS (promises) ------------------
function run(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// ------------------ FUNCTIONS ------------------
async function ensureCandidate(user) {
  let existing = await get(`SELECT * FROM candidates WHERE tg_id = ?`, [user.id]);
  if (existing) return existing.id;

  await run(
    `INSERT INTO candidates (tg_id, username, first_name, last_name, created_at) VALUES (?, ?, ?, ?, ?)`,
    [user.id, user.username || null, user.first_name || null, user.last_name || null, Date.now()]
  );

  const c = await get(`SELECT * FROM candidates WHERE tg_id = ?`, [user.id]);
  await run(`INSERT INTO interviews (candidate_id, started_at) VALUES (?, ?)`, [c.id, Date.now()]);
  return c.id;
}

async function approveCandidate(tgId) {
  await run(`UPDATE candidates SET approved = 1 WHERE tg_id = ?`, [tgId]);
  await exportCSV(); // auto update
}

async function revokeCandidate(tgId) {
  await run(`UPDATE candidates SET approved = 0 WHERE tg_id = ?`, [tgId]);
  await exportCSV(); // auto update
}

async function isApproved(tgId) {
  const c = await get(`SELECT * FROM candidates WHERE tg_id = ?`, [tgId]);
  return c && c.approved === 1;
}

async function storeAnswer(candidateId, qIdx, text, meta = {}) {
  await run(
    `INSERT INTO answers (candidate_id, q_idx, answer_text, meta, created_at) VALUES (?, ?, ?, ?, ?)`,
    [candidateId, qIdx, text, JSON.stringify(meta), Date.now()]
  );
  await exportCSV(); // auto update
}

async function flag(candidateId, code, severity = 1, details = {}) {
  await run(
    `INSERT INTO flags (candidate_id, code, severity, details, created_at) VALUES (?, ?, ?, ?, ?)`,
    [candidateId, code, severity, JSON.stringify(details), Date.now()]
  );
  await exportCSV(); // auto update
}

async function logEvent(candidateId, event, payload = {}) {
  await run(
    `INSERT INTO audit (candidate_id, event, payload, created_at) VALUES (?, ?, ?, ?)`,
    [candidateId, event, JSON.stringify(payload), Date.now()]
  );
}

async function sampleRecentAnswers(limit = 200) {
  return await all(
    `SELECT candidate_id, answer_text FROM answers ORDER BY id DESC LIMIT ?`,
    [limit]
  );
}

async function finalizeInterview(candidateId) {
  await run(
    `UPDATE interviews SET finished_at = ? WHERE candidate_id = ? AND finished_at IS NULL`,
    [Date.now(), candidateId]
  );
  await exportCSV(); // auto update
}

async function generateReport(candidateId = null) {
  const candidates = candidateId
    ? [await get(`SELECT * FROM candidates WHERE id = ?`, [candidateId])]
    : await all(`SELECT * FROM candidates ORDER BY id ASC`);

  let out = "";
  for (const c of candidates) {
    if (!c) continue;
    out += `Candidate #${c.id} (@${c.username || ""} | ${c.first_name || ""} ${c.last_name || ""})\n`;
    out += `  Approved: ${c.approved ? "✅ Yes" : "❌ No"}\n`;
    const flags = await all(
      `SELECT code, severity, created_at FROM flags WHERE candidate_id = ? ORDER BY created_at ASC`,
      [c.id]
    );
    if (flags.length) {
      out += "  Flags:\n";
      for (const f of flags) {
        out += `    - [sev ${f.severity}] ${f.code} (${new Date(f.created_at).toISOString()})\n`;
      }
    } else {
      out += "  Flags: none\n";
    }
    const answers = await all(
      `SELECT q_idx, answer_text, created_at FROM answers WHERE candidate_id = ? ORDER BY q_idx ASC`,
      [c.id]
    );
    out += "  Answers:\n";
    for (const a of answers) {
      out += `    Q${a.q_idx + 1}: ${a.answer_text.slice(0, 200)}\n`;
    }
    out += "\n";
  }
  return out || "No data.";
}

async function exportCSV() {
  const rows = await all(`
    SELECT c.id as candidate_id, c.username, c.first_name, c.last_name, c.approved,
           a.q_idx, a.answer_text, a.created_at as answer_at
    FROM answers a
    JOIN candidates c ON c.id = a.candidate_id
    ORDER BY c.id, a.q_idx
  `);
  const header =
    "candidate_id,username,first_name,last_name,approved,q_idx,answer_text,answer_at\n";
  const csv =
    header +
    rows
      .map((r) =>
        [
          r.candidate_id,
          r.username || "",
          r.first_name || "",
          r.last_name || "",
          r.approved,
          r.q_idx,
          JSON.stringify(r.answer_text).replace(/^"|"$/g, ""),
          r.answer_at,
        ].join(",")
      )
      .join("\n");

  const file = path.join(path.dirname(DB_FILE), "export.csv"); // always same file
  fs.writeFileSync(file, csv, "utf8");
  return file;
}

module.exports = {
  ensureCandidate,
  approveCandidate,
  revokeCandidate,
  isApproved,
  storeAnswer,
  flag,
  logEvent,
  sampleRecentAnswers,
  finalizeInterview,
  generateReport,
  exportCSV,
};
