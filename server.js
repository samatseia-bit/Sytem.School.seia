const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./db');

const SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const wrap = (fn) => (req, res) => {
  try { fn(req, res); }
  catch (e) {
    const msg = String(e.message || e);
    if (msg.startsWith('INVALID:')) return res.status(400).json({ error: msg.slice(8).trim() });
    if (msg.includes('UNIQUE')) return res.status(400).json({ error: 'ទិន្នន័យនេះមានរួចហើយ (ស្ទួន)' });
    if (msg.includes('FOREIGN KEY')) return res.status(400).json({ error: 'ទិន្នន័យពាក់ព័ន្ធមិនត្រឹមត្រូវ' });
    if (msg.includes('NOT NULL')) return res.status(400).json({ error: 'សូមបំពេញព័ត៌មានដែលចាំបាច់' });
    console.error(e);
    res.status(500).json({ error: msg });
  }
};

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'សូមចូលប្រើប្រព័ន្ធជាមុនសិន' });
  try { req.user = jwt.verify(token, SECRET); next(); }
  catch { res.status(401).json({ error: 'សម័យចូលប្រើផុតកំណត់' }); }
}
const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'តែអ្នកគ្រប់គ្រងប៉ុណ្ណោះដែលអាចធ្វើបាន' });

// ---------- auth ----------
app.post('/api/login', wrap((req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!u || !bcrypt.compareSync(password || '', u.password_hash))
    return res.status(401).json({ error: 'ឈ្មោះអ្នកប្រើ ឬ លេខសម្ងាត់មិនត្រឹមត្រូវ' });
  const user = { id: u.id, username: u.username, role: u.role, full_name: u.full_name };
  res.json({ token: jwt.sign(user, SECRET, { expiresIn: '12h' }), user });
}));

const PUBLIC_KEYS = ['system_name', 'system_title', 'system_tagline', 'theme', 'school_name'];
app.get('/api/public-settings', wrap((req, res) => {
  const o = {}; db.prepare('SELECT key,value FROM settings').all().forEach((r) => { if (PUBLIC_KEYS.includes(r.key)) o[r.key] = r.value; });
  res.json(o);
}));

app.use('/api', auth);
app.get('/api/me', (req, res) => res.json(req.user));
// everybody can edit their own display name / password
app.put('/api/me', wrap((req, res) => {
  const { full_name, password, current_password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!u) return res.status(404).json({ error: 'រកមិនឃើញគណនី' });
  if (full_name !== undefined && !String(full_name).trim()) throw new Error('INVALID: សូមបញ្ចូលឈ្មោះ');
  if (password) {
    if (String(password).length < 6) throw new Error('INVALID: លេខសម្ងាត់ត្រូវមានយ៉ាងតិច ៦ តួ');
    if (!bcrypt.compareSync(current_password || '', u.password_hash)) throw new Error('INVALID: លេខសម្ងាត់បច្ចុប្បន្នមិនត្រឹមត្រូវ');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(String(password), 10), u.id);
  }
  if (full_name !== undefined) db.prepare('UPDATE users SET full_name=? WHERE id=?').run(String(full_name).trim(), u.id);
  const f = db.prepare('SELECT id,username,role,full_name FROM users WHERE id=?').get(u.id);
  res.json({ token: jwt.sign(f, SECRET, { expiresIn: '12h' }), user: f });
}));

