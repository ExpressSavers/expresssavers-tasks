const express = require('express');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'expresssavers-secret-2025-changeme';

// ── DB ────────────────────────────────────────────────
const db = createClient({ 
  url: process.env.DB_URL || 'file:./tasks.db',
  authToken: process.env.DB_TOKEN || undefined
});

async function initDB() {
  const dbUrl = process.env.DB_URL;
  if (!dbUrl || dbUrl === 'file:./tasks.db') {
    console.warn('⚠️  WARNING: Using local database file. Data will be lost on redeploy.');
    console.warn('⚠️  Set DB_URL environment variable to a Turso database URL for persistent storage.');
    console.warn('⚠️  See DEPLOYMENT_GUIDE.txt for instructions.');
  } else {
    console.log('✅ Using external database:', dbUrl.split('?')[0]);
  }
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      site TEXT NOT NULL,
      pin TEXT NOT NULL,
      is_manager INTEGER DEFAULT 0,
      color TEXT DEFAULT '#1A3F6F',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      shift TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      time_window TEXT,
      penalty INTEGER DEFAULT 0,
      penalty_amount INTEGER DEFAULT 0,
      penalty_rule TEXT,
      requires_photo INTEGER DEFAULT 0,
      photo_label TEXT,
      critical INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      label TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS completions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      site TEXT NOT NULL,
      date TEXT NOT NULL,
      shift TEXT NOT NULL,
      completed_at TEXT,
      notes TEXT,
      is_done INTEGER DEFAULT 0,
      penalty_triggered INTEGER DEFAULT 0,
      penalty_waived INTEGER DEFAULT 0,
      waived_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subtask_completions (
      id TEXT PRIMARY KEY,
      completion_id TEXT NOT NULL,
      subtask_id TEXT NOT NULL,
      checked INTEGER DEFAULT 0,
      FOREIGN KEY(completion_id) REFERENCES completions(id)
    );

    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      completion_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT,
      uploaded_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(completion_id) REFERENCES completions(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Seed settings
  await db.execute(`INSERT OR IGNORE INTO settings VALUES ('app_name','Express Savers Ltd')`);
  await db.execute(`INSERT OR IGNORE INTO settings VALUES ('manager_pin','1234')`);

  // Seed manager account
  const managerPin = await bcrypt.hash('admin1234', 10);
  await db.execute(`INSERT OR IGNORE INTO users (id,name,role,site,pin,is_manager,color) VALUES ('manager','Director','Manager','ALL',?,'1','#0D2137')`, [managerPin]);

  // Seed staff
  const staffList = [
    { id:'ng8_1', name:'Staff Member 1', role:'Senior', site:'NG8', color:'#1A3F6F' },
    { id:'ng8_2', name:'Staff Member 2', role:'Standard', site:'NG8', color:'#2E6DA4' },
    { id:'ng8_3', name:'Staff Member 3', role:'Standard', site:'NG8', color:'#00708A' },
    { id:'ng8_4', name:'Staff Member 4', role:'Part-time', site:'NG8', color:'#7B3F8C' },
    { id:'ng8_5', name:'Staff Member 5', role:'Part-time', site:'NG8', color:'#1E6B3A' },
    { id:'de65_1', name:'Staff Member 6', role:'PO/Senior', site:'DE65', color:'#1A3F6F' },
    { id:'de65_2', name:'Staff Member 7', role:'Standard', site:'DE65', color:'#2E6DA4' },
    { id:'de65_3', name:'Staff Member 8', role:'Standard', site:'DE65', color:'#00708A' },
    { id:'de65_4', name:'Staff Member 9', role:'Part-time', site:'DE65', color:'#7B3F8C' },
    { id:'de65_5', name:'Staff Member 10', role:'Part-time', site:'DE65', color:'#1E6B3A' },
  ];
  for (const s of staffList) {
    const hashed = await bcrypt.hash('1234', 10);
    await db.execute(`INSERT OR IGNORE INTO users (id,name,role,site,pin,is_manager,color) VALUES (?,?,?,?,?,0,?)`,
      [s.id, s.name, s.role, s.site, hashed, s.color]);
  }

  // Seed default tasks
  const defaultTasks = [
    // NG8 Opening
    { id:'t_op1', site:'NG8', shift:'opening', name:'Cash Float Count & Reconcile', description:'Count the float. Must match yesterday\'s closing record. Any discrepancy over £2 must be reported to the manager immediately.', time_window:'Before opening', penalty:1, penalty_amount:10, penalty_rule:'Failure to complete or report a float discrepancy is gross misconduct. £10 deduction applies.', requires_photo:1, photo_label:'Photo of counted float in till', critical:1, sort_order:1 },
    { id:'t_op2', site:'NG8', shift:'opening', name:'Chiller & Freezer Temperature Check', description:'Check ALL chiller units (0–8°C) and freezers (-18°C or below). This is a LEGAL food safety requirement.', time_window:'7:00am – 8:00am', penalty:1, penalty_amount:15, penalty_rule:'Missing temperature log is a food safety breach. £15 deduction applies.', requires_photo:1, photo_label:'Photo of each temperature display', critical:1, sort_order:2 },
    { id:'t_op3', site:'NG8', shift:'opening', name:'Date Check — All Chilled & Fresh', description:'Check every chilled product. Remove expired items. Mark down tomorrow\'s expiries at 30%. Never sell expired food — this is a criminal offence.', time_window:'7:00am – 8:30am', penalty:1, penalty_amount:20, penalty_rule:'Selling out-of-date food is a criminal offence. £20 deduction applies.', requires_photo:1, photo_label:'Photo of removed/marked-down stock', critical:1, sort_order:3 },
    { id:'t_op4', site:'NG8', shift:'opening', name:'Hot Food & Coffee Machine Check', description:'Switch on, clean, and test the coffee/hot food machine. Must be operational before first customer.', time_window:'7:00am', penalty:0, penalty_amount:0, penalty_rule:'', requires_photo:0, photo_label:'', critical:0, sort_order:4 },
    { id:'t_op5', site:'NG8', shift:'opening', name:'Shelves — Face & Fill', description:'All shelves fully faced before store opens. Fill gaps from stockroom. A full shelf sells more.', time_window:'7:00am – 9:00am', penalty:0, penalty_amount:0, penalty_rule:'', requires_photo:1, photo_label:'Photo of key aisles fully faced', critical:0, sort_order:5 },
    { id:'t_op6', site:'NG8', shift:'opening', name:'Lottery Terminal — Switch On', description:'Switch on lottery terminal. Confirm online, float correct, paper loaded.', time_window:'8:00am', penalty:0, penalty_amount:0, penalty_rule:'', requires_photo:0, photo_label:'', critical:0, sort_order:6 },
    { id:'t_op7', site:'NG8', shift:'opening', name:'Store Standards — Visual Check', description:'Walk the store. Floor clean, windows clean, A-board out, price tickets in place.', time_window:'Before opening', penalty:0, penalty_amount:0, penalty_rule:'', requires_photo:1, photo_label:'Photo of store entrance and displays', critical:0, sort_order:7 },
    // NG8 Midday
    { id:'t_md1', site:'NG8', shift:'midday', name:'Lunchtime Chilled Restock', description:'Restock chilled section for lunch rush. Meal deal components must be fully stocked at all times.', time_window:'11:00am – 12:30pm', penalty:0, penalty_amount:0, penalty_rule:'', requires_photo:1, photo_label:'Photo of fully stocked meal deal section', critical:0, sort_order:1 },
    { id:'t_md2', site:'NG8', shift:'midday', name:'Midday Temperature Check', description:'Second legal temperature check. Log all readings in notes field.', time_window:'12:00pm – 1:00pm', penalty:1, penalty_amount:10, penalty_rule:'Missing midday temperature check is a food safety breach. £10 deduction.', requires_photo:1, photo_label:'Photo of midday temperature displays', critical:1, sort_order:2 },
    { id:'t_md3', site:'NG8', shift:'midday', name:'Delivery Check — Count In', description:'Count ALL deliveries against the invoice before driver leaves. Note shortages on delivery note.', time_window:'On delivery arrival', penalty:1, penalty_amount:15, penalty_rule:'Signing for unchecked delivery resulting in unrecorded shortages: £15 deduction.', requires_photo:1, photo_label:'Photo of signed delivery note', critical:1, sort_order:3 },
    { id:'t_md4', site:'NG8', shift:'midday', name:'Midday Clean', description:'Empty bins, clean hot food area, sweep entrance, clean counter.', time_window:'1:00pm – 2:00pm', penalty:0, penalty_amount:0, penalty_rule:'', requires_photo:0, photo_label:'', critical:0, sort_order:4 },
    { id:'t_md5', site:'NG8', shift:'midday', name:'Refusals Log — Check & Update', description:'All refused sales (alcohol, tobacco, vapes, lottery) must be logged immediately. Challenge 25 applies.', time_window:'Ongoing / Midday review', penalty:1, penalty_amount:25, penalty_rule:'Failure to log a refused sale or any underage sale: £25 deduction and licensing referral.', requires_photo:0, photo_label:'', critical:1, sort_order:5 },
    // NG8 Closing
    { id:'t_cl1', site:'NG8', shift:'closing', name:'Closing Float Count & Banking', description:'Count the till. Record closing total. Prepare banking. Discrepancy over £5 must be reported.', time_window:'30 mins before close', penalty:1, penalty_amount:15, penalty_rule:'Failure to complete closing count or banking prep: £15 deduction.', requires_photo:1, photo_label:'Photo of completed Z-report', critical:1, sort_order:1 },
    { id:'t_cl2', site:'NG8', shift:'closing', name:'Closing Temperature Check', description:'Final temperature check. All chillers and freezers within safe range before leaving.', time_window:'Closing time', penalty:1, penalty_amount:10, penalty_rule:'Missing closing temperature check: £10 deduction.', requires_photo:1, photo_label:'Photo of closing temperature readings', critical:1, sort_order:2 },
    { id:'t_cl3', site:'NG8', shift:'closing', name:'Date Check — Remove Expired Stock', description:'Remove ALL stock expiring today. Mark down tomorrow\'s expiries at 30%. Log all removed items.', time_window:'Closing time', penalty:1, penalty_amount:20, penalty_rule:'Expired stock left on shelf overnight: £20 deduction and food safety incident report.', requires_photo:1, photo_label:'Photo of removed/marked-down stock', critical:1, sort_order:3 },
    { id:'t_cl4', site:'NG8', shift:'closing', name:'Full Store Clean', description:'Floors swept and mopped. All surfaces wiped. Bins emptied. Coffee machine cleaned and switched off.', time_window:'Closing time', penalty:0, penalty_amount:0, penalty_rule:'', requires_photo:1, photo_label:'Photo of clean store at close', critical:0, sort_order:4 },
    { id:'t_cl5', site:'NG8', shift:'closing', name:'Security Check — Lock Up', description:'All doors locked. Alarm set and confirmed. CCTV operational.', time_window:'Closing time', penalty:1, penalty_amount:25, penalty_rule:'Leaving without locking all entry points or setting alarm: £25 deduction, potential gross misconduct.', requires_photo:1, photo_label:'Photo of locked entrance and alarm panel', critical:1, sort_order:5 },
    { id:'t_cl6', site:'NG8', shift:'closing', name:'Next Day Prep — Stock Review', description:'Check milk, bread, energy drinks, newspapers. Notify manager of any urgent reorder needs.', time_window:'Closing time', penalty:0, penalty_amount:0, penalty_rule:'', requires_photo:0, photo_label:'', critical:0, sort_order:6 },
    // DE65 tasks — mirror NG8 with different IDs plus PO tasks
    { id:'t_de_op1', site:'DE65', shift:'opening', name:'Cash Float Count & Reconcile', description:'Count the float. Must match yesterday\'s closing record. Any discrepancy over £2 must be reported immediately.', time_window:'Before opening', penalty:1, penalty_amount:10, penalty_rule:'Failure to complete or report discrepancy: £10 deduction.', requires_photo:1, photo_label:'Photo of counted float', critical:1, sort_order:1 },
    { id:'t_de_op2', site:'DE65', shift:'opening', name:'Chiller & Freezer Temperature Check', description:'Check ALL chillers (0–8°C) and freezers (-18°C or below). Legal food safety requirement.', time_window:'Before opening', penalty:1, penalty_amount:15, penalty_rule:'Missing temperature log: £15 deduction.', requires_photo:1, photo_label:'Photo of temperature displays', critical:1, sort_order:2 },
    { id:'t_de_op3', site:'DE65', shift:'opening', name:'Date Check — All Chilled & Fresh', description:'Check every chilled product. Remove expired. Mark down tomorrow\'s expiries at 30%.', time_window:'Opening', penalty:1, penalty_amount:20, penalty_rule:'Expired food on shelf: £20 deduction.', requires_photo:1, photo_label:'Photo of removed/marked-down stock', critical:1, sort_order:3 },
    { id:'t_de_po1', site:'DE65', shift:'opening', name:'Post Office — Open & Cash Check', description:'PO must open on time as contractually required. Count PO float SEPARATELY — never mix with retail cash.', time_window:'9:00am SHARP', penalty:1, penalty_amount:20, penalty_rule:'Late PO opening or mixing PO cash with retail: £20 deduction and contractual breach to Post Office Ltd.', requires_photo:1, photo_label:'Photo of PO counter ready to open', critical:1, sort_order:4 },
    { id:'t_de_op4', site:'DE65', shift:'opening', name:'Shelves — Face & Fill', description:'All shelves fully faced and filled before opening.', time_window:'Opening', penalty:0, penalty_amount:0, penalty_rule:'', requires_photo:1, photo_label:'Photo of key aisles', critical:0, sort_order:5 },
    { id:'t_de_op5', site:'DE65', shift:'opening', name:'Store Standards — Visual Check', description:'Floor clean, windows clean, A-board out, price tickets in place.', time_window:'Before opening', penalty:0, penalty_amount:0, penalty_rule:'', requires_photo:1, photo_label:'Photo of store entrance', critical:0, sort_order:6 },
    { id:'t_de_md1', site:'DE65', shift:'midday', name:'Midday Temperature Check', description:'Second legal temperature check of the day. Log all readings.', time_window:'12:00pm – 1:00pm', penalty:1, penalty_amount:10, penalty_rule:'Missing midday temperature check: £10 deduction.', requires_photo:1, photo_label:'Photo of midday temperatures', critical:1, sort_order:1 },
    { id:'t_de_md2', site:'DE65', shift:'midday', name:'Delivery Check — Count In', description:'Count all deliveries against invoice before driver leaves.', time_window:'On delivery arrival', penalty:1, penalty_amount:15, penalty_rule:'Unchecked delivery resulting in unrecorded shortages: £15 deduction.', requires_photo:1, photo_label:'Photo of signed delivery note', critical:1, sort_order:2 },
    { id:'t_de_md3', site:'DE65', shift:'midday', name:'Refusals Log — Check & Update', description:'All refused sales must be logged. Challenge 25 applies at all times.', time_window:'Ongoing / Midday', penalty:1, penalty_amount:25, penalty_rule:'Failure to log refused sale or underage sale: £25 deduction and licensing referral.', requires_photo:0, photo_label:'', critical:1, sort_order:3 },
    { id:'t_de_md4', site:'DE65', shift:'midday', name:'Midday Clean', description:'Empty bins, clean surfaces, sweep entrance, clean counter.', time_window:'1:00pm', penalty:0, penalty_amount:0, penalty_rule:'', requires_photo:0, photo_label:'', critical:0, sort_order:4 },
    { id:'t_de_cl1', site:'DE65', shift:'closing', name:'Post Office — Close & Settlement', description:'Close PO at contracted hours. Complete settlement. PO cash into PO bag ONLY — never into retail till.', time_window:'PO closing time', penalty:1, penalty_amount:20, penalty_rule:'Mixing PO settlement with retail cash: £20 deduction and escalation to Post Office Ltd.', requires_photo:1, photo_label:'Photo of completed PO settlement slip', critical:1, sort_order:1 },
    { id:'t_de_cl2', site:'DE65', shift:'closing', name:'Closing Float Count & Banking', description:'Count till. Record closing total. Prepare banking. Any discrepancy over £5 must be reported.', time_window:'30 mins before close', penalty:1, penalty_amount:15, penalty_rule:'Failure to complete closing count: £15 deduction.', requires_photo:1, photo_label:'Photo of Z-report', critical:1, sort_order:2 },
    { id:'t_de_cl3', site:'DE65', shift:'closing', name:'Closing Temperature Check', description:'Final temperature check before leaving.', time_window:'Closing time', penalty:1, penalty_amount:10, penalty_rule:'Missing closing temperature check: £10 deduction.', requires_photo:1, photo_label:'Photo of closing temperatures', critical:1, sort_order:3 },
    { id:'t_de_cl4', site:'DE65', shift:'closing', name:'Date Check — Remove Expired Stock', description:'Remove all today\'s expiries. Mark down tomorrow\'s at 30%. Log all removed items.', time_window:'Closing time', penalty:1, penalty_amount:20, penalty_rule:'Expired stock overnight: £20 deduction.', requires_photo:1, photo_label:'Photo of removed stock', critical:1, sort_order:4 },
    { id:'t_de_cl5', site:'DE65', shift:'closing', name:'Security Check — Lock Up', description:'All doors locked. Alarm set. CCTV confirmed operational.', time_window:'Closing time', penalty:1, penalty_amount:25, penalty_rule:'Leaving without locking or setting alarm: £25 deduction.', requires_photo:1, photo_label:'Photo of locked entrance and alarm', critical:1, sort_order:5 },
    { id:'t_de_cl6', site:'DE65', shift:'closing', name:'Full Store Clean', description:'Floors swept and mopped. Surfaces wiped. Bins emptied.', time_window:'Closing time', penalty:0, penalty_amount:0, penalty_rule:'', requires_photo:1, photo_label:'Photo of clean store at close', critical:0, sort_order:6 },
  ];

  const defaultSubtasks = {
    t_op1: ['Count notes and coins','Confirm total matches float record','Record any discrepancy in notes','Sign off till'],
    t_op2: ['Check chiller 1 — record temp in notes','Check chiller 2 — record temp in notes','Check freezer — record temp in notes','Flag any unit outside safe range'],
    t_op3: ['Check all sandwiches / wraps','Check dairy (milk, cheese, yoghurt)','Check deli / prepared meats','Check juices / fresh drinks','Remove all expired stock','Mark down tomorrow\'s expiries (30%)','Record all removed items in notes'],
    t_op4: ['Switch on machine','Clean steam wand / nozzles','Check water level','Check coffee / supplies','Check cup stock','Test one cup — confirm working'],
    t_op5: ['Face confectionery aisle','Face soft drinks / energy','Face ambient grocery','Face crisps / snacks','Fill gaps from stockroom','Remove damaged stock'],
    t_op6: ['Switch on terminal','Confirm online status','Confirm receipt paper loaded','Check float / change available'],
    t_op7: ['Floor swept','Windows cleaned (inside)','A-board placed outside','Price tickets correct','Entrance area clean'],
    t_md1: ['Restock sandwiches / wraps','Restock drinks','Restock snacks / crisps','Confirm meal deal components in place','Face and rotate (oldest to front)'],
    t_md2: ['Check chiller 1 — record in notes','Check chiller 2 — record in notes','Check freezer — record in notes','Flag any readings outside safe range'],
    t_md3: ['Count all boxes / items against delivery note','Note any shortages or damages','Do NOT sign until fully checked','Inform manager of any issues','Put chilled / frozen away first'],
    t_md4: ['Empty till area bin','Empty cafe / hot food bin','Clean coffee machine surfaces','Clean counter area','Sweep entrance'],
    t_md5: ['Review morning refusals — confirm all logged','Record any midday refusals','Challenge 25 applies to anyone looking under 25','Note any incidents in manager log'],
    t_cl1: ['Count all notes and coins','Record closing till total in notes','Confirm against EPOS Z-report','Prepare banking bag','Note any discrepancy'],
    t_cl2: ['Check chiller 1','Check chiller 2','Check freezer','Log all readings in notes','Confirm all units within safe range'],
    t_cl3: ['Full chilled section sweep','Remove all today\'s expiries','Mark down tomorrow\'s expiries','Log removed items in notes','Confirm chilled clear for tomorrow'],
    t_cl4: ['Sweep all floors','Mop high-traffic areas','Wipe all counters and surfaces','Empty all bins','Clean and switch off coffee machine','Remove A-board from outside'],
    t_cl5: ['Front door locked and checked','Stock room / back door locked','Alarm set and confirmed','CCTV operational (check monitor)','Photo of locked entrance taken'],
    t_cl6: ['Check milk levels — note quantity','Check bread / bakery levels','Check energy drinks — flag if below 1 case','Check newspapers ordered','Note urgent reorder needs in notes'],
    t_de_po1: ['Open PO counter at contracted time','Count PO float SEPARATELY from retail','Confirm PO system online','Confirm PO supplies stocked','Log opening time in notes'],
    t_de_cl1: ['Close PO at contracted time','Complete PO daily settlement','Place PO cash in PO bag only','Keep PO and retail completely separate','Log settlement total in notes'],
  };

  for (const t of defaultTasks) {
    await db.execute(`INSERT OR IGNORE INTO tasks (id,site,shift,name,description,time_window,penalty,penalty_amount,penalty_rule,requires_photo,photo_label,critical,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [t.id,t.site,t.shift,t.name,t.description,t.time_window,t.penalty,t.penalty_amount,t.penalty_rule,t.requires_photo,t.photo_label,t.critical,t.sort_order]);
    if (defaultSubtasks[t.id]) {
      for (let i=0; i<defaultSubtasks[t.id].length; i++) {
        const stId = `${t.id}_st${i}`;
        await db.execute(`INSERT OR IGNORE INTO subtasks (id,task_id,label,sort_order) VALUES (?,?,?,?)`, [stId, t.id, defaultSubtasks[t.id][i], i]);
      }
    }
  }
  console.log('DB initialised');
}

// ── MIDDLEWARE ────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Upload directory
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, uuid() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

app.use('/uploads', express.static(uploadDir));

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function managerAuth(req, res, next) {
  auth(req, res, () => {
    if (!req.user.is_manager) return res.status(403).json({ error: 'Manager only' });
    next();
  });
}

// ── AUTH ROUTES ───────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { userId, pin } = req.body;
  if (!userId || !pin) return res.status(400).json({ error: 'Missing fields' });
  const result = await db.execute(`SELECT * FROM users WHERE id=?`, [userId]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'User not found' });
  const match = await bcrypt.compare(pin, user.pin);
  if (!match) return res.status(401).json({ error: 'Wrong PIN' });
  const token = jwt.sign({ id: user.id, name: user.name, site: user.site, role: user.role, is_manager: !!user.is_manager }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: { id: user.id, name: user.name, site: user.site, role: user.role, is_manager: !!user.is_manager, color: user.color } });
});

app.get('/api/users', async (req, res) => {
  const result = await db.execute(`SELECT id,name,role,site,color,is_manager FROM users ORDER BY site,name`);
  res.json(result.rows);
});

// ── TASKS ROUTES ──────────────────────────────────────
app.get('/api/tasks/:site', auth, async (req, res) => {
  const { site } = req.params;
  const tasks = await db.execute(`SELECT * FROM tasks WHERE site=? AND active=1 ORDER BY shift,sort_order`, [site]);
  const subtasks = await db.execute(`SELECT * FROM subtasks WHERE task_id IN (SELECT id FROM tasks WHERE site=? AND active=1) ORDER BY sort_order`, [site]);
  res.json({ tasks: tasks.rows, subtasks: subtasks.rows });
});

// ── COMPLETIONS ───────────────────────────────────────
function today() { return new Date().toISOString().split('T')[0]; }

app.get('/api/completions/:site/:date', auth, async (req, res) => {
  const { site, date } = req.params;
  const comps = await db.execute(`SELECT c.*, u.name as user_name, u.color as user_color FROM completions c JOIN users u ON c.user_id=u.id WHERE c.site=? AND c.date=?`, [site, date]);
  const photos = await db.execute(`SELECT p.* FROM photos p JOIN completions c ON p.completion_id=c.id WHERE c.site=? AND c.date=?`, [site, date]);
  const subComps = await db.execute(`SELECT sc.* FROM subtask_completions sc JOIN completions c ON sc.completion_id=c.id WHERE c.site=? AND c.date=?`, [site, date]);
  res.json({ completions: comps.rows, photos: photos.rows, subtask_completions: subComps.rows });
});

app.post('/api/completions', auth, async (req, res) => {
  const { task_id, shift, notes, is_done } = req.body;
  const date = today();
  const existing = await db.execute(`SELECT id FROM completions WHERE task_id=? AND user_id=? AND date=? AND shift=?`, [task_id, req.user.id, date, shift]);
  let compId;
  if (existing.rows.length) {
    compId = existing.rows[0].id;
    const completedAt = is_done ? new Date().toISOString() : null;
    await db.execute(`UPDATE completions SET is_done=?,notes=?,completed_at=? WHERE id=?`, [is_done?1:0, notes||'', completedAt, compId]);
  } else {
    compId = uuid();
    const completedAt = is_done ? new Date().toISOString() : null;
    await db.execute(`INSERT INTO completions (id,task_id,user_id,site,date,shift,is_done,notes,completed_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [compId, task_id, req.user.id, req.user.site, date, shift, is_done?1:0, notes||'', completedAt]);
  }
  res.json({ id: compId });
});

app.post('/api/completions/:id/subtask', auth, async (req, res) => {
  const { subtask_id, checked } = req.body;
  const existing = await db.execute(`SELECT id FROM subtask_completions WHERE completion_id=? AND subtask_id=?`, [req.params.id, subtask_id]);
  if (existing.rows.length) {
    await db.execute(`UPDATE subtask_completions SET checked=? WHERE completion_id=? AND subtask_id=?`, [checked?1:0, req.params.id, subtask_id]);
  } else {
    await db.execute(`INSERT INTO subtask_completions (id,completion_id,subtask_id,checked) VALUES (?,?,?,?)`, [uuid(), req.params.id, subtask_id, checked?1:0]);
  }
  res.json({ ok: true });
});

app.post('/api/completions/:id/photo', auth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const photoId = uuid();
  await db.execute(`INSERT INTO photos (id,completion_id,filename,original_name) VALUES (?,?,?,?)`,
    [photoId, req.params.id, req.file.filename, req.file.originalname]);
  res.json({ id: photoId, url: `/uploads/${req.file.filename}` });
});

