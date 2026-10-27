const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'school.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
// minimal replacement for better-sqlite3's db.transaction(fn)
db.transaction = (fn) => () => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'teacher',
  full_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  year TEXT NOT NULL DEFAULT '2026-2027'
);
CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT 'ប្រុស',
  dob TEXT,
  class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  guardian TEXT,
  phone TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'កំពុងសិក្សា'
);
CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT 'ប្រុស',
  phone TEXT,
  email TEXT,
  subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'មកដល់',
  note TEXT,
  UNIQUE(student_id, date)
);
CREATE TABLE IF NOT EXISTS grades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  score REAL NOT NULL,
  max_score REAL NOT NULL DEFAULT 100,
  UNIQUE(student_id, subject_id, term)
);
CREATE TABLE IF NOT EXISTS schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  day TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  room TEXT
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'ទាំងអស់',
  created_at TEXT NOT NULL DEFAULT (date('now'))
);
CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  reason TEXT,
  issued_date TEXT NOT NULL DEFAULT (date('now'))
);
`);

// ---- migrations (safe to run on an existing school.db; data is kept) ----
db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
for (const [col, ddl] of [['rank', 'rank TEXT'], ['school_year', 'school_year TEXT']]) {
  if (!hasCol('certificates', col)) db.exec(`ALTER TABLE certificates ADD COLUMN ${ddl}`);
}
db.MONTHS = ['ខែមករា', 'ខែកុម្ភៈ', 'ខែមីនា', 'ខែមេសា', 'ខែឧសភា', 'ខែមិថុនា', 'ខែកក្កដា', 'ខែសីហា', 'ខែកញ្ញា', 'ខែតុលា', 'ខែវិច្ឆិកា', 'ខែធ្នូ'];
const defaults = {
  school_name: '', director_name: '', ministry: 'ក្រសួងអប់រំ យុវជន និងកីឡា',
  place: '', director_title: 'នាយកសាលា', logo: '',
  system_name: 'ប្រព័ន្ធសាលា',
  system_title: 'ប្រព័ន្ធគ្រប់គ្រងសាលា',
  system_tagline: 'គ្រប់គ្រងសិស្ស គ្រូ វត្តមាន ពិន្ទុប្រចាំខែ កាលវិភាគ និងប័ណ្ណសរសើរ ក្នុងកន្លែងតែមួយ។',
  theme: 'khmer',
};
for (const [k, v] of Object.entries(defaults)) db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run(k, v);

function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return;
  const hash = (p) => bcrypt.hashSync(p, 10);
  db.prepare('INSERT INTO users(username,password_hash,role,full_name) VALUES (?,?,?,?)')
    .run('admin', hash('admin123'), 'admin', 'អ្នកគ្រប់គ្រងប្រព័ន្ធ');
  db.prepare('INSERT INTO users(username,password_hash,role,full_name) VALUES (?,?,?,?)')
    .run('teacher', hash('teacher123'), 'teacher', 'លោកគ្រូ សុខា');

  const subj = ['ភាសាខ្មែរ', 'គណិតវិទ្យា', 'វិទ្យាសាស្ត្រ', 'ភាសាអង់គ្លេស', 'ប្រវត្តិវិទ្យា'];
  const insS = db.prepare('INSERT INTO subjects(name) VALUES (?)');
  subj.forEach((s) => insS.run(s));

  const insC = db.prepare('INSERT INTO classes(name,year) VALUES (?,?)');
  ['ថ្នាក់ទី ៧ក', 'ថ្នាក់ទី ៧ខ', 'ថ្នាក់ទី ៨ក'].forEach((c) => insC.run(c, '2026-2027'));

  const insT = db.prepare('INSERT INTO teachers(code,name,gender,phone,email,subject_id) VALUES (?,?,?,?,?,?)');
  insT.run('T001', 'សុខា ចាន់', 'ស្រី', '012345678', 'sokha@school.edu.kh', 1);
  insT.run('T002', 'វិចិត្រ ម៉ម', 'ប្រុស', '098765432', 'vichet@school.edu.kh', 2);
  insT.run('T003', 'ស្រីនាង លី', 'ស្រី', '017111222', 'sreynang@school.edu.kh', 4);

  const insSt = db.prepare('INSERT INTO students(code,name,gender,dob,class_id,guardian,phone,address) VALUES (?,?,?,?,?,?,?,?)');
  const names = [
    ['ដារា សុខ', 'ប្រុស'], ['ចន្ទា ហេង', 'ស្រី'], ['វីរៈ ឈឿន', 'ប្រុស'],
    ['សុភា លាង', 'ស្រី'], ['បូរី គឹម', 'ប្រុស'], ['ម៉ាលីន ពៅ', 'ស្រី'],
  ];
  names.forEach(([n, g], i) => {
    insSt.run('S' + String(i + 1).padStart(3, '0'), n, g, '2013-0' + ((i % 9) + 1) + '-15',
      (i % 3) + 1, 'អាណាព្យាបាល ' + n.split(' ')[0], '01' + (2000000 + i * 1111),
      'ខេត្តកំពត');
  });

  const insG = db.prepare('INSERT INTO grades(student_id,subject_id,term,score,max_score) VALUES (?,?,?,?,100)');
  for (let st = 1; st <= 6; st++) for (let sb = 1; sb <= 5; sb++) insG.run(st, sb, 'ឆមាសទី ១', 55 + ((st * 7 + sb * 11) % 45));
  // sample monthly scores (all 12 months) so the monthly pages are not empty
  for (let st = 1; st <= 6; st++) for (let sb = 1; sb <= 5; sb++) db.MONTHS.forEach((m, mi) => insG.run(st, sb, m, Math.min(100, 46 + ((st * 7 + sb * 11 + mi * 17) % 40) + mi * 2)));

  const insSc = db.prepare('INSERT INTO schedule(class_id,subject_id,teacher_id,day,start_time,end_time,room) VALUES (?,?,?,?,?,?,?)');
  insSc.run(1, 1, 1, 'ច័ន្ទ', '07:00', '08:00', 'A101');
  insSc.run(1, 2, 2, 'ច័ន្ទ', '08:00', '09:00', 'A101');
  insSc.run(1, 4, 3, 'អង្គារ', '07:00', '08:00', 'A101');
  insSc.run(2, 2, 2, 'ច័ន្ទ', '07:00', '08:00', 'A102');

  db.prepare('INSERT INTO announcements(title,body,audience) VALUES (?,?,?)')
    .run('ស្វាគមន៍ឆ្នាំសិក្សាថ្មី', 'សូមស្វាគមន៍សិស្សានុសិស្ស និងលោកគ្រូអ្នកគ្រូទាំងអស់ មកកាន់ឆ្នាំសិក្សា ២០២៦-២០២៧។', 'ទាំងអស់');
  db.prepare('INSERT INTO certificates(student_id,title,reason,issued_date) VALUES (?,?,?,?)')
    .run(1, 'ប័ណ្ណសរសើរសិស្សពូកែ', 'ទទួលបានលទ្ធផលសិក្សាល្អប្រសើរក្នុងឆមាសទី ១', '2026-10-20');
}
seed();

module.exports = db;