// ---------- generic CRUD ----------
// table -> { cols: writable columns, list: SQL for list, admin: writes need admin }
const T = {
  classes: { cols: ['name', 'year'], list: `SELECT c.*, (SELECT COUNT(*) FROM students s WHERE s.class_id=c.id) AS student_count FROM classes c ORDER BY c.name` },
  subjects: { cols: ['name'], list: 'SELECT * FROM subjects ORDER BY id' },
  students: {
    cols: ['code', 'name', 'gender', 'dob', 'class_id', 'guardian', 'phone', 'address', 'status'],
    list: `SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON c.id=s.class_id ORDER BY s.code`,
  },
  teachers: {
    cols: ['code', 'name', 'gender', 'phone', 'email', 'subject_id'],
    list: `SELECT t.*, sb.name AS subject_name FROM teachers t LEFT JOIN subjects sb ON sb.id=t.subject_id ORDER BY t.code`,
  },
  schedule: {
    cols: ['class_id', 'subject_id', 'teacher_id', 'day', 'start_time', 'end_time', 'room'],
    list: `SELECT sc.*, c.name AS class_name, sb.name AS subject_name, t.name AS teacher_name
           FROM schedule sc JOIN classes c ON c.id=sc.class_id JOIN subjects sb ON sb.id=sc.subject_id
           LEFT JOIN teachers t ON t.id=sc.teacher_id
           ORDER BY c.name, CASE sc.day WHEN 'ច័ន្ទ' THEN 1 WHEN 'អង្គារ' THEN 2 WHEN 'ពុធ' THEN 3 WHEN 'ព្រហស្បតិ៍' THEN 4 WHEN 'សុក្រ' THEN 5 ELSE 6 END, sc.start_time`,
  },
  announcements: { cols: ['title', 'body', 'audience', 'created_at'], list: 'SELECT * FROM announcements ORDER BY created_at DESC, id DESC' },
  certificates: {
    cols: ['student_id', 'title', 'reason', 'issued_date', 'rank', 'school_year'],
    list: `SELECT ce.*, s.name AS student_name, s.code AS student_code, s.gender AS student_gender, c.name AS class_name
           FROM certificates ce JOIN students s ON s.id=ce.student_id LEFT JOIN classes c ON c.id=s.class_id ORDER BY ce.issued_date DESC, ce.id DESC`,
  },
};

// Admin-only writes on some tables; teachers can write most academic data
const teacherWritable = new Set(['announcements', 'certificates', 'students']);
const guardWrite = (name) => (req, res, next) => {
  const cfg = T[name];
  if (req.user.role === 'admin') return next();
  if (!cfg.admin && teacherWritable.has(name)) return next();
  res.status(403).json({ error: 'អ្នកមិនមានសិទ្ធិធ្វើសកម្មភាពនេះទេ' });
};
const guardRead = (name) => (req, res, next) =>
  T[name].admin && req.user.role !== 'admin' ? res.status(403).json({ error: 'តែអ្នកគ្រប់គ្រងប៉ុណ្ណោះដែលអាចមើលបាន' }) : next();

function pick(cfg, body) {
  const data = {};
  for (const c of cfg.cols) if (body[c] !== undefined) data[c] = body[c] === '' ? null : body[c];
  return data;
}

// ---------- Excel import/export (must come before the generic /api/:table routes) ----------
require('./excel')(app, db, { adminOnly });

// ---------- school settings (used on certificates) ----------
const SETTING_KEYS = ['school_name', 'director_name', 'ministry', 'place', 'director_title', 'logo', 'system_name', 'system_title', 'system_tagline', 'theme'];
const THEMES = ['khmer', 'emerald', 'lotus', 'ocean'];
app.get('/api/settings', wrap((req, res) => {
  const o = {}; db.prepare('SELECT key,value FROM settings').all().forEach((r) => (o[r.key] = r.value));
  res.json(o);
}));
app.put('/api/settings', adminOnly, wrap((req, res) => {
  const up = db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const k of SETTING_KEYS) {
    if (req.body[k] === undefined) continue;
    let v = String(req.body[k] ?? '');
    if (k === 'logo' && v && (!v.startsWith('data:image/') || v.length > 2.5e6)) throw new Error('INVALID: រូបឡូហ្គោមិនត្រឹមត្រូវ ឬធំពេក');
    if (k === 'theme' && !THEMES.includes(v)) v = 'khmer';
    if (['system_name', 'system_title'].includes(k) && !v.trim()) throw new Error('INVALID: ឈ្មោះប្រព័ន្ធមិនអាចទទេបានទេ');
    up.run(k, v);
  }
  res.json({ ok: true });
}));

