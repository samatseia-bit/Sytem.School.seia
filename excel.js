// Excel import / export (exceljs). Every export can be edited in Excel and imported back at any time:
// rows are matched by a key (student code, teacher code, certificate number) and updated, new rows are added.
const express = require('express');
const ExcelJS = require('exceljs');

module.exports = function mountExcel(app, db, { adminOnly }) {
  const ATT_MARK = { 'មកដល់': 'ម', 'យឺត': 'យ', 'សុំច្បាប់': 'ច', 'អវត្តមាន': 'អ' };
  const MARK_ATT = Object.fromEntries(Object.entries(ATT_MARK).map(([k, v]) => [v, k]));
  const GOLD = 'FFC9972B', NAVY = 'FF0B2A43', CREAM = 'FFFBF6EA';

  // ---------- helpers ----------
  const fail = (m) => { throw new Error('INVALID: ' + m); };
  const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
  function cellValue(c) {
    let v = c && c.value;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if (v.richText) v = v.richText.map((t) => t.text).join('');
      else if (v.result !== undefined) v = v.result;
      else if (v.text !== undefined) v = v.text;
    }
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return v === null || v === undefined ? '' : v;
  }
  const toDate = (v) => {
    v = str(v); if (!v) return null;
    let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);          // dd/mm/yyyy
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return v;
  };
  const toGender = (v) => {
    v = str(v).toLowerCase();
    if (!v) return 'ប្រុស';
    return ['ស្រី', 'f', 'female', 'ស'].includes(v) ? 'ស្រី' : 'ប្រុស';
  };
  const KH_DIGITS = '០១២៣៤៥៦៧៨៩';
  const latin = (s) => String(s).replace(/[០-៩]/g, (d) => KH_DIGITS.indexOf(d));
  const num = (v) => { const n = Number(latin(str(v))); return Number.isFinite(n) ? n : NaN; };

  function getClassId(name) {
    name = str(name); if (!name) return null;
    const r = db.prepare('SELECT id FROM classes WHERE name=?').get(name);
    if (r) return r.id;
    const y = new Date().getFullYear(), m = new Date().getMonth();
    const year = m >= 8 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
    return Number(db.prepare('INSERT INTO classes(name,year) VALUES (?,?)').run(name, year).lastInsertRowid);
  }
  function getSubjectId(name, create) {
    name = str(name); if (!name) return null;
    const r = db.prepare('SELECT id FROM subjects WHERE name=?').get(name);
    if (r) return r.id;
    return create ? Number(db.prepare('INSERT INTO subjects(name) VALUES (?)').run(name).lastInsertRowid) : null;
  }

  // ---------- table definitions ----------
  const DEFS = {
    students: {
      sheet: 'បញ្ជីសិស្ស', file: 'បញ្ជីសិស្ស', key: 'code', writeRole: 'any',
      cols: [
        { k: 'code', h: 'លេខកូដ', w: 12, req: true }, { k: 'name', h: 'ឈ្មោះ', w: 28, req: true },
        { k: 'gender', h: 'ភេទ', w: 9, list: ['ប្រុស', 'ស្រី'] }, { k: 'dob', h: 'ថ្ងៃកំណើត', w: 14 },
        { k: 'class_name', h: 'ថ្នាក់', w: 16 }, { k: 'guardian', h: 'អាណាព្យាបាល', w: 22 },
        { k: 'phone', h: 'ទូរស័ព្ទ', w: 16 }, { k: 'address', h: 'អាសយដ្ឋាន', w: 28 },
        { k: 'status', h: 'ស្ថានភាព', w: 16, list: ['កំពុងសិក្សា', 'ឈប់រៀន', 'បញ្ចប់ការសិក្សា'] },
      ],
      rows: () => db.prepare(`SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON c.id=s.class_id ORDER BY s.code`).all(),
      sample: [{ code: 'S101', name: 'សុខ ចាន់ថា', gender: 'ប្រុស', dob: '2013-05-20', class_name: 'ថ្នាក់ទី ៧ក', guardian: 'សុខ ចាន់', phone: '012345678', address: 'ខេត្តកំពត', status: 'កំពុងសិក្សា' },
        { code: 'S102', name: 'ហេង ស្រីនាង', gender: 'ស្រី', dob: '2013-08-02', class_name: 'ថ្នាក់ទី ៧ក', guardian: 'ហេង សុខា', phone: '098111222', address: 'ខេត្តកំពត', status: 'កំពុងសិក្សា' }],
      save(rec) {
        if (!rec.code) fail('មិនមានលេខកូដ');
        if (!rec.name) fail('មិនមានឈ្មោះ');
        const data = {
          code: rec.code, name: rec.name, gender: toGender(rec.gender), dob: toDate(rec.dob),
          class_id: getClassId(rec.class_name), guardian: rec.guardian || null, phone: rec.phone || null,
          address: rec.address || null, status: str(rec.status) || 'កំពុងសិក្សា',
        };
        return upsertBy('students', 'code', data, rec._has);
      },
    },
    teachers: {
      sheet: 'បញ្ជីគ្រូ', file: 'បញ្ជីគ្រូបង្រៀន', key: 'code', writeRole: 'admin',
      cols: [
        { k: 'code', h: 'លេខកូដ', w: 12, req: true }, { k: 'name', h: 'ឈ្មោះ', w: 28, req: true },
        { k: 'gender', h: 'ភេទ', w: 9, list: ['ប្រុស', 'ស្រី'] }, { k: 'subject_name', h: 'មុខវិជ្ជា', w: 18 },
        { k: 'phone', h: 'ទូរស័ព្ទ', w: 16 }, { k: 'email', h: 'អ៊ីមែល', w: 26 },
      ],
      rows: () => db.prepare(`SELECT t.*, sb.name AS subject_name FROM teachers t LEFT JOIN subjects sb ON sb.id=t.subject_id ORDER BY t.code`).all(),
      sample: [{ code: 'T101', name: 'វណ្ណា សុខ', gender: 'ស្រី', subject_name: 'គណិតវិទ្យា', phone: '012000111', email: 'vanna@school.edu.kh' }],
      save(rec) {
        if (!rec.code) fail('មិនមានលេខកូដ');
        if (!rec.name) fail('មិនមានឈ្មោះ');
        const data = { code: rec.code, name: rec.name, gender: toGender(rec.gender), subject_id: getSubjectId(rec.subject_name, true), phone: rec.phone || null, email: rec.email || null };
        return upsertBy('teachers', 'code', data, rec._has);
      },
    },
    certificates: {
      sheet: 'ប័ណ្ណសរសើរ', file: 'បញ្ជីប័ណ្ណសរសើរ', key: 'id', writeRole: 'any',
      cols: [
        { k: 'id', h: 'លេខប័ណ្ណ', w: 11 }, { k: 'student_code', h: 'លេខកូដសិស្ស', w: 14, req: true },
        { k: 'student_name', h: 'ឈ្មោះសិស្ស (មើលតែប៉ុណ្ណោះ)', w: 28 }, { k: 'class_name', h: 'ថ្នាក់ (មើលតែប៉ុណ្ណោះ)', w: 18 },
        { k: 'title', h: 'ចំណងជើងប័ណ្ណ', w: 22 }, { k: 'rank', h: 'ចំណាត់ថ្នាក់', w: 14 },
        { k: 'school_year', h: 'ឆ្នាំសិក្សា', w: 14 }, { k: 'issued_date', h: 'កាលបរិច្ឆេទ', w: 14 }, { k: 'reason', h: 'មូលហេតុ', w: 36 },
      ],
      rows: () => db.prepare(`SELECT ce.*, s.code AS student_code, s.name AS student_name, c.name AS class_name FROM certificates ce
        JOIN students s ON s.id=ce.student_id LEFT JOIN classes c ON c.id=s.class_id ORDER BY ce.id`).all(),
      sample: [{ id: '', student_code: 'S001', title: 'ប័ណ្ណសរសើរ', rank: '១', school_year: '2026-2027', issued_date: '2026-10-27', reason: '' }],
      save(rec) {
        const st = db.prepare('SELECT id FROM students WHERE code=?').get(rec.student_code || '');
        if (!st) fail(`រកមិនឃើញសិស្សកូដ «${rec.student_code || ''}»`);
        const data = { student_id: st.id, title: rec.title || 'ប័ណ្ណសរសើរ', rank: rec.rank || null, school_year: rec.school_year || null, issued_date: toDate(rec.issued_date) || new Date().toISOString().slice(0, 10), reason: rec.reason || null };
        const id = Number(rec.id);
        if (id && db.prepare('SELECT 1 FROM certificates WHERE id=?').get(id)) {
          const ks = Object.keys(data);
          db.prepare(`UPDATE certificates SET ${ks.map((k) => k + '=?').join(',')} WHERE id=?`).run(...ks.map((k) => data[k]), id);
          return 'updated';
        }
        const ks = Object.keys(data);
        db.prepare(`INSERT INTO certificates(${ks.join(',')}) VALUES (${ks.map(() => '?').join(',')})`).run(...ks.map((k) => data[k]));
        return 'added';
      },
    },
  };

  function upsertBy(table, keyCol, data, has) {
    const ex = db.prepare(`SELECT id FROM ${table} WHERE ${keyCol}=?`).get(data[keyCol]);
    if (ex) {
      // only touch columns that exist in the uploaded sheet, so a partial sheet never wipes other fields
      const ks = Object.keys(data).filter((k) => k === keyCol || !has || has.has(k) || (k === 'class_id' && has.has('class_name')) || (k === 'subject_id' && has.has('subject_name')));
      db.prepare(`UPDATE ${table} SET ${ks.map((k) => k + '=?').join(',')} WHERE id=?`).run(...ks.map((k) => data[k]), ex.id);
      return 'updated';
    }
    const ks = Object.keys(data);
    db.prepare(`INSERT INTO ${table}(${ks.join(',')}) VALUES (${ks.map(() => '?').join(',')})`).run(...ks.map((k) => data[k]));
    return 'added';
  }

  // ---------- workbook building ----------
  function styleHeader(ws, ncols) {
    const r = ws.getRow(1); r.height = 26;
    for (let i = 1; i <= ncols; i++) {
      const c = r.getCell(i);
      c.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Khmer OS Battambang', size: 11 };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      c.border = { bottom: { style: 'medium', color: { argb: GOLD } } };
    }
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  function guide(wb, lines) {
    const g = wb.addWorksheet('ការណែនាំ');
    g.getColumn(1).width = 110;
    lines.forEach((t, i) => {
      const c = g.getCell(i + 1, 1); c.value = t; c.alignment = { wrapText: true, vertical: 'top' };
      c.font = { name: 'Khmer OS Battambang', size: i === 0 ? 14 : 11, bold: i === 0, color: { argb: i === 0 ? NAVY : 'FF222222' } };
    });
  }
  function tableWorkbook(def, rows) {
    const wb = new ExcelJS.Workbook(); wb.creator = 'ប្រព័ន្ធគ្រប់គ្រងសាលា';
    const ws = wb.addWorksheet(def.sheet);
    ws.columns = def.cols.map((c) => ({ header: c.h, key: c.k, width: c.w || 16 }));
    styleHeader(ws, def.cols.length);
    rows.forEach((r, i) => {
      const row = ws.addRow(def.cols.reduce((o, c) => ((o[c.k] = r[c.k] ?? ''), o), {}));
      row.font = { name: 'Khmer OS Battambang', size: 11 };
      if (i % 2) row.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } }));
    });
    const last = Math.max(rows.length + 1, 300);
    def.cols.forEach((c, i) => {
      if (!c.list) return;
      for (let r = 2; r <= last; r++) ws.getCell(r, i + 1).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${c.list.join(',')}"`] };
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: def.cols.length } };
    if (!def.exportOnly) {
      guide(wb, [
        'របៀបប្រើ',
        '1) កែប្រែ ឬបន្ថែមជួរថ្មីក្នុងសន្លឹក «' + def.sheet + '» ដោយមិនត្រូវប្តូរឈ្មោះក្បាលជួរ (ជួរទី ១) ទេ។',
        def.key === 'id'
          ? '2) ជួរ «លេខប័ណ្ណ» ដែលមានរួច = កែប័ណ្ណនោះ។ ទុកទទេ = បង្កើតប័ណ្ណថ្មី។ ជួរ «ឈ្មោះសិស្ស» និង «ថ្នាក់» សម្រាប់មើលតែប៉ុណ្ណោះ។'
          : '2) ជួរ «លេខកូដ» ជាគន្លឹះ៖ បើមានក្នុងប្រព័ន្ធរួចហើយ ប្រព័ន្ធនឹងកែទិន្នន័យ បើមិនទាន់មាន នឹងបន្ថែមថ្មី។',
        '3) បន្ទាប់មកចូលប្រព័ន្ធ ចុច «នាំចូល Excel» ហើយជ្រើសឯកសារនេះ។ អាចធ្វើម្តងទៀតបានគ្រប់ពេល។',
        '4) ថ្ងៃខែប្រើទម្រង់ ឆ្នាំ-ខែ-ថ្ងៃ (ឧ. 2013-05-20) ឬ ថ្ងៃ/ខែ/ឆ្នាំ។',
        '5) ជួរ «ថ្នាក់» ឬ «មុខវិជ្ជា» ដែលមិនទាន់មាន នឹងត្រូវបង្កើតដោយស្វ័យប្រវត្តិ។',
      ]);
    }
    return wb;
  }
  async function send(res, wb, name) {
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}.xlsx`);
    res.send(Buffer.from(buf));
  }
  const handle = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
    const m = String(e.message || e);
    if (m.startsWith('INVALID:')) return res.status(400).json({ error: m.slice(8).trim() });
    console.error(e); res.status(500).json({ error: m });
  });
  const body = express.raw({ type: '*/*', limit: '12mb' });
  const can = (def, req) => (def.adminOnly || def.writeRole === 'admin') ? req.user.role === 'admin' : true;

  // ---------- generic export / import ----------
  app.get('/api/export/:table', handle(async (req, res) => {
    const def = DEFS[req.params.table];
    if (!def) return res.status(404).json({ error: 'រកមិនឃើញ' });
    if (def.adminOnly && req.user.role !== 'admin') return res.status(403).json({ error: 'តែអ្នកគ្រប់គ្រងប៉ុណ្ណោះ' });
    const tpl = req.query.template === '1';
    const wb = tableWorkbook(def, tpl ? def.sample || [] : def.rows());
    await send(res, wb, tpl ? `គំរូ-${def.file}` : `${def.file}-${new Date().toISOString().slice(0, 10)}`);
  }));

  async function readSheet(buf) {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf); } catch { fail('ឯកសារមិនមែនជា Excel (.xlsx) ត្រឹមត្រូវទេ'); }
    const ws = wb.worksheets[0];
    if (!ws) fail('ឯកសារគ្មានសន្លឹកទិន្នន័យ');
    return ws;
  }

  app.post('/api/import/grades', body, handle(async (req, res) => {
    const term = str(req.query.term);
    if (!term) fail('សូមជ្រើសរើសឆមាសជាមុន');
    const ws = await readSheet(req.body);
    const head = {}; ws.getRow(1).eachCell((c, i) => (head[i] = str(cellValue(c))));
    const codeCol = Object.keys(head).find((i) => ['លេខកូដ', 'code'].includes(head[i].toLowerCase()));
    if (!codeCol) fail('រកមិនឃើញជួរ «លេខកូដ» ក្នុងជួរទី ១');
    const subjCols = [], ignored = [];
    Object.entries(head).forEach(([i, h]) => {
      if (i === codeCol || !h || ['ឈ្មោះ', 'ថ្នាក់', 'name', 'class', 'សរុប', 'មធ្យមភាគ'].includes(h.toLowerCase())) return;
      const id = getSubjectId(h, false);
      if (id) subjCols.push({ i: Number(i), id, h }); else ignored.push(h);
    });
    if (!subjCols.length) fail('មិនមានក្បាលជួរមុខវិជ្ជាណាដែលត្រូវនឹងមុខវិជ្ជាក្នុងប្រព័ន្ធទេ');
    const up = db.prepare(`INSERT INTO grades(student_id,subject_id,term,score,max_score) VALUES (?,?,?,?,100)
      ON CONFLICT(student_id,subject_id,term) DO UPDATE SET score=excluded.score`);
    const out = { added: 0, updated: 0, skipped: 0, errors: [], ignored };
    db.transaction(() => {
      ws.eachRow((row, n) => {
        if (n === 1) return;
        const code = str(cellValue(row.getCell(Number(codeCol))));
        if (!code) return;
        const st = db.prepare('SELECT id FROM students WHERE code=?').get(code);
        if (!st) { out.errors.push({ row: n, msg: `រកមិនឃើញសិស្សកូដ «${code}»` }); return; }
        let any = false;
        for (const sc of subjCols) {
          const raw = cellValue(row.getCell(sc.i));
          if (raw === '' ) continue;
          const v = num(raw), mx = db.prepare('SELECT max_score FROM grades WHERE student_id=? AND subject_id=? AND term=?').get(st.id, sc.id, term)?.max_score ?? 100;
          if (Number.isNaN(v) || v < 0 || v > mx) { out.errors.push({ row: n, msg: `ពិន្ទុ «${raw}» ក្នុងជួរ ${sc.h} មិនត្រឹមត្រូវ (0–${mx})` }); continue; }
          up.run(st.id, sc.id, term, v); any = true; out.updated++;
        }
        if (!any) out.skipped++;
      });
    })();
    res.json(out);
  }));

  // ---------- monthly scores (12 months) : export / template / import ----------
  app.get('/api/export/grades/monthly', handle(async (req, res) => {
    const { class_id, subject_id, template } = req.query;
    const subject = db.prepare('SELECT * FROM subjects WHERE id=?').get(subject_id || 0);
    if (!subject) fail('សូមជ្រើសរើសមុខវិជ្ជា');
    const M = db.MONTHS;
    const students = db.prepare(`SELECT s.id, s.code, s.name, c.name AS class_name FROM students s LEFT JOIN classes c ON c.id=s.class_id
      WHERE s.status='កំពុងសិក្សា' ${class_id ? 'AND s.class_id=?' : ''} ORDER BY s.code`).all(...(class_id ? [class_id] : []));
    const wb = new ExcelJS.Workbook(); wb.creator = 'ប្រព័ន្ធគ្រប់គ្រងសាលា';
    const ws = wb.addWorksheet('ពិន្ទុប្រចាំខែ');
    ws.columns = [{ header: 'លេខកូដ', key: 'code', width: 12 }, { header: 'ឈ្មោះ', key: 'name', width: 28 }, { header: 'ថ្នាក់', key: 'class_name', width: 16 },
      ...M.map((m, i) => ({ header: m, key: 'm' + i, width: 12 })), { header: 'មធ្យមភាគ', key: 'avg', width: 12 }];
    styleHeader(ws, 3 + M.length + 1);
    const get = db.prepare('SELECT score FROM grades WHERE student_id=? AND subject_id=? AND term=?');
    students.forEach((st, i) => {
      const r = { code: st.code, name: st.name, class_name: st.class_name };
      M.forEach((m, mi) => { r['m' + mi] = template === '1' ? '' : (get.get(st.id, subject.id, m)?.score ?? ''); });
      const row = ws.addRow(r); row.font = { name: 'Khmer OS Battambang', size: 11 };
      const rn = i + 2, a = ws.getCell(rn, 4).address, b = ws.getCell(rn, 3 + M.length).address;
      ws.getCell(rn, 4 + M.length).value = { formula: `IFERROR(AVERAGE(${a}:${b}),"")` };
      ws.getCell(rn, 4 + M.length).numFmt = '0.00';
      if (i % 2) row.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } }));
    });
    guide(wb, ['របៀបប្រើសន្លឹកពិន្ទុប្រចាំខែ', `មុខវិជ្ជា៖ ${subject.name}`,
      '1) បញ្ចូល ឬកែពិន្ទុក្នុងក្រឡាខែនីមួយៗ (១២ ខែ)។ ក្រឡាទទេ = មិនកែ។ «មធ្យមភាគ» គណនាដោយស្វ័យប្រវត្តិ។',
      '2) កុំប្តូរឈ្មោះក្បាលជួរខែ និងជួរ «លេខកូដ»។',
      '3) ក្នុងទំព័រ «ពិន្ទុប្រចាំខែ» ជ្រើសមុខវិជ្ជាដូចគ្នា រួចចុច «នាំចូល Excel»។']);
    await send(res, wb, `${template === '1' ? 'គំរូ-' : ''}ពិន្ទុប្រចាំខែ-${subject.name}`);
  }));

  app.post('/api/import/grades/monthly', body, handle(async (req, res) => {
    const subject = db.prepare('SELECT * FROM subjects WHERE id=?').get(req.query.subject_id || 0);
    if (!subject) fail('សូមជ្រើសរើសមុខវិជ្ជាជាមុន');
    const ws = await readSheet(req.body);
    const head = {}; ws.getRow(1).eachCell((c, i) => (head[i] = str(cellValue(c))));
    const codeCol = Object.keys(head).find((i) => ['លេខកូដ', 'code'].includes(head[i].toLowerCase()));
    if (!codeCol) fail('រកមិនឃើញជួរ «លេខកូដ» ក្នុងជួរទី ១');
    const monthCols = Object.entries(head).filter(([, h]) => db.MONTHS.includes(h)).map(([i, h]) => ({ i: Number(i), m: h }));
    if (!monthCols.length) fail('មិនមានក្បាលជួរខែ (ខែមករា … ខែធ្នូ) ក្នុងឯកសារទេ');
    const up = db.prepare(`INSERT INTO grades(student_id,subject_id,term,score,max_score) VALUES (?,?,?,?,100)
      ON CONFLICT(student_id,subject_id,term) DO UPDATE SET score=excluded.score`);
    const out = { added: 0, updated: 0, skipped: 0, errors: [] };
    db.transaction(() => {
      ws.eachRow((row, n) => {
        if (n === 1) return;
        const code = str(cellValue(row.getCell(Number(codeCol))));
        if (!code) return;
        const st = db.prepare('SELECT id FROM students WHERE code=?').get(code);
        if (!st) { out.errors.push({ row: n, msg: `រកមិនឃើញសិស្សកូដ «${code}»` }); return; }
        let any = false;
        for (const mc of monthCols) {
          const raw = cellValue(row.getCell(mc.i));
          if (raw === '') continue;
          const v = num(raw), mx = db.prepare('SELECT max_score FROM grades WHERE student_id=? AND subject_id=? AND term=?').get(st.id, subject.id, mc.m)?.max_score ?? 100;
          if (Number.isNaN(v) || v < 0 || v > mx) { out.errors.push({ row: n, msg: `ពិន្ទុ «${raw}» ក្នុង ${mc.m} មិនត្រឹមត្រូវ (0–${mx})` }); continue; }
          up.run(st.id, subject.id, mc.m, v); any = true; out.updated++;
        }
        if (!any) out.skipped++;
      });
    })();
    res.json(out);
  }));

  app.post('/api/import/:table', body, handle(async (req, res) => {
    const def = DEFS[req.params.table];
    if (!def || def.exportOnly) return res.status(404).json({ error: 'មិនគាំទ្រការនាំចូលសម្រាប់ទិន្នន័យនេះ' });
    if (!can(def, req)) return res.status(403).json({ error: 'តែអ្នកគ្រប់គ្រងប៉ុណ្ណោះដែលអាចនាំចូលបាន' });
    const ws = await readSheet(req.body);
    const byHeader = {};
    def.cols.forEach((c) => { byHeader[c.h.toLowerCase()] = c; byHeader[c.k.toLowerCase()] = c; });
    const map = {}; // col index -> def col
    ws.getRow(1).eachCell((c, i) => { const d = byHeader[str(cellValue(c)).toLowerCase()]; if (d) map[i] = d; });
    const reqCol = def.cols.find((c) => c.req);
    if (reqCol && !Object.values(map).some((d) => d.k === reqCol.k)) fail(`រកមិនឃើញជួរ «${reqCol.h}» ក្នុងជួរទី ១ (កុំប្តូរឈ្មោះក្បាលជួរ)`);
    const has = new Set(Object.values(map).map((d) => d.k));
    const out = { added: 0, updated: 0, skipped: 0, errors: [] };
    db.transaction(() => {
      ws.eachRow((row, n) => {
        if (n === 1) return;
        const rec = { _has: has }; let empty = true;
        for (const [i, d] of Object.entries(map)) {
          if (d.k === 'student_name' || (d.k === 'class_name' && req.params.table === 'certificates')) continue;
          const v = cellValue(row.getCell(Number(i))); if (str(v)) empty = false;
          rec[d.k] = typeof v === 'string' ? v.trim() : v;
        }
        if (empty) return;
        for (const k of Object.keys(rec)) if (k !== '_has' && typeof rec[k] === 'number' && k !== 'id') rec[k] = String(rec[k]);
        try { out[def.save(rec)]++; }
        catch (e) { const m = String(e.message || e); out.errors.push({ row: n, msg: m.startsWith('INVALID:') ? m.slice(8).trim() : m.includes('UNIQUE') ? 'លេខកូដស្ទួន' : m }); }
      });
    })();
    res.json(out);
  }));

  // ---------- score sheet (matrix) ----------
  app.get('/api/export/grades/sheet', handle(async (req, res) => {
    const { term, class_id, template } = req.query;
    const subjects = db.prepare('SELECT * FROM subjects ORDER BY id').all();
    const students = db.prepare(`SELECT s.id, s.code, s.name, c.name AS class_name FROM students s LEFT JOIN classes c ON c.id=s.class_id
      WHERE s.status='កំពុងសិក្សា' ${class_id ? 'AND s.class_id=?' : ''} ORDER BY s.code`).all(...(class_id ? [class_id] : []));
    const wb = new ExcelJS.Workbook(); wb.creator = 'ប្រព័ន្ធគ្រប់គ្រងសាលា';
    const ws = wb.addWorksheet('ពិន្ទុ');
    ws.columns = [{ header: 'លេខកូដ', key: 'code', width: 12 }, { header: 'ឈ្មោះ', key: 'name', width: 28 }, { header: 'ថ្នាក់', key: 'class_name', width: 16 },
      ...subjects.map((s) => ({ header: s.name, key: 's' + s.id, width: 16 })),
      { header: 'សរុប', key: 'total', width: 10 }, { header: 'មធ្យមភាគ', key: 'avg', width: 12 }];
    styleHeader(ws, 3 + subjects.length + 2);
    const get = db.prepare('SELECT score FROM grades WHERE student_id=? AND subject_id=? AND term=?');
    students.forEach((st, i) => {
      const r = { code: st.code, name: st.name, class_name: st.class_name };
      subjects.forEach((s) => { r['s' + s.id] = template === '1' ? '' : (get.get(st.id, s.id, term || '')?.score ?? ''); });
      const row = ws.addRow(r); row.font = { name: 'Khmer OS Battambang', size: 11 };
      const rn = i + 2, a = ws.getCell(rn, 4).address, b = ws.getCell(rn, 3 + subjects.length).address;
      ws.getCell(rn, 4 + subjects.length).value = { formula: `SUM(${a}:${b})` };
      ws.getCell(rn, 5 + subjects.length).value = { formula: `IFERROR(AVERAGE(${a}:${b}),"")` };
      ws.getCell(rn, 5 + subjects.length).numFmt = '0.00';
      if (i % 2) row.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } }));
    });
    guide(wb, ['របៀបប្រើសន្លឹកពិន្ទុ', `ឆមាស៖ ${term || '(ជ្រើសឆមាសពេលនាំចូល)'}`,
      '1) បញ្ចូល ឬកែពិន្ទុក្នុងក្រឡាមុខវិជ្ជា។ ក្រឡាទទេ = មិនកែ។ ជួរ «សរុប» និង «មធ្យមភាគ» គណនាដោយស្វ័យប្រវត្តិ។',
      '2) កុំប្តូរឈ្មោះក្បាលជួរមុខវិជ្ជា និងជួរ «លេខកូដ»។',
      '3) ក្នុងទំព័រ «ពិន្ទុ» ជ្រើសឆមាសដូចគ្នា រួចចុច «នាំចូល Excel»។']);
    await send(res, wb, `${template === '1' ? 'គំរូ-' : ''}សន្លឹកពិន្ទុ-${term || ''}`);
  }));

  // ---------- monthly attendance sheet (export only) ----------
  app.get('/api/export/attendance/month', handle(async (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
    const [y, m] = month.split('-').map(Number), days = new Date(y, m, 0).getDate();
    const cid = req.query.class_id;
    const students = db.prepare(`SELECT s.id, s.code, s.name FROM students s WHERE s.status='កំពុងសិក្សា' ${cid ? 'AND s.class_id=?' : ''} ORDER BY s.code`).all(...(cid ? [cid] : []));
    const att = db.prepare(`SELECT student_id, CAST(substr(date,9,2) AS INTEGER) AS d, status FROM attendance WHERE substr(date,1,7)=?`).all(month);
    const map = {}; att.forEach((a) => ((map[a.student_id] ||= {})[a.d] = a.status));
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('វត្តមាន ' + month);
    ws.columns = [{ header: 'លេខកូដ', key: 'code', width: 11 }, { header: 'ឈ្មោះ', key: 'name', width: 26 },
      ...Array.from({ length: days }, (_, i) => ({ header: String(i + 1), key: 'd' + (i + 1), width: 4.2 })),
      { header: 'ម', key: 'p', width: 6 }, { header: 'យ', key: 'l', width: 6 }, { header: 'ច', key: 'v', width: 6 }, { header: 'អ', key: 'a', width: 6 }];
    styleHeader(ws, 2 + days + 4);
    students.forEach((st) => {
      const r = { code: st.code, name: st.name }; const cnt = { 'មកដល់': 0, 'យឺត': 0, 'សុំច្បាប់': 0, 'អវត្តមាន': 0 };
      for (let d = 1; d <= days; d++) { const s = map[st.id]?.[d]; r['d' + d] = s ? ATT_MARK[s] : ''; if (s) cnt[s]++; }
      Object.assign(r, { p: cnt['មកដល់'], l: cnt['យឺត'], v: cnt['សុំច្បាប់'], a: cnt['អវត្តមាន'] });
      const row = ws.addRow(r); row.font = { name: 'Khmer OS Battambang', size: 11 };
      for (let d = 1; d <= days; d++) { const c = row.getCell(2 + d); c.alignment = { horizontal: 'center' };
        if (c.value === 'អ') c.font = { color: { argb: 'FFB3261E' }, bold: true, name: 'Khmer OS Battambang' }; }
    });
    const n = students.length + 3;
    ws.getCell(n, 1).value = 'ម = មកដល់   យ = យឺត   ច = សុំច្បាប់   អ = អវត្តមាន'; ws.getCell(n, 1).font = { italic: true, color: { argb: 'FF666666' } };
    await send(res, wb, `វត្តមានប្រចាំខែ-${month}`);
  }));
};