app.delete('/api/photos/:id', auth, async (req, res) => {
  const photo = await db.execute(`SELECT filename FROM photos WHERE id=?`, [req.params.id]);
  if (photo.rows.length) {
    const fp = path.join(uploadDir, photo.rows[0].filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    await db.execute(`DELETE FROM photos WHERE id=?`, [req.params.id]);
  }
  res.json({ ok: true });
});

app.post('/api/completions/:id/penalty', auth, async (req, res) => {
  const { triggered, waived } = req.body;
  await db.execute(`UPDATE completions SET penalty_triggered=?,penalty_waived=?,waived_by=? WHERE id=?`,
    [triggered?1:0, waived?1:0, waived?req.user.name:null, req.params.id]);
  res.json({ ok: true });
});

// ── MANAGER ROUTES ────────────────────────────────────
app.get('/api/manager/dashboard', managerAuth, async (req, res) => {
  const date = req.query.date || today();
  const ng8 = await db.execute(`SELECT COUNT(*) as total FROM tasks WHERE site='NG8' AND active=1`);
  const de65 = await db.execute(`SELECT COUNT(*) as total FROM tasks WHERE site='DE65' AND active=1`);
  const ng8Done = await db.execute(`SELECT COUNT(DISTINCT task_id) as done FROM completions WHERE site='NG8' AND date=? AND is_done=1`, [date]);
  const de65Done = await db.execute(`SELECT COUNT(DISTINCT task_id) as done FROM completions WHERE site='DE65' AND date=? AND is_done=1`, [date]);
  const penalties = await db.execute(`SELECT c.*, u.name as user_name, t.name as task_name, t.penalty_amount FROM completions c JOIN users u ON c.user_id=u.id JOIN tasks t ON c.task_id=t.id WHERE c.date=? AND c.penalty_triggered=1`, [date]);
  const recentActivity = await db.execute(`SELECT c.completed_at, c.task_id, c.site, c.is_done, u.name as user_name, t.name as task_name FROM completions c JOIN users u ON c.user_id=u.id JOIN tasks t ON c.task_id=t.id WHERE c.date=? AND c.completed_at IS NOT NULL ORDER BY c.completed_at DESC LIMIT 20`, [date]);
  const staffActivity = await db.execute(`SELECT u.name, u.site, u.color, COUNT(c.id) as tasks_done FROM users u LEFT JOIN completions c ON u.id=c.user_id AND c.date=? AND c.is_done=1 WHERE u.is_manager=0 GROUP BY u.id ORDER BY u.site, tasks_done DESC`, [date]);
  res.json({
    date,
    ng8: { total: ng8.rows[0].total, done: ng8Done.rows[0].done },
    de65: { total: de65.rows[0].total, done: de65Done.rows[0].done },
    penalties: penalties.rows,
    recent_activity: recentActivity.rows,
    staff_activity: staffActivity.rows
  });
});

app.get('/api/manager/tasks', managerAuth, async (req, res) => {
  const tasks = await db.execute(`SELECT t.*, GROUP_CONCAT(s.label, '||') as subtask_labels FROM tasks t LEFT JOIN subtasks s ON t.id=s.task_id GROUP BY t.id ORDER BY t.site, t.shift, t.sort_order`);
  res.json(tasks.rows);
});

app.post('/api/manager/tasks', managerAuth, async (req, res) => {
  const { site, shift, name, description, time_window, penalty, penalty_amount, penalty_rule, requires_photo, photo_label, critical, subtasks } = req.body;
  const id = 't_' + uuid().replace(/-/g,'').slice(0,8);
  const maxOrder = await db.execute(`SELECT MAX(sort_order) as m FROM tasks WHERE site=? AND shift=?`, [site, shift]);
  const sortOrder = (maxOrder.rows[0].m || 0) + 1;
  await db.execute(`INSERT INTO tasks (id,site,shift,name,description,time_window,penalty,penalty_amount,penalty_rule,requires_photo,photo_label,critical,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id,site,shift,name,description,time_window,penalty?1:0,penalty_amount||0,penalty_rule||'',requires_photo?1:0,photo_label||'',critical?1:0,sortOrder]);
  if (subtasks && subtasks.length) {
    for (let i=0; i<subtasks.length; i++) {
      await db.execute(`INSERT INTO subtasks (id,task_id,label,sort_order) VALUES (?,?,?,?)`, [uuid(), id, subtasks[i], i]);
    }
  }
  res.json({ id });
});

app.put('/api/manager/tasks/:id', managerAuth, async (req, res) => {
  const { name, description, time_window, penalty, penalty_amount, penalty_rule, requires_photo, photo_label, critical, active } = req.body;
  await db.execute(`UPDATE tasks SET name=?,description=?,time_window=?,penalty=?,penalty_amount=?,penalty_rule=?,requires_photo=?,photo_label=?,critical=?,active=? WHERE id=?`,
    [name,description,time_window,penalty?1:0,penalty_amount||0,penalty_rule||'',requires_photo?1:0,photo_label||'',critical?1:0,active!==false?1:0,req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/manager/tasks/:id', managerAuth, async (req, res) => {
  await db.execute(`UPDATE tasks SET active=0 WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/manager/staff', managerAuth, async (req, res) => {
  const result = await db.execute(`SELECT id,name,role,site,color,is_manager FROM users ORDER BY site,name`);
  res.json(result.rows);
});

app.post('/api/manager/staff', managerAuth, async (req, res) => {
  const { name, role, site, color, pin } = req.body;
  const id = (site||'staff').toLowerCase() + '_' + uuid().slice(0,6);
  const hashed = await bcrypt.hash(pin||'1234', 10);
  await db.execute(`INSERT INTO users (id,name,role,site,pin,color) VALUES (?,?,?,?,?,?)`, [id,name,role||'Standard',site,hashed,color||'#1A3F6F']);
  res.json({ id });
});

app.put('/api/manager/staff/:id', managerAuth, async (req, res) => {
  const { name, role, site, color, pin } = req.body;
  if (pin) {
    const hashed = await bcrypt.hash(pin, 10);
    await db.execute(`UPDATE users SET name=?,role=?,site=?,color=?,pin=? WHERE id=?`, [name,role,site,color,hashed,req.params.id]);
  } else {
    await db.execute(`UPDATE users SET name=?,role=?,site=?,color=? WHERE id=?`, [name,role,site,color,req.params.id]);
  }
  res.json({ ok: true });
});

app.delete('/api/manager/staff/:id', managerAuth, async (req, res) => {
  await db.execute(`DELETE FROM users WHERE id=? AND is_manager=0`, [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/manager/waive/:completionId', managerAuth, async (req, res) => {
  await db.execute(`UPDATE completions SET penalty_waived=1, waived_by=? WHERE id=?`, [req.user.name, req.completionId]);
  res.json({ ok: true });
});

app.get('/api/manager/history', managerAuth, async (req, res) => {
  const { site, days=90 } = req.query;
  const where = site ? `AND c.site=?` : '';
  const params = site ? [days, site] : [days];
  // Full task-level history
  const result = await db.execute(`SELECT c.date, c.site, c.task_id, c.is_done, c.penalty_triggered, c.penalty_waived, c.completed_at, c.notes, u.name as user_name, t.name as task_name, t.shift, t.penalty_amount FROM completions c JOIN users u ON c.user_id=u.id JOIN tasks t ON c.task_id=t.id WHERE c.date >= date('now','-'||?||' days') ${where} ORDER BY c.date DESC, c.site, t.shift, t.sort_order`, params);
  // Daily summary stats
  const summary = await db.execute(`SELECT c.date, c.site, COUNT(DISTINCT c.task_id) as tasks_done, COUNT(DISTINCT CASE WHEN c.penalty_triggered=1 AND c.penalty_waived=0 THEN c.id END) as penalties, COUNT(DISTINCT u.id) as staff_active FROM completions c JOIN users u ON c.user_id=u.id WHERE c.date >= date('now','-'||?||' days') ${where} AND c.is_done=1 GROUP BY c.date, c.site ORDER BY c.date DESC`, params);
  res.json({ rows: result.rows, summary: summary.rows });
});

// ── ONE-TIME SETUP / RESET ENDPOINT ─────────────────
// Visit /api/setup?key=expresssavers2025 to initialise/reset the database
app.get('/api/setup', async (req, res) => {
  const { key } = req.query;
  if (key !== 'expresssavers2025') return res.status(403).json({ error: 'Invalid key' });
  try {
    await initDB();
    // Force reset manager PIN to admin1234
    const managerPin = await bcrypt.hash('admin1234', 10);
    await db.execute(`INSERT OR REPLACE INTO users (id,name,role,site,pin,is_manager,color) VALUES ('manager','Director','Manager','ALL',?,'1','#0D2137')`, [managerPin]);
    // Reset all staff PINs to 1234
    const staffPin = await bcrypt.hash('1234', 10);
    const staffList = [
      {id:'ng8_1',name:'Staff Member 1',role:'Senior',site:'NG8',color:'#1A3F6F'},
      {id:'ng8_2',name:'Staff Member 2',role:'Standard',site:'NG8',color:'#2E6DA4'},
      {id:'ng8_3',name:'Staff Member 3',role:'Standard',site:'NG8',color:'#00708A'},
      {id:'ng8_4',name:'Staff Member 4',role:'Part-time',site:'NG8',color:'#7B3F8C'},
      {id:'ng8_5',name:'Staff Member 5',role:'Part-time',site:'NG8',color:'#1E6B3A'},
      {id:'de65_1',name:'Staff Member 6',role:'PO/Senior',site:'DE65',color:'#1A3F6F'},
      {id:'de65_2',name:'Staff Member 7',role:'Standard',site:'DE65',color:'#2E6DA4'},
      {id:'de65_3',name:'Staff Member 8',role:'Standard',site:'DE65',color:'#00708A'},
      {id:'de65_4',name:'Staff Member 9',role:'Part-time',site:'DE65',color:'#7B3F8C'},
      {id:'de65_5',name:'Staff Member 10',role:'Part-time',site:'DE65',color:'#1E6B3A'},
    ];
    for (const s of staffList) {
      await db.execute(`INSERT OR IGNORE INTO users (id,name,role,site,pin,is_manager,color) VALUES (?,?,?,?,?,0,?)`,
        [s.id, s.name, s.role, s.site, staffPin, s.color]);
    }
    const users = await db.execute('SELECT id,name,site,is_manager FROM users');
    const tasks = await db.execute('SELECT COUNT(*) as c FROM tasks');
    res.json({
      success: true,
      message: 'Database initialised successfully',
      manager_pin: 'admin1234',
      staff_pin: '1234',
      users: users.rows,
      task_count: tasks.rows[0].c,
      note: 'You can now log into the manager dashboard with PIN: admin1234'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── BACKUP / EXPORT ──────────────────────────────────
app.get('/api/manager/backup', managerAuth, async (req, res) => {
  const users = await db.execute('SELECT id,name,role,site,color,is_manager FROM users');
  const tasks = await db.execute('SELECT * FROM tasks');
  const subtasks = await db.execute('SELECT * FROM subtasks');
  const completions = await db.execute('SELECT * FROM completions ORDER BY date DESC');
  const photos = await db.execute('SELECT id,completion_id,filename,uploaded_at FROM photos');
  res.json({
    exported_at: new Date().toISOString(),
    users: users.rows,
    tasks: tasks.rows,
    subtasks: subtasks.rows,
    completions: completions.rows,
    photos: photos.rows
  });
});

// ── DAILY STATS SUMMARY ───────────────────────────────
app.get('/api/manager/stats', managerAuth, async (req, res) => {
  const { days=90 } = req.query;
  const ng8Tasks = await db.execute("SELECT COUNT(*) as total FROM tasks WHERE site='NG8' AND active=1");
  const de65Tasks = await db.execute("SELECT COUNT(*) as total FROM tasks WHERE site='DE65' AND active=1");
  // Per-day completion rates for last N days
  const daily = await db.execute(`
    SELECT 
      c.date,
      c.site,
      COUNT(DISTINCT CASE WHEN c.is_done=1 THEN c.task_id END) as done,
      COUNT(DISTINCT CASE WHEN c.penalty_triggered=1 AND c.penalty_waived=0 THEN c.id END) as penalties,
      SUM(CASE WHEN c.penalty_triggered=1 AND c.penalty_waived=0 THEN t.penalty_amount ELSE 0 END) as penalty_total,
      COUNT(DISTINCT u.id) as staff_count
    FROM completions c 
    JOIN users u ON c.user_id=u.id
    JOIN tasks t ON c.task_id=t.id
    WHERE c.date >= date('now','-'||?||' days')
    GROUP BY c.date, c.site 
    ORDER BY c.date DESC
  `, [days]);
  // Top missed tasks
  const missed = await db.execute(`
    SELECT t.name, t.site, t.shift, COUNT(*) as miss_count
    FROM completions c
    JOIN tasks t ON c.task_id=t.id
    WHERE c.is_done=0 AND c.date >= date('now','-'||?||' days')
    GROUP BY c.task_id
    ORDER BY miss_count DESC
    LIMIT 10
  `, [days]);
  // Best performing staff
  const topStaff = await db.execute(`
    SELECT u.name, u.site, u.color,
      COUNT(CASE WHEN c.is_done=1 THEN 1 END) as tasks_done,
      COUNT(CASE WHEN c.penalty_triggered=1 AND c.penalty_waived=0 THEN 1 END) as penalties
    FROM users u
    LEFT JOIN completions c ON u.id=c.user_id AND c.date >= date('now','-'||?||' days')
    WHERE u.is_manager=0
    GROUP BY u.id
    ORDER BY tasks_done DESC
  `, [days]);
  res.json({
    task_counts: { ng8: ng8Tasks.rows[0].total, de65: de65Tasks.rows[0].total },
    daily: daily.rows,
    most_missed: missed.rows,
    staff_performance: topStaff.rows
  });
});

// ── START ─────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`Express Savers running on port ${PORT}`));
}).catch(console.error);