// ---------- class ranking by average (for certificates) ----------
app.get('/api/rankings', wrap((req, res) => {
  const { class_id, term } = req.query;
  if (!class_id || !term) return res.status(400).json({ error: 'សូមជ្រើសរើសថ្នាក់ និងឆមាស' });
  const rows = db.prepare(`SELECT s.id AS student_id, s.code, s.name, s.gender, SUM(g.score)*100.0/SUM(g.max_score) AS avg
    FROM students s JOIN grades g ON g.student_id=s.id AND g.term=? WHERE s.class_id=? AND s.status='កំពុងសិក្សា'
    GROUP BY s.id ORDER BY avg DESC, s.name`).all(term, class_id);
  let prev = null, rank = 0;
  rows.forEach((r, i) => { if (r.avg !== prev) { rank = i + 1; prev = r.avg; } r.rank = rank; r.avg = Math.round(r.avg * 100) / 100; });
  res.json(rows);
}));

for (const name of Object.keys(T)) {
  const cfg = T[name];
  app.get(`/api/${name}`, guardRead(name), wrap((req, res) => res.json(db.prepare(cfg.list).all())));
  app.post(`/api/${name}`, guardWrite(name), wrap((req, res) => {
    const data = pick(cfg, req.body || {});
    const keys = Object.keys(data);
    if (!keys.length) return res.status(400).json({ error: 'មិនមានទិន្នន័យ' });
    const r = db.prepare(`INSERT INTO ${name}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(data));
    res.json({ id: r.lastInsertRowid });
  }));
  app.put(`/api/${name}/:id`, guardWrite(name), wrap((req, res) => {
    const data = pick(cfg, req.body || {});
    const keys = Object.keys(data);
    if (!keys.length) return res.status(400).json({ error: 'មិនមានទិន្នន័យ' });
    db.prepare(`UPDATE ${name} SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`).run(...Object.values(data), req.params.id);
    res.json({ ok: true });
  }));
  app.delete(`/api/${name}/:id`, guardWrite(name), wrap((req, res) => {
    db.prepare(`DELETE FROM ${name} WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  }));
}

// ---------- users (admin) ----------
app.get('/api/users', adminOnly, wrap((req, res) =>
  res.json(db.prepare('SELECT id,username,role,full_name FROM users ORDER BY id').all())));
app.post('/api/users', adminOnly, wrap((req, res) => {
  const { username, password, role, full_name } = req.body || {};
  if (!username || !password || !full_name) return res.status(400).json({ error: 'សូមបំពេញព័ត៌មានឱ្យគ្រប់' });
  const r = db.prepare('INSERT INTO users(username,password_hash,role,full_name) VALUES (?,?,?,?)')
    .run(username, bcrypt.hashSync(password, 10), role === 'admin' ? 'admin' : 'teacher', full_name);
  res.json({ id: r.lastInsertRowid });
}));
app.put('/api/users/:id', adminOnly, wrap((req, res) => {
  const { username, password, role, full_name } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'រកមិនឃើញគណនី' });
  if (!username || !full_name) return res.status(400).json({ error: 'សូមបំពេញព័ត៌មានឱ្យគ្រប់' });
  const newRole = role === 'admin' ? 'admin' : 'teacher';
  if (u.id === req.user.id && newRole !== 'admin') return res.status(400).json({ error: 'មិនអាចដកសិទ្ធិអ្នកគ្រប់គ្រងរបស់ខ្លួនឯងបានទេ' });
  db.prepare('UPDATE users SET username=?, role=?, full_name=? WHERE id=?').run(username, newRole, full_name, u.id);
  if (password) db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(String(password), 10), u.id);
  res.json({ ok: true });
}));
app.delete('/api/users/:id', adminOnly, wrap((req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'មិនអាចលុបគណនីខ្លួនឯងបានទេ' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- attendance ----------
app.get('/api/attendance', wrap((req, res) => {
  const { date, class_id } = req.query;
  if (!date) return res.status(400).json({ error: 'សូមជ្រើសរើសកាលបរិច្ឆេទ' });
  const rows = db.prepare(`
    SELECT s.id AS student_id, s.code, s.name, a.status, a.note
    FROM students s LEFT JOIN attendance a ON a.student_id=s.id AND a.date=?
    WHERE s.status='កំពុងសិក្សា' ${class_id ? 'AND s.class_id=?' : ''} ORDER BY s.code`)
    .all(...(class_id ? [date, class_id] : [date]));
  res.json(rows);
}));
app.post('/api/attendance/bulk', wrap((req, res) => {
  const { date, records } = req.body || {};
  if (!date || !Array.isArray(records)) return res.status(400).json({ error: 'ទិន្នន័យមិនត្រឹមត្រូវ' });
  const up = db.prepare(`INSERT INTO attendance(student_id,date,status,note) VALUES (?,?,?,?)
    ON CONFLICT(student_id,date) DO UPDATE SET status=excluded.status, note=excluded.note`);
  db.transaction(() => records.forEach((r) => up.run(r.student_id, date, r.status || 'មកដល់', r.note || null)))();
  res.json({ ok: true, saved: records.length });
}));
app.get('/api/attendance/summary', wrap((req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.code, s.name,
      SUM(a.status='មកដល់') AS present, SUM(a.status='អវត្តមាន') AS absent,
      SUM(a.status='យឺត') AS late, SUM(a.status='សុំច្បាប់') AS leave_count, COUNT(a.id) AS total
    FROM students s LEFT JOIN attendance a ON a.student_id=s.id
    ${req.query.class_id ? 'WHERE s.class_id=?' : ''} GROUP BY s.id ORDER BY s.code`)
    .all(...(req.query.class_id ? [req.query.class_id] : []));
  res.json(rows);
}));

// ---------- grades ----------
app.get('/api/grades', wrap((req, res) => {
  const { class_id, subject_id, term } = req.query;
  if (!subject_id || !term) return res.status(400).json({ error: 'សូមជ្រើសរើសមុខវិជ្ជា និងឆមាស' });
  const rows = db.prepare(`
    SELECT s.id AS student_id, s.code, s.name, g.score, COALESCE(g.max_score,100) AS max_score
    FROM students s LEFT JOIN grades g ON g.student_id=s.id AND g.subject_id=? AND g.term=?
    WHERE s.status='កំពុងសិក្សា' ${class_id ? 'AND s.class_id=?' : ''} ORDER BY s.code`)
    .all(...(class_id ? [subject_id, term, class_id] : [subject_id, term]));
  res.json(rows);
}));
app.post('/api/grades/bulk', wrap((req, res) => {
  const { subject_id, term, records } = req.body || {};
  if (!subject_id || !term || !Array.isArray(records)) return res.status(400).json({ error: 'ទិន្នន័យមិនត្រឹមត្រូវ' });
  const up = db.prepare(`INSERT INTO grades(student_id,subject_id,term,score,max_score) VALUES (?,?,?,?,?)
    ON CONFLICT(student_id,subject_id,term) DO UPDATE SET score=excluded.score, max_score=excluded.max_score`);
  const del = db.prepare('DELETE FROM grades WHERE student_id=? AND subject_id=? AND term=?');
  let saved = 0;
  db.transaction(() => records.forEach((r) => {
    if (r.score === '' || r.score === null || r.score === undefined) { del.run(r.student_id, subject_id, term); return; }
    const sc = Number(r.score), mx = Number(r.max_score || 100);
    if (Number.isNaN(sc) || sc < 0 || sc > mx) throw new Error('INVALID: ពិន្ទុមិនត្រឹមត្រូវ (ត្រូវនៅចន្លោះ 0 ដល់ពិន្ទុពេញ)');
    up.run(r.student_id, subject_id, term, sc, mx); saved++;
  }))();
  res.json({ ok: true, saved });
}));
const gradeLetter = (pct) => (pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : pct >= 50 ? 'E' : 'F');
app.get('/api/report-card/:studentId', wrap((req, res) => {
  const term = req.query.term;
  const student = db.prepare(`SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.id=?`).get(req.params.studentId);
  if (!student) return res.status(404).json({ error: 'រកមិនឃើញសិស្ស' });
  const subjects = db.prepare(`SELECT sb.name, g.score, g.max_score FROM grades g JOIN subjects sb ON sb.id=g.subject_id
    WHERE g.student_id=? ${term ? 'AND g.term=?' : ''} ORDER BY sb.id`).all(...(term ? [student.id, term] : [student.id]))
    .map((r) => ({ ...r, grade: gradeLetter((r.score / r.max_score) * 100) }));
  const total = subjects.reduce((a, r) => a + r.score, 0);
  const max = subjects.reduce((a, r) => a + r.max_score, 0);
  const average = max ? (total / max) * 100 : 0;
  // rank within class for the term
  let rank = null, classSize = null;
  if (term && student.class_id) {
    const avgs = db.prepare(`SELECT s.id, SUM(g.score)*1.0/SUM(g.max_score) AS pct FROM students s
      JOIN grades g ON g.student_id=s.id AND g.term=? WHERE s.class_id=? GROUP BY s.id ORDER BY pct DESC`).all(term, student.class_id);
    classSize = avgs.length;
    const idx = avgs.findIndex((a) => a.id === student.id);
    rank = idx >= 0 ? idx + 1 : null;
  }
  res.json({ student, term: term || 'ទាំងអស់', subjects, total, max, average: Math.round(average * 100) / 100, grade: gradeLetter(average), rank, classSize });
}));
app.get('/api/terms', wrap((req, res) => {
  const used = db.prepare('SELECT DISTINCT term FROM grades').all().map((r) => r.term);
  const base = ['ឆមាសទី ១', 'ឆមាសទី ២', ...db.MONTHS];
  res.json([...base, ...used.filter((t) => !base.includes(t)).sort()]);
}));

// ---------- monthly scores (12 months) ----------
// matrix: one row per student, one score per month, for a chosen subject (+ optional class)
app.get('/api/grades/monthly', wrap((req, res) => {
  const { class_id, subject_id } = req.query;
  if (!subject_id) return res.status(400).json({ error: 'សូមជ្រើសរើសមុខវិជ្ជា' });
  const students = db.prepare(`SELECT s.id AS student_id, s.code, s.name FROM students s
    WHERE s.status='កំពុងសិក្សា' ${class_id ? 'AND s.class_id=?' : ''} ORDER BY s.code`).all(...(class_id ? [class_id] : []));
  const q = db.prepare(`SELECT term, score, max_score FROM grades WHERE student_id=? AND subject_id=? AND term IN (${db.MONTHS.map(() => '?').join(',')})`);
  students.forEach((st) => {
    st.months = {};
    q.all(st.student_id, subject_id, ...db.MONTHS).forEach((g) => (st.months[g.term] = { score: g.score, max: g.max_score }));
  });
  res.json({ months: db.MONTHS, students });
}));
app.post('/api/grades/monthly', wrap((req, res) => {
  const { subject_id, records, max_score } = req.body || {};
  if (!subject_id || !Array.isArray(records)) return res.status(400).json({ error: 'ទិន្នន័យមិនត្រឹមត្រូវ' });
  const mx = Number(max_score || 100);
  if (!(mx > 0)) return res.status(400).json({ error: 'ពិន្ទុពេញមិនត្រឹមត្រូវ' });
  const up = db.prepare(`INSERT INTO grades(student_id,subject_id,term,score,max_score) VALUES (?,?,?,?,?)
    ON CONFLICT(student_id,subject_id,term) DO UPDATE SET score=excluded.score, max_score=excluded.max_score`);
  const del = db.prepare('DELETE FROM grades WHERE student_id=? AND subject_id=? AND term=?');
  let saved = 0;
  db.transaction(() => records.forEach((r) => {
    if (!db.MONTHS.includes(r.term)) throw new Error('INVALID: ឈ្មោះខែមិនត្រឹមត្រូវ');
    if (r.score === '' || r.score === null || r.score === undefined) { del.run(r.student_id, subject_id, r.term); return; }
    const sc = Number(r.score);
    if (Number.isNaN(sc) || sc < 0 || sc > mx) throw new Error(`INVALID: ពិន្ទុ «${r.score}» មិនត្រឹមត្រូវ (ត្រូវនៅចន្លោះ 0 ដល់ ${mx})`);
    up.run(r.student_id, subject_id, r.term, sc, mx); saved++;
  }))();
  res.json({ ok: true, saved });
}));
// one student, every subject x 12 months
app.get('/api/report-card/:studentId/monthly', wrap((req, res) => {
  const student = db.prepare(`SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.id=?`).get(req.params.studentId);
  if (!student) return res.status(404).json({ error: 'រកមិនឃើញសិស្ស' });
  const subjects = db.prepare('SELECT * FROM subjects ORDER BY id').all();
  const g = db.prepare(`SELECT subject_id, term, score, max_score FROM grades WHERE student_id=? AND term IN (${db.MONTHS.map(() => '?').join(',')})`).all(student.id, ...db.MONTHS);
  const rows = subjects.map((sb) => {
    const months = db.MONTHS.map((m) => { const x = g.find((r) => r.subject_id === sb.id && r.term === m); return x ? Math.round((x.score / x.max_score) * 1000) / 10 : null; });
    const v = months.filter((x) => x !== null);
    return { name: sb.name, months, avg: v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null };
  });
  const monthAvg = db.MONTHS.map((m, i) => { const v = rows.map((r) => r.months[i]).filter((x) => x !== null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; });
  const all = rows.map((r) => r.avg).filter((x) => x !== null);
  res.json({ student, months: db.MONTHS, rows, monthAvg, yearAvg: all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 10) / 10 : null });
}));

// ---------- dashboard ----------
app.get('/api/dashboard', wrap((req, res) => {
  const c = (sql, ...p) => db.prepare(sql).get(...p).n;
  const now = new Date();
  const today = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const out = {
    attToday: db.prepare(`SELECT COALESCE(SUM(status='មកដល់'),0) AS present, COALESCE(SUM(status='យឺត'),0) AS late,
      COALESCE(SUM(status='សុំច្បាប់'),0) AS leave_n, COALESCE(SUM(status='អវត្តមាន'),0) AS absent FROM attendance WHERE date=?`).get(today),
    subjectAvg: db.prepare(`SELECT sb.name, ROUND(AVG(g.score*100.0/g.max_score),1) AS avg FROM grades g
      JOIN subjects sb ON sb.id=g.subject_id GROUP BY sb.id ORDER BY sb.id`).all(),
    classCounts: db.prepare(`SELECT c.name, COUNT(s.id) AS n FROM classes c
      LEFT JOIN students s ON s.class_id=c.id AND s.status='កំពុងសិក្សា' GROUP BY c.id ORDER BY c.name`).all(),
    students: c(`SELECT COUNT(*) n FROM students WHERE status='កំពុងសិក្សា'`),
    teachers: c('SELECT COUNT(*) n FROM teachers'),
    classes: c('SELECT COUNT(*) n FROM classes'),
    presentToday: c(`SELECT COUNT(*) n FROM attendance WHERE date=? AND status='មកដល់'`, today),
    absentToday: c(`SELECT COUNT(*) n FROM attendance WHERE date=? AND status='អវត្តមាន'`, today),
    announcements: db.prepare('SELECT * FROM announcements ORDER BY created_at DESC, id DESC LIMIT 3').all(),
  };
  // average percentage per month (all subjects, all students) for the yearly chart
  const mAvg = Object.fromEntries(db.prepare(`SELECT term, ROUND(AVG(score*100.0/max_score),1) AS avg FROM grades GROUP BY term`).all().map((r) => [r.term, r.avg]));
  out.monthAvg = db.MONTHS.map((m) => ({ month: m, avg: mAvg[m] ?? null }));
  res.json(out);
}));

app.listen(PORT, () => console.log(`School system running at http://localhost:${PORT}`));
