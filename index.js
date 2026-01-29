const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const mongoose = require('mongoose');
const fs = require('fs');
const multer = require('multer');
// Insemination model not used in current registry view

const app = express();
const PORT = 3000;

// Connect to MongoDB
mongoose.connect(process.env.mongoURI || `mongodb://localhost:27017/`, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', () => {
    console.log('Connected to MongoDB');
});

// Define schemas
const cowSchema = new mongoose.Schema({
    cowNumber: String,
    cowName: String,
    race: String,
    dob: Date,
    lastCalving: Date,
    notes: String,
    profileImageUrl: String,
    // Pregnancy tracking removed per UI simplification
    motherCowNumber: String,
    motherCowName: String,
    motherCowBreed: String,
    sireBullNumber: String,
    sireBullName: String,
    sireBullBreed: String,
});

const calfSchema = new mongoose.Schema({
    calfName: { type: String, required: true },
    calfBreed: { type: String, required: true },
    birthDate: { type: Date, required: true },
    gender: { type: String, enum: ['male','female'], required: true },
    status: { type: String, enum: ['alive','miscarriage','died'], default: 'alive' },
    notes: { type: String },
    profileImageUrl: String,
    motherCowNumber: String,
    motherCowName: String,
    motherCowBreed: String,
    sireBullNumber: String,
    sireBullName: String,
    sireBullBreed: String,
    // Graduation to adult records
    graduated: { type: Boolean, default: false },
    graduatedAt: { type: Date, default: null },
    adultType: { type: String, enum: ['cow','bull',null], default: null },
    adultId: { type: mongoose.Schema.Types.ObjectId, default: null },
});

const bullSchema = new mongoose.Schema({
    bullNumber: String,
    bullName: String,
    race: String,
    dob: Date,
    notes: String,
    profileImageUrl: String,
    motherCowNumber: String,
    motherCowName: String,
    motherCowBreed: String,
    sireBullNumber: String,
    sireBullName: String,
    sireBullBreed: String,
    // Mark AI/seminal catalog bulls (no parents, used for insemination only)
    isInsemination: { type: Boolean, default: false },
});

// Basic insemination record (re-introduced for viewer profile calculations)
// A simple structure: which cow, when, and whether pregnancy was confirmed.
// Future enhancements could add technician, method, dose id, etc.
const inseminationSchema = new mongoose.Schema({
    cowId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cow', required: true },
    date: { type: Date, required: true },
    confirmedPregnant: { type: Boolean, default: false },
    failed: { type: Boolean, default: false }, // manual failure marker
    forced: { type: Boolean, default: false }, // distinguishes forced override attempts
    notes: String,
}, { timestamps: true });

const settingsSchema = new mongoose.Schema({
    // Core cow timing
    gestationDays: Number,
    dryOffAfterSuccessfulInsemDays: Number,
    changeFeedAfterSuccessfulInsemDays: Number,
    postpartumInseminationStartDays: Number,
    inseminationIntervalDays: Number, // Changed from months to days

    // Alerts
    calvingAlertBeforeDays: Number,
    dryOffAlertBeforeDays: Number,
    changeFeedAlertBeforeDays: Number,
    // New alert lead times
    pregnancyCheckAlertBeforeDays: Number,
    inseminationAlertBeforeDays: Number,
    graduationAlertBeforeDays: Number,
    weaningAlertBeforeDays: Number,

    // Calf management
    // Separate weaning days by sex
    femaleWeaningDays: Number,
    maleWeaningDays: Number,
    // Legacy shared weaning days retained for backward compatibility
    weaningDays: Number,
    // Maturity thresholds (calf -> cow/bull) in months
    femaleMaturityMonths: Number,
    maleMaturityMonths: Number,
    // Legacy fields retained for backward compatibility
    femaleWeaningMonths: Number,
    maleWeaningMonths: Number,
    maleSellAgeMonths: Number,
});

// Create models
const Cow = mongoose.model('Cow', cowSchema);
const Calf = mongoose.model('Calf', calfSchema);
const Bull = mongoose.model('Bull', bullSchema);
const Settings = mongoose.model('Settings', settingsSchema);
// Confirmation records for alert/task acknowledgements with undo
const confirmationSchema = new mongoose.Schema({
    entityType: { type: String, enum: ['cow','calf','bull'], required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    type: { type: String, required: true }, // 'calving','dryOff','changeFeed','pregnancyCheck','insemination','graduation'
    when: { type: Date, required: true }, // event date
    alertOn: { type: Date },
    note: String,
    undone: { type: Boolean, default: false },
}, { timestamps: true });
const Confirmation = mongoose.model('Confirmation', confirmationSchema);
const Cattle = require('./models/cattle');
const Insemination = mongoose.model('Insemination', inseminationSchema);
// Audit log model (inline for simplicity)
const auditSchema = new mongoose.Schema({
    cowId: { type: mongoose.Schema.Types.ObjectId, ref: 'Cow', index: true },
    inseminationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Insemination' },
    action: { type: String, required: true }, // e.g., 'insemination.add','insemination.forced','insemination.delete','insemination.confirm','insemination.fail','insemination.unconfirm','cow.calving.set','cow.calving.clear'
    actor: { type: String, default: 'user' }, // 'user' or 'override'
    at: { type: Date, default: Date.now },
    payload: { type: Object }, // arbitrary details/snapshots for restore
}, { timestamps: true });
const Audit = mongoose.model('Audit', auditSchema);

async function logAudit(entry){
    try{ await Audit.create(entry); } catch(err){ console.error('Audit log error:', err); }
}

// Auto-graduate calves to adult cow/bull based on settings maturity months
async function autoGraduateCalves(){
    try{
        const settings = await Settings.findOne().lean();
        const femaleMonths = settings?.femaleMaturityMonths ?? 24;
        const maleMonths = settings?.maleMaturityMonths ?? 24;
        const now = new Date();
        const calves = await Calf.find({ graduated: { $ne: true }, status: 'alive' }).lean();
        let promotedCount = 0;
        for (const k of calves){
            if(!k.birthDate || !k.gender) continue;
            const months = Math.floor((now - new Date(k.birthDate)) / (1000*60*60*24*30));
            const threshold = k.gender==='female' ? femaleMonths : maleMonths;
            if (months < threshold) continue;
            // Build adult doc
            let adult=null, adultType=null;
            if (k.gender==='female'){
                adultType='cow';
                adult = await Cow.create({
                    cowName: k.calfName || '',
                    cowNumber: '',
                    race: k.calfBreed || '',
                    dob: k.birthDate,
                    notes: (k.notes||'') + `\nGraduated from calf on ${now.toLocaleDateString()}`,
                    profileImageUrl: k.profileImageUrl || '',
                    motherCowNumber: k.motherCowNumber || '',
                    motherCowName: k.motherCowName || '',
                    motherCowBreed: k.motherCowBreed || '',
                    sireBullNumber: k.sireBullNumber || '',
                    sireBullName: k.sireBullName || '',
                    sireBullBreed: k.sireBullBreed || ''
                });
            } else {
                adultType='bull';
                adult = await Bull.create({
                    bullName: k.calfName || '',
                    bullNumber: '',
                    race: k.calfBreed || '',
                    dob: k.birthDate,
                    notes: (k.notes||'') + `\nGraduated from calf on ${now.toLocaleDateString()}`,
                    profileImageUrl: k.profileImageUrl || '',
                    motherCowNumber: k.motherCowNumber || '',
                    motherCowName: k.motherCowName || '',
                    motherCowBreed: k.motherCowBreed || '',
                    sireBullNumber: k.sireBullNumber || '',
                    sireBullName: k.sireBullName || '',
                    sireBullBreed: k.sireBullBreed || ''
                });
            }
            await Calf.findByIdAndUpdate(k._id, { graduated: true, graduatedAt: now, adultType, adultId: adult._id });
            // Link to mother cow history if available
            let mother=null; if(k.motherCowNumber){ mother = await Cow.findOne({ cowNumber: k.motherCowNumber }).lean(); }
            if (mother){ await logAudit({ cowId: mother._id, action:'calf.graduate', actor:'system', payload:{ calfId: k._id, calfName: k.calfName || '', gender: k.gender, adultType, adultId: adult._id } }); }
            promotedCount++;
        }
        return { promoted: promotedCount };
    } catch(err){ console.error('autoGraduateCalves error:', err); return { promoted: 0, error: true }; }
}

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded
app.use(express.json()); // Middleware to parse JSON data

// Session for override access (simple password gate)
app.use(session({
    secret: process.env.OVERRIDE_SESSION_SECRET || 'dev-override-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 30 } // 30 minutes
}));

// Expose override flag to templates
app.use((req,res,next)=>{
    res.locals.cowOverride = !!req.session.cowOverride;
    next();
});

// Middleware to set default title
app.use((req, res, next) => {
    res.locals.title = '';
    next();
});

// Replace mock data with database queries
app.get('/', async (req, res) => {
    try {
        const [cows, calves, bulls, settings, insems, confirms] = await Promise.all([
            Cow.find().lean(),
            Calf.find().lean(),
            Bull.find().lean(),
            Settings.findOne().lean(),
            Insemination.find().lean(),
            Confirmation.find({ undone: { $ne: true } }).lean(),
        ]);
        const alerts = buildAlerts({ cows, calves, bulls, settings, insems, confirmations: confirms });
        res.render('index', { title: 'SweetCow Dashboard', cows, calves, bulls, alerts });
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Build alerts for a given anchor date (defaults to now). Week starts on Sunday.
function buildAlerts({ cows, calves, settings, insems, confirmations }, anchorDate){
    const now = anchorDate ? new Date(anchorDate) : new Date();
    const startOfWeek = new Date(now);
    const day = startOfWeek.getDay(); // 0=Sun
    startOfWeek.setDate(startOfWeek.getDate() - day); // move back to Sunday
    startOfWeek.setHours(0,0,0,0);
    const endOfWeek = new Date(startOfWeek); endOfWeek.setDate(endOfWeek.getDate()+7);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth()+1, 0); endOfMonth.setHours(23,59,59,999);
    const lead = {
        calving: settings?.calvingAlertBeforeDays ?? 10,
        dryOff: settings?.dryOffAlertBeforeDays ?? 1,
        changeFeed: settings?.changeFeedAlertBeforeDays ?? 1,
        pregnancyCheck: settings?.pregnancyCheckAlertBeforeDays ?? 3,
        insemination: settings?.inseminationAlertBeforeDays ?? 0,
        graduation: settings?.graduationAlertBeforeDays ?? 7,
        weaning: settings?.weaningAlertBeforeDays ?? 7,
    };
    const events=[];
    const byCowId = new Map(cows.map(c=> [String(c._id), c]));
    const cowInsems = new Map();
    for(const r of insems){ const k=String(r.cowId); if(!cowInsems.has(k)) cowInsems.set(k, []); cowInsems.get(k).push(r); }
    // Cow-based events using reproduction info
    for(const cow of cows){
        const records = (cowInsems.get(String(cow._id))||[]).sort((a,b)=> new Date(b.date)-new Date(a.date));
        const repro = buildPregnancyInfo(cow, settings, records);
        const push = (date,type,label,meta)=>{ if(!date) return; const when=new Date(date); const alertDate=new Date(when); const l=lead[type]||0; alertDate.setDate(alertDate.getDate()-l); events.push({ when, alertDate, type, label, entity:{ type:'cow', id:String(cow._id), name:cow.cowName||cow.cowNumber||'Cow' }, meta }); };
        if(repro.retryWindowEnd){ push(repro.retryWindowEnd,'pregnancyCheck','Pregnancy check', { latestId: repro.latest? String(repro.latest._id):null }); }
        if(repro.nextInseminationEarliest){ push(repro.nextInseminationEarliest,'insemination','Earliest insemination',{}); }
        if(repro.dryOffDate){ push(repro.dryOffDate,'dryOff','Dry-Off',{}); }
        if(repro.changeFeedDate){ push(repro.changeFeedDate,'changeFeed','Change Feed',{}); }
        if(repro.estCalving){ push(repro.estCalving,'calving','Estimated Calving',{}); }
    }
    // Calf weaning + graduations
    for(const calf of calves){
        if(!calf.birthDate || !calf.gender) continue;
        // Weaning
        const wDays = calf.gender==='female' ? (settings?.femaleWeaningDays ?? 180) : (settings?.maleWeaningDays ?? 180);
        const wTarget = new Date(calf.birthDate); wTarget.setDate(wTarget.getDate()+wDays);
        const wName = calf.calfName||'Calf'; const wLabel = `Weaning (${calf.gender})`;
        const wWhen = wTarget; const wAlertDate = new Date(wWhen); wAlertDate.setDate(wAlertDate.getDate()-(lead.weaning||0));
        events.push({ when: wWhen, alertDate: wAlertDate, type:'weaning', label: wLabel, entity:{ type:'calf', id:String(calf._id), name: wName }, meta:{} });
    }
    // Calf graduations
    for(const calf of calves){ if(calf.graduated) continue; if(!calf.birthDate || !calf.gender) continue; const months = calf.gender==='female' ? (settings?.femaleMaturityMonths ?? 24) : (settings?.maleMaturityMonths ?? 24); const target = new Date(calf.birthDate); target.setMonth(target.getMonth()+months); const name=calf.calfName||'Calf'; const label=`Graduate (${calf.gender})`; const when=target; const alertDate=new Date(when); alertDate.setDate(alertDate.getDate()-(lead.graduation||0)); events.push({ when, alertDate, type:'graduation', label, entity:{ type:'calf', id:String(calf._id), name }, meta:{} }); }
    // Exclude confirmed (not undone)
    const confKey = (e)=> `${e.entity.type}:${e.entity.id}:${e.type}:${new Date(e.when).toISOString().slice(0,10)}`;
    const confirmed = new Set((confirmations||[]).filter(c=> !c.undone).map(c=> `${c.entityType}:${String(c.entityId)}:${c.type}:${new Date(c.when).toISOString().slice(0,10)}`));
    const filtered = events.filter(e=> !confirmed.has(confKey(e)));
    // Derive weekly buckets and month markers
    // Build week day buckets using local midday to avoid UTC JSON shift to previous/next day
    const weekDays = [];
    for(let i=0;i<7;i++){
        const d = new Date(startOfWeek);
        d.setDate(d.getDate()+i);
        const uiDate = new Date(d);
        uiDate.setHours(12,0,0,0); // use 12:00 local time for stable client rendering
        weekDays.push(uiDate);
    }
    const week = weekDays.map(d=> ({ date: d, items: [] }));
    // Week by alertDate (for weekly alerts display)
    const weekAlerts = weekDays.map(d=> ({ date: d, items: [] }));
    const monthDays = []; const totalDays=endOfMonth.getDate(); for(let i=1;i<=totalDays;i++){ monthDays.push({ day:i, items:[] }); }
    const monthDueDays = []; for(let i=1;i<=totalDays;i++){ monthDueDays.push({ day:i, items:[] }); }
    for(const ev of filtered){
        // Monthly alerts (Upcoming): dots reflect alertDate
        if(ev.alertDate >= startOfMonth && ev.alertDate <= endOfMonth){ const idx = ev.alertDate.getDate(); monthDays[idx-1].items.push(ev); }
        // Monthly tasks calendar: reflect actual event due date
        if(ev.when >= startOfMonth && ev.when <= endOfMonth){ const di = new Date(ev.when).getDate(); monthDueDays[di-1].items.push(ev); }
        // Weekly: tasks due on their event date (when)
        if(ev.when >= startOfWeek && ev.when < endOfWeek){ const wi = Math.floor((ev.when - startOfWeek)/(1000*60*60*24)); if(week[wi]) week[wi].items.push(ev); }
        // Weekly alerts: alerts occurring on their alertDate
        if(ev.alertDate >= startOfWeek && ev.alertDate < endOfWeek){ const wai = Math.floor((ev.alertDate - startOfWeek)/(1000*60*60*24)); if(weekAlerts[wai]) weekAlerts[wai].items.push(ev); }
    }
    // Past due: alerts whose alertDate is before the real current day (not anchor)
    const realTodayStart = new Date(); realTodayStart.setHours(0,0,0,0);
    const pastDue = filtered.filter(ev=> ev.alertDate < realTodayStart)
            .sort((a,b)=> new Date(a.alertDate) - new Date(b.alertDate))
            .slice(0,100);
    return { 
        week, 
        weekAlerts,
        month: { year: now.getFullYear(), monthIndex: now.getMonth(), days: monthDays },
        monthDue: { year: now.getFullYear(), monthIndex: now.getMonth(), days: monthDueDays },
        pastDue 
    };
}

// Alerts API to support dynamic week switching
app.get('/alerts', async (req,res)=>{
    try{
        const anchor = req.query.anchor; const when = anchor ? new Date(anchor) : new Date();
        const [cows, calves, settings, insems, confirms] = await Promise.all([
            Cow.find().lean(), Calf.find().lean(), Settings.findOne().lean(), Insemination.find().lean(), Confirmation.find({ undone: { $ne: true } }).lean()
        ]);
        const data = buildAlerts({ cows, calves, settings, insems, confirmations: confirms }, when);
        res.json(data);
    }catch(err){ console.error('alerts api error', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Confirm/Undo endpoints
app.post('/confirmation', async (req,res)=>{
    try{
        const { entityType, entityId, type, when, alertOn, note } = req.body || {};
        if(!entityType || !entityId || !type || !when) return res.status(400).json({ error:'Missing fields' });
        if(!['cow','calf','bull'].includes(entityType)) return res.status(400).json({ error:'Invalid entityType' });
        if(!mongoose.isValidObjectId(entityId)) return res.status(400).json({ error:'Invalid entityId' });
        const doc = await Confirmation.create({ entityType, entityId, type, when:new Date(when), alertOn: alertOn? new Date(alertOn): undefined, note: note||'' });
        return res.status(201).json(doc);
    }catch(err){ console.error('confirmation create error', err); res.status(500).json({ error:'Internal Server Error' }); }
});

app.post('/confirmation/:id/undo', async (req,res)=>{
    try{ const { id }=req.params; if(!mongoose.isValidObjectId(id)) return res.status(400).json({ error:'Invalid id' }); const doc = await Confirmation.findByIdAndUpdate(id, { undone: true }, { new:true }); if(!doc) return res.status(404).json({ error:'Not found' }); res.json(doc); }catch(err){ console.error('confirmation undo error', err); res.status(500).json({ error:'Internal Server Error' }); }
});

app.get('/confirmations', async (req,res)=>{
    try{ const { entityType, entityId } = req.query; if(!entityType || !entityId) return res.status(400).json({ error:'Missing params' }); const list = await Confirmation.find({ entityType, entityId, }).sort({ createdAt:-1 }).lean(); res.json(list); }catch(err){ console.error('confirmations list error', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Range query for confirmations across all entities (for dashboard completed view)
app.get('/confirmations-range', async (req,res)=>{
    try{
        const { from, to } = req.query;
        if(!from || !to) return res.status(400).json({ error:'Missing from/to' });
        const start = new Date(from+'T00:00:00');
        const end = new Date(to+'T23:59:59');
        const list = await Confirmation.find({ undone: { $ne: true }, when: { $gte: start, $lte: end } }).lean();
        // Enrich with entity names for display on dashboard
        const cowIds = [...new Set(list.filter(c=> c.entityType==='cow').map(c=> String(c.entityId)))];
        const calfIds = [...new Set(list.filter(c=> c.entityType==='calf').map(c=> String(c.entityId)))];
        const bullIds = [...new Set(list.filter(c=> c.entityType==='bull').map(c=> String(c.entityId)))];
        const [cowDocs, calfDocs, bullDocs] = await Promise.all([
            cowIds.length? Cow.find({ _id: { $in: cowIds } }).select('cowName cowNumber').lean() : [],
            calfIds.length? Calf.find({ _id: { $in: calfIds } }).select('calfName').lean() : [],
            bullIds.length? Bull.find({ _id: { $in: bullIds } }).select('bullName bullNumber').lean() : [],
        ]);
        const cowMap = new Map(cowDocs.map(d=> [String(d._id), (d.cowName || (d.cowNumber? ('#'+d.cowNumber) : 'Cow'))]));
        const calfMap = new Map(calfDocs.map(d=> [String(d._id), (d.calfName || 'Calf')]));
        const bullMap = new Map(bullDocs.map(d=> [String(d._id), (d.bullName || (d.bullNumber? ('#'+d.bullNumber) : 'Bull'))]));
        const withNames = list.map(c=>{
            const id = String(c.entityId);
            let nm = '';
            if(c.entityType==='cow') nm = cowMap.get(id) || '';
            else if(c.entityType==='calf') nm = calfMap.get(id) || '';
            else if(c.entityType==='bull') nm = bullMap.get(id) || '';
            return { ...c, entityName: nm };
        });
        res.json(withNames);
    }catch(err){ console.error('confirmations-range error', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Route for Cattle Management page
app.get('/cattle-management', (req, res) => {
    res.render('cattle-management', { title: 'Cattle Management' });
});

// Global cattle history: list all miscarriages and calf losses
app.get('/cattle-management/history', async (req,res)=>{
    try{
        const losses = await Calf.find({ status: { $in:['miscarriage','died'] } }).sort({ birthDate:-1 }).lean();
        const motherNums = [...new Set(losses.map(l=> l.motherCowNumber).filter(Boolean))];
        const mothersByNum = new Map((await Cow.find({ cowNumber: { $in: motherNums } }).lean()).map(c=> [c.cowNumber, c]));
        const items = losses.map(l=> ({
            id: String(l._id),
            name: l.calfName,
            status: l.status,
            birthDate: l.birthDate,
            motherNumber: l.motherCowNumber || '',
            motherName: (l.motherCowNumber && mothersByNum.get(l.motherCowNumber)?.cowName) || '',
        }));
        res.render('cattle-history', { title:'Cattle History', losses: items });
    }catch(err){ console.error('Global cattle history error:', err); res.status(500).send('Internal Server Error'); }
});

// Route for Settings page
app.get('/settings', async (req, res) => {
    try {
        let settings = await Settings.findOne();
        if (!settings) {
            settings = new Settings({
                gestationDays: 283,
                dryOffAfterSuccessfulInsemDays: 220,
                changeFeedAfterSuccessfulInsemDays: 260,
                postpartumInseminationStartDays: 60,
                inseminationIntervalDays: 90, // Changed to days
                calvingAlertBeforeDays: 10,
                dryOffAlertBeforeDays: 1,
                changeFeedAlertBeforeDays: 1,
                pregnancyCheckAlertBeforeDays: 3,
                inseminationAlertBeforeDays: 0,
                graduationAlertBeforeDays: 7,
                weaningAlertBeforeDays: 7,
                femaleWeaningDays: 180,
                maleWeaningDays: 180,
                femaleMaturityMonths: 24,
                maleMaturityMonths: 24,
                femaleWeaningMonths: 14,
                maleWeaningMonths: 8,
                maleSellAgeMonths: 16,
            });
            await settings.save();
        }
        // Migration: convert legacy month-based interval if present and day value missing (preserve 0)
        if (settings.inseminationIntervalDays == null && settings.inseminationIntervalMonths != null) {
            const months = settings.inseminationIntervalMonths;
            // Approximate conversion: 1 month = 30 days (domain-specific simplification)
            settings.inseminationIntervalDays = months * 30;
            await settings.save();
            console.log('[settings] Migrated inseminationIntervalMonths -> inseminationIntervalDays');
        }
        // Provide sensible defaults for new fields if older docs exist
        // Populate separate weaning days from legacy shared value if missing
        if (settings.femaleWeaningDays == null) settings.femaleWeaningDays = (settings.weaningDays != null ? settings.weaningDays : 180);
        if (settings.maleWeaningDays == null) settings.maleWeaningDays = (settings.weaningDays != null ? settings.weaningDays : 180);
        if (settings.femaleMaturityMonths == null) settings.femaleMaturityMonths = 24;
        if (settings.maleMaturityMonths == null) settings.maleMaturityMonths = 24;
        if (settings.pregnancyCheckAlertBeforeDays == null) settings.pregnancyCheckAlertBeforeDays = 3;
        if (settings.inseminationAlertBeforeDays == null) settings.inseminationAlertBeforeDays = 0;
        if (settings.graduationAlertBeforeDays == null) settings.graduationAlertBeforeDays = 7;
        if (settings.weaningAlertBeforeDays == null) settings.weaningAlertBeforeDays = 7;
        await settings.save();
        res.render('settings', { title: 'Settings', settings });
    } catch (error) {
        console.error('Error fetching settings:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Route to update settings
app.post('/settings', async (req, res) => {
    try {
        const {
          gestationDays,
          dryOffAfterSuccessfulInsemDays,
          changeFeedAfterSuccessfulInsemDays,
          postpartumInseminationStartDays,
          inseminationIntervalDays, // Changed to days
          calvingAlertBeforeDays,
          dryOffAlertBeforeDays,
          changeFeedAlertBeforeDays,
          femaleWeaningDays,
          maleWeaningDays,
          femaleMaturityMonths,
          maleMaturityMonths,
          pregnancyCheckAlertBeforeDays,
          inseminationAlertBeforeDays,
          graduationAlertBeforeDays,
          weaningAlertBeforeDays,
          // legacy fields may still post from older clients
          femaleWeaningMonths,
          maleWeaningMonths,
          maleSellAgeMonths,
        } = req.body;
        let settings = await Settings.findOne();
        if (!settings) {
            settings = new Settings();
        }
        // Coerce numeric values safely
        const n = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
        settings.gestationDays = n(gestationDays);
        settings.dryOffAfterSuccessfulInsemDays = n(dryOffAfterSuccessfulInsemDays);
        settings.changeFeedAfterSuccessfulInsemDays = n(changeFeedAfterSuccessfulInsemDays);
        settings.postpartumInseminationStartDays = n(postpartumInseminationStartDays);
        settings.inseminationIntervalDays = n(inseminationIntervalDays); // Changed to days
        settings.calvingAlertBeforeDays = n(calvingAlertBeforeDays);
        settings.dryOffAlertBeforeDays = n(dryOffAlertBeforeDays);
        settings.changeFeedAlertBeforeDays = n(changeFeedAlertBeforeDays);
        settings.pregnancyCheckAlertBeforeDays = n(pregnancyCheckAlertBeforeDays);
        settings.inseminationAlertBeforeDays = n(inseminationAlertBeforeDays);
        settings.graduationAlertBeforeDays = n(graduationAlertBeforeDays);
        settings.weaningAlertBeforeDays = n(weaningAlertBeforeDays);
        // New fields: separate weaning days
        settings.femaleWeaningDays = n(femaleWeaningDays);
        settings.maleWeaningDays = n(maleWeaningDays);
        settings.femaleMaturityMonths = n(femaleMaturityMonths);
        settings.maleMaturityMonths = n(maleMaturityMonths);
        // Legacy: keep storing if provided (not used by UI anymore)
        settings.femaleWeaningMonths = n(femaleWeaningMonths);
        settings.maleWeaningMonths = n(maleWeaningMonths);
        settings.maleSellAgeMonths = n(maleSellAgeMonths);
        await settings.save();
        res.redirect('/settings');
    } catch (error) {
        console.error('Error updating settings:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Route for Cattle Registry
app.get('/cattle-registry', async (req, res) => {
    try {
        const cows = await Cow.find();
        const calves = await Calf.find();
        const bulls = await Bull.find();
        res.render('cattle-registry', { title: 'Cattle Registry', cows, calves, bulls });
    } catch (error) {
        console.error('Error fetching cattle data:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Route for Cattle Viewer
app.get('/cattle-viewer', async (req, res) => {
    try {
        const [cows, calves, bulls, settings, insems] = await Promise.all([
            Cow.find().lean(),
            Calf.find().lean(),
            Bull.find().lean(),
            Settings.findOne().lean(),
            Insemination.find().lean(),
        ]);
        res.render('cattle-viewer', { title: 'Cattle Viewer', cows, calves, bulls, settings, inseminations: insems });
    } catch (err) {
        console.error('Error loading Cattle Viewer:', err);
        res.status(500).send('Internal Server Error');
    }
});

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'public', 'uploads', 'profiles');
fs.mkdirSync(uploadsDir, { recursive: true });

// Configure Multer for image uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase();
        const safeExt = ['.jpg','.jpeg','.png','.gif','.webp'].includes(ext) ? ext : '.jpg';
        const name = `${Date.now()}-${Math.random().toString(36).slice(2,8)}${safeExt}`;
        cb(null, name);
    }
});
const fileFilter = (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// Upload profile image and update entity
app.post('/profile/:type/:id/upload-image', upload.single('image'), async (req, res) => {
    try {
        const { type, id } = req.params;
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        let Model;
        if (type === 'cow') Model = Cow;
        else if (type === 'bull') Model = Bull;
        else if (type === 'calf') Model = Calf;
        else return res.status(400).json({ error: 'Invalid type' });

        const urlPath = `/uploads/profiles/${req.file.filename}`;
        const updated = await Model.findByIdAndUpdate(id, { profileImageUrl: urlPath }, { new: true }).lean();
        if (!updated) return res.status(404).json({ error: `${type} not found` });
        return res.json({ url: urlPath, item: updated });
    } catch (err) {
        console.error('Upload error:', err);
        return res.status(500).json({ error: 'Upload failed' });
    }
});

// Generic profile page routes (read-only view + optional inline edit later)
// Extended reproduction computation covering cycle windows and management dates.
function buildPregnancyInfo(cow, settings, insems){
    const now = new Date();
    // Date helpers to compute day deltas without time-of-day/DST drift
    const DAY_MS = 24*60*60*1000;
    const toUTCYMD = (d)=> Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    const daysBetween = (futureOrPastDate, refDate)=> Math.round((toUTCYMD(futureOrPastDate) - toUTCYMD(refDate))/DAY_MS);
    const gestationDays = settings?.gestationDays || 283;
    const dryOffDays = settings?.dryOffAfterSuccessfulInsemDays || 220;
    const changeFeedDays = settings?.changeFeedAfterSuccessfulInsemDays || 260;
    const postpartumStartDays = settings?.postpartumInseminationStartDays || 60;
    const retryIntervalDays = settings?.inseminationIntervalDays || 90; // window until recommended retry
    const allRecords = insems.filter(r => String(r.cowId) === String(cow._id)).sort((a,b)=> new Date(b.date) - new Date(a.date));
    const latest = allRecords[0] || null;
    let status = 'Open';
    let conceptionDate = null;
    let estCalving = null;
    let dryOffDate = null;
    let changeFeedDate = null;
    let retryWindowEnd = null;
    let nextInseminationEarliest = null; // declare early so failure branch can assign
    let daysUntilRetryWindowEnd = null;
    let daysUntilCalving = null;
    let daysUntilDryOff = null;
    let daysUntilChangeFeed = null;
    let daysUntilLatestInsemination = null; // signed: negative = days since, positive = days until
    let daysUntilLastCalving = null; // signed
    let daysUntilConception = null; // signed
    const lastCalving = cow.lastCalving ? new Date(cow.lastCalving) : null;
    if (latest){
        const latestDate = new Date(latest.date);
        if (latest.confirmedPregnant){
            status = 'Pregnant';
            conceptionDate = latestDate;
            estCalving = new Date(latestDate); estCalving.setDate(estCalving.getDate() + gestationDays);
            dryOffDate = new Date(latestDate); dryOffDate.setDate(dryOffDate.getDate() + dryOffDays);
            changeFeedDate = new Date(latestDate); changeFeedDate.setDate(changeFeedDate.getDate() + changeFeedDays);
            daysUntilCalving = daysBetween(estCalving, now);
            daysUntilDryOff = daysBetween(dryOffDate, now);
            daysUntilChangeFeed = daysBetween(changeFeedDate, now);
            daysUntilConception = daysBetween(conceptionDate, now);
        } else if (latest.failed) {
            // Failed attempt: cycle re-opens, earliest next attempt after retry window end
            status = 'Open';
            const retryBase = new Date(latestDate);
            retryBase.setDate(retryBase.getDate() + retryIntervalDays);
            nextInseminationEarliest = retryBase;
            daysUntilLatestInsemination = daysBetween(latestDate, now);
        } else {
            status = 'Pending';
            // retry window end = latest + retryMonths months
            retryWindowEnd = new Date(latestDate);
            retryWindowEnd.setDate(retryWindowEnd.getDate() + retryIntervalDays);
            daysUntilRetryWindowEnd = daysBetween(retryWindowEnd, now);
            daysUntilLatestInsemination = daysBetween(latestDate, now);
        }
        // If a calving was recorded after conception (pregnancy completed), reopen.
        if (status === 'Pregnant' && lastCalving && conceptionDate && lastCalving > conceptionDate){
            status = 'Open';
            conceptionDate = null;
            estCalving = null;
            dryOffDate = null;
            changeFeedDate = null;
            daysUntilCalving = null;
        }
    }
    // Next insemination earliest based on last calving when open (merge with failure retry constraint if present)
    if (lastCalving){
        const postpartumEarliest = new Date(lastCalving);
        postpartumEarliest.setDate(postpartumEarliest.getDate() + postpartumStartDays);
        if (nextInseminationEarliest){
            // take later of existing earliest and postpartum earliest
            if (postpartumEarliest > nextInseminationEarliest) nextInseminationEarliest = postpartumEarliest;
        } else {
            nextInseminationEarliest = postpartumEarliest;
        }
    }
    const canAddInseminationNow = status === 'Open' && (!nextInseminationEarliest || now >= nextInseminationEarliest);
    const canRetryNow = status === 'Pending' && retryWindowEnd && now >= retryWindowEnd;
    const daysUntilNextInseminationEarliest = nextInseminationEarliest ? daysBetween(nextInseminationEarliest, now) : null;
    if (cow.lastCalving){ const lc=new Date(cow.lastCalving); daysUntilLastCalving = daysBetween(lc, now); }
    if (latest){ daysUntilLatestInsemination = daysBetween(new Date(latest.date), now); }
    const canConfirmNow = status === 'Pending' && retryWindowEnd && now >= retryWindowEnd;
    return {
        status,
        conceptionDate,
        estCalving,
        dryOffDate,
        changeFeedDate,
        retryWindowEnd,
        nextInseminationEarliest,
        canAddInseminationNow,
        canRetryNow,
        canConfirmNow,
        gestationDays,
        latest,
        allRecordsCount: allRecords.length,
        daysUntilRetryWindowEnd,
        daysUntilCalving,
        daysUntilDryOff,
        daysUntilChangeFeed,
        daysUntilLatestInsemination,
        daysUntilLastCalving,
        daysUntilConception,
        daysUntilNextInseminationEarliest,
    };
}

app.get('/profile/cow/:id', async (req,res)=>{
    try {
        const [cow, settings, insems] = await Promise.all([
            Cow.findById(req.params.id).lean(),
            Settings.findOne().lean(),
            Insemination.find({ cowId: req.params.id }).lean()
        ]);
        if (!cow) return res.status(404).send('Cow not found');
        const repro = buildPregnancyInfo(cow, settings, insems);
        res.render('profile-cow', { title:'Cow Profile', cow, settings, insems, repro, override: !!req.session.cowOverride });
    } catch (err){
        console.error(err); res.status(500).send('Internal Server Error');
    }
});

// Cow history: combine audit events and key insemination records
app.get('/cow/:id/history', async (req,res)=>{
    try{
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error:'Invalid cow id' });
        // Only return important events: pregnancies (confirm/unconfirm/fail) and calvings (set)
        const audits = await Audit.find({ cowId:id }).sort({ createdAt:-1 }).lean();
        const items = [];
        const allowedInsem = new Set(['insemination.confirm','insemination.unconfirm','insemination.fail']);
        for (const a of audits){
            const base = { id: String(a._id), action:a.action, at:a.createdAt || a.at || new Date(), actor:a.actor||'user' };
            if (allowedInsem.has(a.action)){
                items.push({ ...base, type:'insemination', details:a.payload||{} });
            } else if (a.action === 'cow.calving.set'){
                let calf=null;
                if (a.payload && a.payload.calfId){ try{ calf = await Calf.findById(a.payload.calfId).lean(); }catch(_){} }
                items.push({ ...base, type:'calving', details:a.payload||{}, calf: calf ? { id:String(calf._id), name: calf.calfName, status: calf.status, birthDate: calf.birthDate } : null });
            } else if (a.action === 'calf.graduate'){
                // Graduation event: include created adult info
                let adult=null;
                if (a.payload && a.payload.adultId && a.payload.adultType){
                    try{
                        adult = a.payload.adultType==='cow' ? await Cow.findById(a.payload.adultId).lean() : await Bull.findById(a.payload.adultId).lean();
                    }catch(_){ }
                }
                items.push({ ...base, type:'graduate', details:a.payload||{}, adult: adult ? { id:String(adult._id), type:a.payload.adultType, name: adult.cowName || adult.bullName || '', number: adult.cowNumber || adult.bullNumber || '' } : null });
            }
            // All other actions are available via the full audit endpoint
        }
        res.json({ items });
    }catch(err){ console.error('Cow history error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Cow-specific losses (miscarriages/died)
app.get('/cow/:id/losses', async (req,res)=>{
    try{
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error:'Invalid cow id' });
        const cow = await Cow.findById(id).lean(); if(!cow) return res.status(404).json({ error:'Cow not found' });
        const calves = await Calf.find({ motherCowNumber: cow.cowNumber, status: { $in:['miscarriage','died'] } }).sort({ birthDate:-1 }).lean();
        res.json({ items: calves.map(c=> ({ id:String(c._id), name:c.calfName, status:c.status, birthDate:c.birthDate })) });
    }catch(err){ console.error('Cow losses error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

app.get('/profile/bull/:id', async (req,res)=>{
    try {
        const bull = await Bull.findById(req.params.id).lean();
        if (!bull) return res.status(404).send('Bull not found');
        res.render('profile-bull', { title:'Bull Profile', bull });
    } catch (err){ console.error(err); res.status(500).send('Internal Server Error'); }
});

// Bull history: graduated-from-calf
app.get('/bull/:id/history', async (req,res)=>{
    try{
        const { id } = req.params; if(!mongoose.isValidObjectId(id)) return res.status(400).json({ error:'Invalid bull id' });
        const bull = await Bull.findById(id).lean(); if(!bull) return res.status(404).json({ error:'Bull not found' });
        const fromCalves = await Calf.find({ adultType:'bull', adultId:id }).lean();
        const items = (fromCalves||[]).map(k=> ({ type:'graduate', at: k.graduatedAt || k.birthDate || new Date(), details:{ fromCalfId: k._id, fromCalfName: k.calfName||'' } , calf: { id:String(k._id), name:k.calfName||'' } }));
        res.json({ items });
    }catch(err){ console.error('Bull history error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// One-time normalization endpoint to backfill missing isInsemination field on legacy bulls.
// POST used to avoid accidental triggering via link prefetch. Not authenticated in this minimal setup.
app.post('/admin/normalize-bulls', async (req,res)=>{
    try {
        const result = await Bull.updateMany({ isInsemination: { $exists: false } }, { $set: { isInsemination: false } });
        res.json({ updated: result.modifiedCount });
    } catch(err){
        console.error('Normalization error:', err);
        res.status(500).json({ error: 'Failed to normalize bulls' });
    }
});

// Admin endpoint to run graduation now (override required)
app.post('/admin/graduate-calves', async (req,res)=>{
    try{
        if(!req.session.cowOverride) return res.status(403).json({ error:'Override required' });
        const result = await autoGraduateCalves();
        res.json({ ok:true, ...result });
    }catch(err){ console.error('Graduate calves error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Background auto-graduation (daily)
setInterval(()=>{ autoGraduateCalves().catch(()=>{}); }, 24*60*60*1000);

// Lookup by cow number (for lineage links)
app.get('/profile/cow/number/:number', async (req,res)=>{
    try {
        const cow = await Cow.findOne({ cowNumber: req.params.number }).lean();
        if (!cow) return res.status(404).send('Cow not found');
        const [settings, insems] = await Promise.all([
            Settings.findOne().lean(),
            Insemination.find({ cowId: cow._id }).lean()
        ]);
        const repro = buildPregnancyInfo(cow, settings, insems);
        res.render('profile-cow', { title:'Cow Profile', cow, settings, insems, repro, override: !!req.session.cowOverride });
    } catch (err){ console.error(err); res.status(500).send('Internal Server Error'); }
});

// Lookup by bull number
app.get('/profile/bull/number/:number', async (req,res)=>{
    try {
        const bull = await Bull.findOne({ bullNumber: req.params.number }).lean();
        if (!bull) return res.status(404).send('Bull not found');
        res.render('profile-bull', { title:'Bull Profile', bull });
    } catch (err){ console.error(err); res.status(500).send('Internal Server Error'); }
});

function getCalfGraduationInfo(calf, settings){
    if(!calf || !calf.birthDate || !calf.gender) return null;
    const femaleMonths = settings?.femaleMaturityMonths ?? 24;
    const maleMonths = settings?.maleMaturityMonths ?? 24;
    const thresholdMonths = calf.gender==='female' ? femaleMonths : maleMonths;
    const birth = new Date(calf.birthDate);
    const target = new Date(birth);
    target.setMonth(target.getMonth() + thresholdMonths);
    const now = new Date();
    const msLeft = target - now;
    const daysLeft = Math.ceil(msLeft / (1000*60*60*24));
    return { targetDate: target, daysLeft, ready: msLeft <= 0 };
}

app.get('/profile/calf/:id', async (req,res)=>{
    try {
        const calf = await Calf.findById(req.params.id).lean();
        if (!calf) return res.status(404).send('Calf not found');
        const settings = await Settings.findOne().lean();
        const gradInfo = getCalfGraduationInfo(calf, settings);
        res.render('profile-calf', { title:'Calf Profile', calf, gradInfo, override: !!req.session.cowOverride });
    } catch (err){ console.error(err); res.status(500).send('Internal Server Error'); }
});

// Calf history: graduation and losses
app.get('/calf/:id/history', async (req,res)=>{
    try{
        const { id } = req.params; if(!mongoose.isValidObjectId(id)) return res.status(400).json({ error:'Invalid calf id' });
        const calf = await Calf.findById(id).lean(); if(!calf) return res.status(404).json({ error:'Calf not found' });
        const items = [];
        if (calf.status && ['miscarriage','died'].includes(calf.status)){
            items.push({ type:'loss', at: calf.birthDate || new Date(), details:{ status: calf.status, name: calf.calfName||'' } });
        }
        if (calf.graduated){
            let adult=null; if (calf.adultId && calf.adultType){ try{ adult = calf.adultType==='cow' ? await Cow.findById(calf.adultId).lean() : await Bull.findById(calf.adultId).lean(); }catch(_){} }
            items.push({ type:'graduate', at: calf.graduatedAt || new Date(), details:{ adultType: calf.adultType, adultId: calf.adultId, calfName: calf.calfName||'' }, adult: adult ? { id:String(adult._id), type: calf.adultType, name: adult.cowName || adult.bullName || '', number: adult.cowNumber || adult.bullNumber || '' } : null });
        }
        res.json({ items });
    }catch(err){ console.error('Calf history error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Manual calf graduation endpoint (no auto-graduation)
app.post('/calf/:id/graduate', async (req,res)=>{
    try{
        const { id } = req.params; if(!mongoose.isValidObjectId(id)) return res.status(400).json({ error:'Invalid calf id' });
        const calf = await Calf.findById(id);
        if(!calf) return res.status(404).json({ error:'Calf not found' });
        if(calf.graduated) return res.status(409).json({ error:'Calf already graduated' });
        const settings = await Settings.findOne().lean();
        const info = getCalfGraduationInfo(calf, settings);
        const forced = !!req.body?.forced;
        const overrideActive = !!req.session.cowOverride;
        if((!info || !info.ready) && !(forced && overrideActive)){
            return res.status(400).json({ error:'Calf not ready for graduation' });
        }
        const now = new Date();
        let adult=null, adultType=null;
        if(calf.gender==='female'){
            adultType='cow';
            adult = await Cow.create({
                cowName: calf.calfName || '',
                cowNumber: '',
                race: calf.calfBreed || '',
                dob: calf.birthDate,
                notes: (calf.notes||'') + `\nGraduated from calf on ${now.toLocaleDateString()}`,
                profileImageUrl: calf.profileImageUrl || '',
                motherCowNumber: calf.motherCowNumber || '',
                motherCowName: calf.motherCowName || '',
                motherCowBreed: calf.motherCowBreed || '',
                sireBullNumber: calf.sireBullNumber || '',
                sireBullName: calf.sireBullName || '',
                sireBullBreed: calf.sireBullBreed || ''
            });
        } else {
            adultType='bull';
            adult = await Bull.create({
                bullName: calf.calfName || '',
                bullNumber: '',
                race: calf.calfBreed || '',
                dob: calf.birthDate,
                notes: (calf.notes||'') + `\nGraduated from calf on ${now.toLocaleDateString()}`,
                profileImageUrl: calf.profileImageUrl || '',
                motherCowNumber: calf.motherCowNumber || '',
                motherCowName: calf.motherCowName || '',
                motherCowBreed: calf.motherCowBreed || '',
                sireBullNumber: calf.sireBullNumber || '',
                sireBullName: calf.sireBullName || '',
                sireBullBreed: calf.sireBullBreed || ''
            });
        }
        calf.graduated = true; calf.graduatedAt = now; calf.adultType = adultType; calf.adultId = adult._id; await calf.save();
        // Link audit to mother cow if available
        const actor = (forced && overrideActive) ? 'override' : 'user';
        if(calf.motherCowNumber){ const mother = await Cow.findOne({ cowNumber: calf.motherCowNumber }).lean(); if(mother){ await logAudit({ cowId: mother._id, action:'calf.graduate', actor, payload:{ calfId: calf._id, calfName: calf.calfName || '', gender: calf.gender, adultType, adultId: adult._id, forced: !!forced } }); } }
        return res.json({ ok:true, adult: { id:String(adult._id), type: adultType } });
    }catch(err){ console.error('Manual graduation error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Unified profile navigation: previous/next across all cattle sorted by label (name/number) then type
app.get('/profile/nav/:type/:id', async (req,res)=>{
    try {
        const { type, id } = req.params;
        let list = [];
        if (type === 'cow') {
            list = (await Cow.find().lean()).map(c=> ({ id:String(c._id), label:(c.cowName || c.cowNumber || '').trim() || `Cow ${String(c._id).slice(-4)}` }));
        } else if (type === 'bull') {
            // Fetch current bull to determine grouping (herd vs insemination)
            const currentBull = await Bull.findById(id).lean();
            if (!currentBull) return res.status(404).json({ error:'Bull not found' });
            const isInsemination = !!currentBull.isInsemination;
            // Filter bulls based on current bull category. For herd bulls (isInsemination=false) also include legacy documents where field is missing.
            const filter = isInsemination ? { isInsemination: true } : { $or: [ { isInsemination: false }, { isInsemination: { $exists: false } } ] };
            list = (await Bull.find(filter).lean()).map(b=> ({ id:String(b._id), label:(b.bullName || b.bullNumber || '').trim() || `Bull ${String(b._id).slice(-4)}` }));
        } else if (type === 'calf') {
            list = (await Calf.find().lean()).map(k=> ({ id:String(k._id), label:(k.calfName || '').trim() || `Calf ${String(k._id).slice(-4)}` }));
        } else {
            return res.status(400).json({ error:'Invalid type' });
        }
        list.sort((a,b)=>{ const la=a.label.toLowerCase(); const lb=b.label.toLowerCase(); if(la<lb) return -1; if(la>lb) return 1; return 0; });
        const idx = list.findIndex(x=> x.id===id);
        if(idx === -1) return res.status(404).json({ error:'Item not found in navigation list' });
        const prev = idx>0 ? { type, id:list[idx-1].id, label:list[idx-1].label } : null;
        const next = idx<list.length-1 ? { type, id:list[idx+1].id, label:list[idx+1].label } : null;
        return res.json({ previous: prev, next });
    } catch(err){
        console.error('Profile nav error:', err);
        res.status(500).json({ error:'Internal Server Error' });
    }
});

// Lineage endpoints: provide minimal graph of nodes and edges
// Format: { nodes: [ { _id, type, label, number, race, dob, isInsemination? } ], edges: [ { from, to, relation } ] }
app.get('/lineage/calf/:id', async (req,res)=>{
    try{
        const { id } = req.params; if(!mongoose.isValidObjectId(id)) return res.status(400).json({ error:'Invalid calf id' });
        const calf = await Calf.findById(id).lean(); if(!calf) return res.status(404).json({ error:'Calf not found' });
        const nodes=[]; const edges=[]; const byKey=new Map();
        function addNode(doc, type){ if(!doc) return null; const key=String(doc._id); if(byKey.has(key)) return byKey.get(key); const node={ _id:key, type, label: (type==='cow'? (doc.cowName||doc.cowNumber||'Cow') : type==='bull'? (doc.bullName||doc.bullNumber||'Bull') : (doc.calfName||'Calf')), number: (type==='cow'? doc.cowNumber : type==='bull'? doc.bullNumber : ''), race: (type==='cow'? doc.race : type==='bull'? doc.race : doc.calfBreed), dob: (type==='cow'? doc.dob : type==='bull'? doc.dob : doc.birthDate) };
            if(type==='bull' && doc.isInsemination) node.isInsemination=true; nodes.push(node); byKey.set(key,node); return node; }
        function addEdge(fromId,toId,relation){ edges.push({ from:String(fromId), to:String(toId), relation }); }
        const self = addNode(calf,'calf');
        let mother=null, sire=null;
        if(calf.motherCowNumber){ mother = await Cow.findOne({ cowNumber: calf.motherCowNumber }).lean(); }
        if(calf.sireBullNumber){ sire = await Bull.findOne({ bullNumber: calf.sireBullNumber }).lean(); }
        if(mother){ addNode(mother,'cow'); addEdge(mother._id, self._id, 'mother'); }
        if(sire){ addNode(sire,'bull'); addEdge(sire._id, self._id, 'sire'); }
        return res.json({ nodes, edges });
    }catch(err){ console.error('Lineage calf error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

app.get('/lineage/cow/:id', async (req,res)=>{
    try{
        const { id } = req.params; if(!mongoose.isValidObjectId(id)) return res.status(400).json({ error:'Invalid cow id' });
        const cow = await Cow.findById(id).lean(); if(!cow) return res.status(404).json({ error:'Cow not found' });
        const nodes=[]; const edges=[]; const byKey=new Map();
        function addNode(doc, type){ if(!doc) return null; const key=String(doc._id); if(byKey.has(key)) return byKey.get(key); const node={ _id:key, type, label: (type==='cow'? (doc.cowName||doc.cowNumber||'Cow') : type==='bull'? (doc.bullName||doc.bullNumber||'Bull') : (doc.calfName||'Calf')), number: (type==='cow'? doc.cowNumber : type==='bull'? doc.bullNumber : ''), race: (type==='cow'? doc.race : type==='bull'? doc.race : doc.calfBreed), dob: (type==='cow'? doc.dob : type==='bull'? doc.dob : doc.birthDate) };
            if(type==='bull' && doc.isInsemination) node.isInsemination=true; nodes.push(node); byKey.set(key,node); return node; }
        function addEdge(fromId,toId,relation){ edges.push({ from:String(fromId), to:String(toId), relation }); }
        const self = addNode(cow,'cow');
        // Parents of cow
        let mother=null, sire=null;
        if(cow.motherCowNumber){ mother = await Cow.findOne({ cowNumber: cow.motherCowNumber }).lean(); }
        if(cow.sireBullNumber){ sire = await Bull.findOne({ bullNumber: cow.sireBullNumber }).lean(); }
        if(mother){ addNode(mother,'cow'); addEdge(mother._id, self._id, 'mother'); }
        if(sire){ addNode(sire,'bull'); addEdge(sire._id, self._id, 'sire'); }
        // Offspring: calves where this cow is the mother
        const kids = await Calf.find({ motherCowNumber: cow.cowNumber }).lean();
        for(const k of kids){ const kn = addNode(k,'calf'); addEdge(self._id, k._id, 'offspring'); if(k.sireBullNumber){ const kb = await Bull.findOne({ bullNumber: k.sireBullNumber }).lean(); if(kb){ addNode(kb,'bull'); addEdge(kb._id, k._id, 'sire'); } } }
        return res.json({ nodes, edges });
    }catch(err){ console.error('Lineage cow error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Lightweight API for a single cow profile including computed pregnancy state
app.get('/cow-profile', async (req, res) => {
    try {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: 'Missing id' });
        const cow = await Cow.findById(id).lean();
        if (!cow) return res.status(404).json({ error: 'Cow not found' });
        const settings = await Settings.findOne().lean();
        const records = await Insemination.find({ cowId: id }).sort({ date: -1 }).lean();
        const repro = buildPregnancyInfo(cow, settings, records);
        res.json({ cow, reproduction: repro, override: !!req.session.cowOverride });
    } catch (err) {
        console.error('Error generating cow profile:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Override login/logout routes
// Override status & login helpers
app.get('/override/status', (req,res)=>{
    return res.json({ override: !!req.session.cowOverride });
});
app.post('/override/login', (req, res) => {
    const { password } = req.body;
    const expected = process.env.COW_OVERRIDE_PASSWORD || 'override123';

    if (!password) {
        console.warn('[override] Empty password attempt');
        return res.status(400).json({ error: 'Password required' });
    }

    console.log('[override] Received login attempt');

    if (password === expected) {
        req.session.cowOverride = true;
        console.log('[override] Login success');
        return res.json({ ok: true, override: true });
    }

    console.warn('[override] Invalid password attempt');
    return res.status(401).json({ error: 'Invalid password', override: false });
});

app.post('/override/logout', (req,res)=>{
    req.session.cowOverride = false;
    console.log('[override] Logged out');
    return res.json({ ok:true, override:false });
});

// Create new insemination attempt for a cow
app.post('/cow/:id/insemination', async (req,res)=>{
    try {
        const { id } = req.params; const { date, notes, forced } = req.body;
        if (forced && !req.session.cowOverride) return res.status(403).json({ error:'Override required for forced attempt' });
        if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: 'Invalid cow id' });
        const [cow, settings] = await Promise.all([
            Cow.findById(id).lean(),
            Settings.findOne().lean(),
        ]);
        if(!cow) return res.status(404).json({ error:'Cow not found' });
        const d = date ? new Date(date) : new Date();
        if (isNaN(d.getTime())) return res.status(400).json({ error:'Invalid date' });
        const postpartumStartDays = settings?.postpartumInseminationStartDays || 60;
        if (!forced && cow.lastCalving){
            const earliest = new Date(cow.lastCalving); earliest.setDate(earliest.getDate() + postpartumStartDays);
            if (d < earliest) return res.status(400).json({ error:'Too early after last calving', code:'postpartum_window', earliest });
        }
        const attempt = await Insemination.create({ cowId: id, date: d, confirmedPregnant: false, notes: notes||'', forced: !!forced });
        await logAudit({ cowId:id, inseminationId: attempt._id, action: forced? 'insemination.forced':'insemination.add', actor: (forced && req.session.cowOverride)? 'override':'user', payload:{ date:d, notes: notes||'' } });
        res.status(201).json(attempt);
    } catch(err){ console.error('Add insemination error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Update notes (override required)
app.post('/cow/:id/insemination/:inseminationId/notes', async (req,res)=>{
// Disabled auto-graduation; graduation is manual via UI
});

// Confirm pregnancy on an existing insemination attempt
app.post('/cow/:id/insemination/:inseminationId/confirm', async (req,res)=>{
    try {
        const { id, inseminationId } = req.params; const settings = await Settings.findOne().lean();
        if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(inseminationId)) return res.status(400).json({ error:'Invalid id format' });
        const doc = await Insemination.findOne({ _id: inseminationId, cowId: id }).lean();
        if(!doc) return res.status(404).json({ error:'Insemination attempt not found' });
        const interval = settings?.inseminationIntervalDays || 90; const checkDate = new Date(doc.date); checkDate.setDate(checkDate.getDate()+interval);
        if (new Date() < checkDate && !req.session.cowOverride) return res.status(403).json({ error:'Override required until pregnancy check date' });
        const attempt = await Insemination.findOneAndUpdate({ _id: inseminationId, cowId: id }, { confirmedPregnant: true, failed: false }, { new:true }).lean();
        await logAudit({ cowId:id, inseminationId, action:'insemination.confirm', actor: req.session.cowOverride? 'override':'user', payload:{ date: attempt.date } });
        res.json(attempt);
    } catch(err){ console.error('Confirm insemination error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Undo pregnancy confirmation (revert to pending status)
app.post('/cow/:id/insemination/:inseminationId/unconfirm', async (req,res)=>{
    try {
        const { id, inseminationId } = req.params; const settings = await Settings.findOne().lean();
        if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(inseminationId)) return res.status(400).json({ error:'Invalid id format' });
        const doc = await Insemination.findOne({ _id: inseminationId, cowId: id }).lean();
        if(!doc) return res.status(404).json({ error:'Insemination attempt not found' });
        const interval = settings?.inseminationIntervalDays || 90; const checkDate = new Date(doc.date); checkDate.setDate(checkDate.getDate()+interval);
        if (new Date() < checkDate && !req.session.cowOverride) return res.status(403).json({ error:'Override required until pregnancy check date' });
        const attempt = await Insemination.findOneAndUpdate({ _id: inseminationId, cowId: id }, { confirmedPregnant: false, failed: false }, { new:true }).lean();
        await logAudit({ cowId:id, inseminationId, action:'insemination.unconfirm', actor: req.session.cowOverride? 'override':'user', payload:{ date: attempt.date } });
        res.json(attempt);
    } catch(err){ console.error('Unconfirm insemination error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Mark insemination attempt as failed (not pregnant after evaluation window)
app.post('/cow/:id/insemination/:inseminationId/fail', async (req,res)=>{
    try {
        const { id, inseminationId } = req.params; const settings = await Settings.findOne().lean();
        if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(inseminationId)) return res.status(400).json({ error:'Invalid id format' });
        const doc = await Insemination.findOne({ _id: inseminationId, cowId: id }).lean();
        if(!doc) return res.status(404).json({ error:'Insemination attempt not found' });
        const interval = settings?.inseminationIntervalDays || 90; const checkDate = new Date(doc.date); checkDate.setDate(checkDate.getDate()+interval);
        if (new Date() < checkDate && !req.session.cowOverride) return res.status(403).json({ error:'Override required until pregnancy check date' });
        const attempt = await Insemination.findOneAndUpdate({ _id: inseminationId, cowId: id }, { failed: true, confirmedPregnant: false }, { new:true }).lean();
        await logAudit({ cowId:id, inseminationId, action:'insemination.fail', actor: req.session.cowOverride? 'override':'user', payload:{ date: attempt.date } });
        res.json(attempt);
    } catch(err){ console.error('Fail insemination error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Record actual calving date (sets cow.lastCalving) ending the pregnancy cycle
app.post('/cow/:id/calving', async (req,res)=>{
    try {
        if(!req.session.cowOverride) return res.status(403).json({ error:'Override required' });
        const { id } = req.params; const { date, birthDate, notes, calfName, calfBreed, gender, status, motherCowNumber, sireBullNumber, calfGeneralNotes } = req.body;
        if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error:'Invalid cow id' });
        const d = date ? new Date(date) : new Date();
        if (isNaN(d.getTime())) return res.status(400).json({ error:'Invalid date' });
        const prev = await Cow.findById(id).lean();
        const updated = await Cow.findByIdAndUpdate(id, { lastCalving: d }, { new:true }).lean();
        if(!updated) return res.status(404).json({ error:'Cow not found' });
        // Create calf profile from birth data if gender is provided
        let calf = null;
        if(gender && ['male','female'].includes(String(gender).toLowerCase())){
            // If explicit birthDate provided, use it; else default to calving date
            let bd = d;
            if (birthDate) { const bdTry = new Date(birthDate); if(!isNaN(bdTry.getTime())) bd = bdTry; }
            const calfDoc = {
                calfName: calfName || 'Unnamed Calf',
                calfBreed: calfBreed || (updated.race || 'Unknown'),
                birthDate: bd,
                gender: String(gender).toLowerCase(),
                status: status && ['alive','miscarriage','died'].includes(String(status)) ? String(status) : 'alive',
                notes: notes || '',
                profileImageUrl: '',
                motherCowNumber: updated.cowNumber || '',
                motherCowName: updated.cowName || '',
                motherCowBreed: updated.race || '',
                sireBullNumber: '',
                sireBullName: '',
                sireBullBreed: ''
            };
            // Override mother if a number was passed
            if (motherCowNumber){
                const m = await Cow.findOne({ cowNumber: motherCowNumber }).lean();
                if (m){ calfDoc.motherCowNumber = m.cowNumber || calfDoc.motherCowNumber; calfDoc.motherCowName = m.cowName || calfDoc.motherCowName; calfDoc.motherCowBreed = m.race || calfDoc.motherCowBreed; }
                else { calfDoc.motherCowNumber = motherCowNumber; }
            }
            // Sire by number if provided
            if (sireBullNumber){
                const b = await Bull.findOne({ bullNumber: sireBullNumber }).lean();
                if (b){ calfDoc.sireBullNumber = b.bullNumber || ''; calfDoc.sireBullName = b.bullName || ''; calfDoc.sireBullBreed = b.race || ''; }
                else { calfDoc.sireBullNumber = sireBullNumber; }
            }
            calf = await Calf.create(calfDoc);
            // If separate general calf notes provided, append to calf.notes with delimiter
            if (calfGeneralNotes){
                const merged = [calf.notes || '', calfGeneralNotes].filter(Boolean).join('\n');
                calf = await Calf.findByIdAndUpdate(calf._id, { notes: merged }, { new:true }).lean();
            }
        }
        const audit = await Audit.create({ cowId:id, action:'cow.calving.set', actor:'override', payload:{ from: prev?.lastCalving || null, to: d, notes: notes||'', calfId: calf? calf._id : null } });
        res.json({ cow: updated, auditId: audit._id, calf: calf });
    } catch(err){ console.error('Calving record error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Create calf (general creation form with auto-fill by numbers)
app.post('/calf', async (req,res)=>{
    try{
        const { calfName, calfBreed, birthDate, gender, notes, motherCowNumber, sireBullNumber, status } = req.body;
        if(!calfName || !calfBreed || !birthDate || !gender){ return res.status(400).json({ error:'Missing required fields', required:['calfName','calfBreed','birthDate','gender'] }); }
        const d = new Date(birthDate); if(isNaN(d.getTime())) return res.status(400).json({ error:'Invalid birthDate' });
        const doc = { calfName, calfBreed, birthDate:d, gender:String(gender).toLowerCase(), status: status && ['alive','miscarriage','died'].includes(String(status)) ? String(status) : 'alive', notes: notes||'' };
        if(motherCowNumber){ const m = await Cow.findOne({ cowNumber: motherCowNumber }).lean(); if(m){ doc.motherCowNumber = m.cowNumber||''; doc.motherCowName=m.cowName||''; doc.motherCowBreed=m.race||''; } else { doc.motherCowNumber = motherCowNumber; } }
        if(sireBullNumber){ const b = await Bull.findOne({ bullNumber: sireBullNumber }).lean(); if(b){ doc.sireBullNumber=b.bullNumber||''; doc.sireBullName=b.bullName||''; doc.sireBullBreed=b.race||''; } else { doc.sireBullNumber = sireBullNumber; } }
        const calf = await Calf.create(doc);
        res.json({ ok:true, calf });
    } catch(err){ console.error('Create calf error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Lookup endpoints for auto-fill
app.get('/lookup/cow/:number', async (req,res)=>{
    try{ const m = await Cow.findOne({ cowNumber: req.params.number }).lean(); if(!m) return res.status(404).json({ error:'Cow not found' }); res.json({ cow:m }); }catch(err){ res.status(500).json({ error:'Internal Server Error' }); }
});
app.get('/lookup/bull/:number', async (req,res)=>{
    try{ const b = await Bull.findOne({ bullNumber: req.params.number }).lean(); if(!b) return res.status(404).json({ error:'Bull not found' }); res.json({ bull:b }); }catch(err){ res.status(500).json({ error:'Internal Server Error' }); }
});

// Clear calving date (admin action)
app.delete('/cow/:id/calving', async (req,res)=>{
    try {
        if(!req.session.cowOverride) return res.status(403).json({ error:'Override required' });
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error:'Invalid cow id' });
        const prev = await Cow.findById(id).lean();
        const updated = await Cow.findByIdAndUpdate(id, { $unset: { lastCalving: 1 } }, { new:true }).lean();
        if(!updated) return res.status(404).json({ error:'Cow not found' });
        const audit = await Audit.create({ cowId:id, action:'cow.calving.clear', actor:'override', payload:{ from: prev?.lastCalving || null } });
        res.json({ cow: updated, auditId: audit._id });
    } catch(err){ console.error('Clear calving date error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Delete an insemination attempt (admin action)
app.delete('/cow/:id/insemination/:inseminationId', async (req,res)=>{
    try {
        if(!req.session.cowOverride) return res.status(403).json({ error:'Override required' });
        const { id, inseminationId } = req.params;
        if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(inseminationId)) return res.status(400).json({ error:'Invalid id format' });
        // Ensure we only ever delete the latest attempt for safety/history retention
        const latest = await Insemination.findOne({ cowId:id }).sort({ date:-1, _id:-1 }).lean();
        if(!latest) return res.status(404).json({ error:'No attempts recorded' });
        if(String(latest._id) !== String(inseminationId)) return res.status(400).json({ error:'Only latest attempt may be deleted' });
        const attempt = await Insemination.findOneAndDelete({ _id: latest._id, cowId: id }).lean();
        if(!attempt) return res.status(404).json({ error:'Insemination attempt not found' });
        await logAudit({ cowId:id, inseminationId: attempt._id, action:'insemination.delete', actor:'override', payload:{ snapshot: attempt } });
        res.json({ ok: true, deletedId: attempt._id });
    } catch(err){ console.error('Delete insemination error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Clear all insemination attempts for a cow (admin action)
app.delete('/cow/:id/inseminations', async (req,res)=>{
    try{
        if(!req.session.cowOverride) return res.status(403).json({ error:'Override required' });
        const { id } = req.params;
        if(!mongoose.isValidObjectId(id)) return res.status(400).json({ error:'Invalid cow id' });
        const attempts = await Insemination.find({ cowId:id }).lean();
        if(!attempts.length) return res.json({ ok:true, deleted:0 });
        const ids = attempts.map(a=> a._id);
        await Insemination.deleteMany({ cowId:id });
        const audit = await Audit.create({ cowId:id, action:'insemination.clearAll', actor:'override', payload:{ count: attempts.length, ids, snapshots: attempts } });
        res.json({ ok:true, deleted: attempts.length, auditId: audit._id });
    }catch(err){ console.error('Clear all inseminations error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Audit endpoints
app.get('/cow/:id/audit', async (req,res)=>{
    try{
        const { id } = req.params; if(!mongoose.isValidObjectId(id)) return res.status(400).json({ error:'Invalid cow id' });
        const items = await Audit.find({ cowId:id }).sort({ createdAt:-1 }).limit(50).lean();
        res.json({ items });
    } catch(err){ console.error('Audit list error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

app.post('/cow/:id/insemination/restore/:auditId', async (req,res)=>{
    try{
        if(!req.session.cowOverride) return res.status(403).json({ error:'Override required' });
        const { id, auditId } = req.params;
        if(!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(auditId)) return res.status(400).json({ error:'Invalid id' });
        const a = await Audit.findById(auditId).lean(); if(!a || a.action!=='insemination.delete' || !a.payload || !a.payload.snapshot) return res.status(404).json({ error:'Restore snapshot not found' });
        const snap = a.payload.snapshot;
        const restored = await Insemination.create({ cowId:id, date:snap.date, confirmedPregnant: !!snap.confirmedPregnant, failed: !!snap.failed, forced: !!snap.forced, notes: snap.notes||'' });
        await logAudit({ cowId:id, inseminationId: restored._id, action:'insemination.restore', actor:'override', payload:{ fromAudit:a._id } });
        res.json({ ok:true, attempt: restored });
    } catch(err){ console.error('Restore insemination error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Restore calving state from audit (undo set/clear)
app.post('/cow/:id/calving/restore/:auditId', async (req,res)=>{
    try{
        if(!req.session.cowOverride) return res.status(403).json({ error:'Override required' });
        const { id, auditId } = req.params;
        if(!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(auditId)) return res.status(400).json({ error:'Invalid id' });
        const a = await Audit.findById(auditId).lean();
        if(!a || !['cow.calving.set','cow.calving.clear'].includes(a.action) || !a.payload) return res.status(404).json({ error:'Calving audit not found' });
        const prev = a.payload.from || null;
        let updated;
        if(prev){ updated = await Cow.findByIdAndUpdate(id, { lastCalving: new Date(prev) }, { new:true }).lean(); }
        else { updated = await Cow.findByIdAndUpdate(id, { $unset: { lastCalving: 1 } }, { new:true }).lean(); }
        await logAudit({ cowId:id, action:'cow.calving.restore', actor:'override', payload:{ fromAudit:a._id } });
        res.json({ ok:true, cow: updated });
    } catch(err){ console.error('Restore calving error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Restore all inseminations from clearAll audit
app.post('/cow/:id/inseminations/restore/:auditId', async (req,res)=>{
    try{
        if(!req.session.cowOverride) return res.status(403).json({ error:'Override required' });
        const { id, auditId } = req.params;
        if(!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(auditId)) return res.status(400).json({ error:'Invalid id' });
        const a = await Audit.findById(auditId).lean();
        if(!a || a.action!=='insemination.clearAll' || !a.payload || !Array.isArray(a.payload.snapshots)) return res.status(404).json({ error:'Restore snapshots not found' });
        const snaps = a.payload.snapshots;
        if(!snaps.length) return res.json({ ok:true, restored:0, total:0, missing:0 });
        const existing = await Insemination.find({ cowId:id }).lean();
        const existingByKey = new Set(existing.map(e=> new Date(e.date).toISOString().slice(0,10)+'|'+(e.notes||''))); // match on date+notes
        const toCreate = snaps.filter(s=>{
            const key = new Date(s.date).toISOString().slice(0,10)+'|'+(s.notes||'');
            return !existingByKey.has(key);
        }).map(s=> ({ cowId:id, date:s.date, confirmedPregnant: !!s.confirmedPregnant, failed: !!s.failed, forced: !!s.forced, notes: s.notes||'' }));
        let created = [];
        if(toCreate.length){ created = await Insemination.insertMany(toCreate); }
        await logAudit({ cowId:id, action:'insemination.restoreAll', actor:'override', payload:{ fromAudit:a._id, createdCount: created.length } });
        res.json({ ok:true, restored: created.length, total: snaps.length, missing: Math.max(0, snaps.length - (existing.length + created.length)) });
    } catch(err){ console.error('Restore all inseminations error:', err); res.status(500).json({ error:'Internal Server Error' }); }
});

// Lineage API: return parents and offspring for cows/bulls; parents for calves
app.get('/lineage/:type/:id', async (req, res) => {
    try{
        const { type, id } = req.params;
        const nodes = [];
        const nodeMap = new Map();
        const edges = [];
        const edgeSet = new Set(); // dedupe
        const keyOf = (t, _id) => `${t}:${String(_id)}`;
        const pushNode = (doc, t) => {
            if (!doc) return null;
            const k = keyOf(t, doc._id);
            if (nodeMap.has(k)) return nodeMap.get(k);
            const n = {
                _id: String(doc._id || ''),
                type: t,
                name: t === 'cow' ? (doc.cowName || '') : t === 'bull' ? (doc.bullName || '') : (doc.calfName || ''),
                number: t === 'cow' ? (doc.cowNumber || '') : t === 'bull' ? (doc.bullNumber || '') : '',
                race: t === 'cow' ? (doc.race || '') : t === 'bull' ? (doc.race || '') : (doc.calfBreed || ''),
                dob: t === 'cow' ? (doc.dob || null) : t === 'bull' ? (doc.dob || null) : (doc.birthDate || null),
                profileImageUrl: doc.profileImageUrl || null,
                isInsemination: t === 'bull' ? !!doc.isInsemination : false,
            };
            n.label = n.name || n.number || (t.charAt(0).toUpperCase() + t.slice(1));
            nodeMap.set(k, n);
            nodes.push(n);
            return n;
        };
        const addEdge = (from, to, relation) => {
            if (!from || !to) return;
            const e = { from: String(from._id), to: String(to._id), relation };
            const k = `${e.from}|${e.to}|${e.relation}`;
            if (edgeSet.has(k)) return;
            edgeSet.add(k);
            edges.push(e);
        };
        const findByNumber = async (t, num) => {
            if (!num) return null;
            if (t === 'cow') return await Cow.findOne({ cowNumber: num }).lean();
            if (t === 'bull') return await Bull.findOne({ bullNumber: num }).lean();
            return null;
        };
        const getParents = async (doc, t) => {
            if (!doc) return [];
            if (t === 'cow' || t === 'calf'){
                const [mDoc, sDoc] = await Promise.all([
                    doc.motherCowNumber ? Cow.findOne({ cowNumber: doc.motherCowNumber }).lean() : null,
                    doc.sireBullNumber ? Bull.findOne({ bullNumber: doc.sireBullNumber }).lean() : null,
                ]);
                return [mDoc?{doc:mDoc, t:'cow', rel:'mother'}:null, sDoc?{doc:sDoc, t:'bull', rel:'sire'}:null].filter(Boolean);
            } else if (t === 'bull'){
                const [mDoc, sDoc] = await Promise.all([
                    doc.motherCowNumber ? Cow.findOne({ cowNumber: doc.motherCowNumber }).lean() : null,
                    doc.sireBullNumber ? Bull.findOne({ bullNumber: doc.sireBullNumber }).lean() : null,
                ]);
                return [mDoc?{doc:mDoc, t:'cow', rel:'mother'}:null, sDoc?{doc:sDoc, t:'bull', rel:'sire'}:null].filter(Boolean);
            }
            return [];
        };
        const getChildren = async (doc, t) => {
            if (!doc) return [];
            if (t === 'cow'){
                const [calves, cows, bulls] = await Promise.all([
                    Calf.find({ motherCowNumber: doc.cowNumber }).lean(),
                    Cow.find({ motherCowNumber: doc.cowNumber }).lean(),
                    Bull.find({ motherCowNumber: doc.cowNumber }).lean(),
                ]);
                return [
                    ...calves.map(d=>({doc:d, t:'calf', rel:'offspring'})),
                    ...cows.map(d=>({doc:d, t:'cow', rel:'offspring'})),
                    ...bulls.map(d=>({doc:d, t:'bull', rel:'offspring'})),
                ];
            } else if (t === 'bull'){
                const [calves, cows, bulls] = await Promise.all([
                    Calf.find({ sireBullNumber: doc.bullNumber }).lean(),
                    Cow.find({ sireBullNumber: doc.bullNumber }).lean(),
                    Bull.find({ sireBullNumber: doc.bullNumber }).lean(),
                ]);
                return [
                    ...calves.map(d=>({doc:d, t:'calf', rel:'offspring'})),
                    ...cows.map(d=>({doc:d, t:'cow', rel:'offspring'})),
                    ...bulls.map(d=>({doc:d, t:'bull', rel:'offspring'})),
                ];
            }
            return [];
        };

        // Seed self node
        let rootDoc=null, rootType=null;
        if (type === 'cow') { rootDoc = await Cow.findById(id).lean(); rootType='cow'; }
        else if (type === 'bull') { rootDoc = await Bull.findById(id).lean(); rootType='bull'; }
        else if (type === 'calf') { rootDoc = await Calf.findById(id).lean(); rootType='calf'; }
        else return res.status(400).json({ error:'Invalid type' });
        if(!rootDoc) return res.status(404).json({ error: `${type} not found` });
        const self = pushNode(rootDoc, rootType);

        // Ancestors BFS up to 10 generations
        const maxGen = 10;
        let current = [{ node:self }];
        for (let depth=1; depth<=maxGen; depth++){
            const next=[];
            for (const item of current){
                const n = nodeMap.get(keyOf(item.node.type, item.node._id)) || item.node; // front node object
                // fetch original doc by id based on type
                let doc=null;
                if (n.type==='cow') doc = await Cow.findById(n._id).lean();
                else if (n.type==='bull') doc = await Bull.findById(n._id).lean();
                else if (n.type==='calf') doc = await Calf.findById(n._id).lean();
                const parents = await getParents(doc, n.type);
                for (const p of parents){
                    const pn = pushNode(p.doc, p.t);
                    if (pn){
                        addEdge(pn, n, p.rel);
                        next.push({ node: pn });
                    }
                }
            }
            if (!next.length) break;
            current = next;
        }

        // Descendants BFS up to 10 generations
        current = [{ node:self }];
        for (let depth=1; depth<=maxGen; depth++){
            const next=[];
            for (const item of current){
                const n = nodeMap.get(keyOf(item.node.type, item.node._id)) || item.node;
                let doc=null;
                if (n.type==='cow') doc = await Cow.findById(n._id).lean();
                else if (n.type==='bull') doc = await Bull.findById(n._id).lean();
                else if (n.type==='calf') doc = await Calf.findById(n._id).lean();
                const kids = await getChildren(doc, n.type);
                for (const k of kids){
                    const kn = pushNode(k.doc, k.t);
                    if (kn){
                        addEdge(n, kn, 'offspring');
                        // also add explicit parent edge for grouping when possible
                        if (n.type==='cow') addEdge(n, kn, 'mother');
                        if (n.type==='bull') addEdge(n, kn, 'sire');
                        next.push({ node: kn });
                    }
                }
            }
            if (!next.length) break;
            current = next;
        }

        // Siblings for self (both maternal and paternal)
        if (rootType==='cow' || rootType==='calf'){
            const mNum = rootDoc.motherCowNumber; const sNum = rootDoc.sireBullNumber;
            const [mother, sire] = await Promise.all([
                mNum ? Cow.findOne({ cowNumber: mNum }).lean() : null,
                sNum ? Bull.findOne({ bullNumber: sNum }).lean() : null,
            ]);
            const mNode = pushNode(mother, 'cow'); const sNode = pushNode(sire, 'bull');
            if (mNode){
                addEdge(mNode, self, 'mother');
                const [c1,c2,c3] = await Promise.all([
                    Calf.find({ motherCowNumber: mNum }).lean(),
                    Cow.find({ motherCowNumber: mNum }).lean(),
                    Bull.find({ motherCowNumber: mNum }).lean(),
                ]);
                [...c1,...c2,...c3].forEach(d=>{ const sn = d.birthDate!==undefined? pushNode(d,'calf') : (d.bullNumber!==undefined? pushNode(d,'bull'):pushNode(d,'cow')); if (sn){ addEdge(mNode, sn, 'mother'); }});
            }
            if (sNode){
                addEdge(sNode, self, 'sire');
                const [c1,c2,c3] = await Promise.all([
                    Calf.find({ sireBullNumber: sNum }).lean(),
                    Cow.find({ sireBullNumber: sNum }).lean(),
                    Bull.find({ sireBullNumber: sNum }).lean(),
                ]);
                [...c1,...c2,...c3].forEach(d=>{ const sn = d.birthDate!==undefined? pushNode(d,'calf') : (d.bullNumber!==undefined? pushNode(d,'bull'):pushNode(d,'cow')); if (sn){ addEdge(sNode, sn, 'sire'); }});
            }
        } else if (rootType==='bull'){
            const mNum = rootDoc.motherCowNumber; const sNum = rootDoc.sireBullNumber;
            const [mother, sire] = await Promise.all([
                mNum ? Cow.findOne({ cowNumber: mNum }).lean() : null,
                sNum ? Bull.findOne({ bullNumber: sNum }).lean() : null,
            ]);
            const mNode = pushNode(mother, 'cow'); const sNode = pushNode(sire, 'bull');
            if (mNode){
                addEdge(mNode, self, 'mother');
                const [c1,c2,c3] = await Promise.all([
                    Calf.find({ motherCowNumber: mNum }).lean(),
                    Cow.find({ motherCowNumber: mNum }).lean(),
                    Bull.find({ motherCowNumber: mNum }).lean(),
                ]);
                [...c1,...c2,...c3].forEach(d=>{ const sn = d.birthDate!==undefined? pushNode(d,'calf') : (d.bullNumber!==undefined? pushNode(d,'bull'):pushNode(d,'cow')); if (sn){ addEdge(mNode, sn, 'mother'); }});
            }
            if (sNode){
                addEdge(sNode, self, 'sire');
                const [c1,c2,c3] = await Promise.all([
                    Calf.find({ sireBullNumber: sNum }).lean(),
                    Cow.find({ sireBullNumber: sNum }).lean(),
                    Bull.find({ sireBullNumber: sNum }).lean(),
                ]);
                [...c1,...c2,...c3].forEach(d=>{ const sn = d.birthDate!==undefined? pushNode(d,'calf') : (d.bullNumber!==undefined? pushNode(d,'bull'):pushNode(d,'cow')); if (sn){ addEdge(sNode, sn, 'sire'); }});
            }
        }

        return res.json({ nodes, edges });
    } catch(err){
        console.error('Lineage error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Route to add cattle
app.post('/add-cattle', async (req, res) => {
    try {
        const { type } = req.body;

        if (!type) {
            return res.status(400).json({ error: 'Cattle type is required' });
        }

        // Helpers for cross-collection uniqueness
        const escapeRegExp = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const nameTaken = async (name) => {
            if (!name) return false;
            const rx = new RegExp('^' + escapeRegExp(name) + '$', 'i');
            const [c1, c2, c3] = await Promise.all([
                Cow.findOne({ cowName: rx }).lean(),
                Calf.findOne({ calfName: rx }).lean(),
                Bull.findOne({ bullName: rx }).lean(),
            ]);
            return !!(c1 || c2 || c3);
        };
        const numberTaken = async (num) => {
            if (!num) return false;
            const rx = new RegExp('^' + escapeRegExp(num) + '$', 'i');
            const [c, b] = await Promise.all([
                Cow.findOne({ cowNumber: rx }).lean(),
                Bull.findOne({ bullNumber: rx }).lean(),
            ]);
            return !!(c || b);
        };

        let newEntry;

        // Helper to auto-populate parent info from numbers
        async function enrichFromNumbers(entry){
            // Mother (cow)
            if (entry.motherCowNumber && (!entry.motherCowName || !entry.motherCowBreed)){
                const mc = await Cow.findOne({ cowNumber: entry.motherCowNumber }).lean();
                if (mc){
                    entry.motherCowName = mc.cowName || entry.motherCowName;
                    entry.motherCowBreed = mc.race || entry.motherCowBreed;
                }
            }
            // Sire (bull)
            if (entry.sireBullNumber && (!entry.sireBullName || !entry.sireBullBreed)){
                const sb = await Bull.findOne({ bullNumber: entry.sireBullNumber }).lean();
                if (sb){
                    entry.sireBullName = sb.bullName || entry.sireBullName;
                    entry.sireBullBreed = sb.race || entry.sireBullBreed;
                }
            }
        }

        // Validate parent references by type
        async function validateParentLinks(payload){
            if (payload.motherCowNumber){
                const mc = await Cow.findOne({ cowNumber: payload.motherCowNumber }).lean();
                if (!mc) return `Mother cow number ${payload.motherCowNumber} not found`;
            }
            if (payload.sireBullNumber){
                const sb = await Bull.findOne({ bullNumber: payload.sireBullNumber }).lean();
                if (!sb) return `Sire bull number ${payload.sireBullNumber} not found`;
            }
            return null;
        }

        if (type === 'cow') {
            // Cross-collection uniqueness checks
            if (await numberTaken(req.body.registeringNumber)) {
                return res.status(409).json({ error: 'Number already in use by another animal' });
            }
            if (await nameTaken(req.body.registeringName)) {
                return res.status(409).json({ error: 'Name already in use by another animal' });
            }
            const parentError = await validateParentLinks(req.body);
            if (parentError) return res.status(400).json({ error: parentError });
            newEntry = new Cow({
                cowNumber: req.body.registeringNumber,
                cowName: req.body.registeringName,
                race: req.body.registeringRace,
                dob: req.body.dob,
                lastCalving: req.body.lastCalving,
                notes: req.body.notes,
                motherCowNumber: req.body.motherCowNumber,
                motherCowName: req.body.motherCowName,
                motherCowBreed: req.body.motherCowBreed,
                sireBullNumber: req.body.sireBullNumber,
                sireBullName: req.body.sireBullName,
                sireBullBreed: req.body.sireBullBreed,
            });
            await enrichFromNumbers(newEntry);
        } else if (type === 'calf') {
            // Validate gender
            const gender = req.body.gender;
            if (!['male','female'].includes(gender)) {
                return res.status(400).json({ error: 'Calf gender must be male or female' });
            }
            if (await nameTaken(req.body.calfName)) {
                return res.status(409).json({ error: 'Name already in use by another animal' });
            }
            const parentError = await validateParentLinks(req.body);
            if (parentError) return res.status(400).json({ error: parentError });
            newEntry = new Calf({
                calfName: req.body.calfName,
                calfBreed: req.body.calfBreed,
                birthDate: req.body.birthDate,
                gender,
                notes: req.body.notes,
                motherCowNumber: req.body.motherCowNumber,
                motherCowName: req.body.motherCowName,
                motherCowBreed: req.body.motherCowBreed,
                sireBullNumber: req.body.sireBullNumber,
                sireBullName: req.body.sireBullName,
                sireBullBreed: req.body.sireBullBreed,
            });
            await enrichFromNumbers(newEntry);
        } else if (type === 'bull') {
            if (await numberTaken(req.body.registeringNumber)) {
                return res.status(409).json({ error: 'Number already in use by another animal' });
            }
            if (await nameTaken(req.body.registeringName)) {
                return res.status(409).json({ error: 'Name already in use by another animal' });
            }
            const isInsemination = String(req.body.isInsemination || '').toLowerCase() === 'true' || req.body.isInsemination === true;
            const bullPayload = {
                bullNumber: req.body.registeringNumber,
                bullName: req.body.registeringName,
                race: req.body.registeringRace,
                dob: req.body.dob,
                notes: req.body.notes,
                isInsemination,
            };
            if (!isInsemination){
                const parentError = await validateParentLinks(req.body);
                if (parentError) return res.status(400).json({ error: parentError });
                bullPayload.motherCowNumber = req.body.motherCowNumber;
                bullPayload.motherCowName = req.body.motherCowName;
                bullPayload.motherCowBreed = req.body.motherCowBreed;
                bullPayload.sireBullNumber = req.body.sireBullNumber;
                bullPayload.sireBullName = req.body.sireBullName;
                bullPayload.sireBullBreed = req.body.sireBullBreed;
            }
            newEntry = new Bull(bullPayload);
            if (!isInsemination) await enrichFromNumbers(newEntry);
        } else {
            return res.status(400).json({ error: 'Invalid cattle type' });
        }

        await newEntry.save();
        res.status(201).json(newEntry); // Return the saved entry
    } catch (err) {
        console.error('Error adding cattle:', err);
        res.status(500).json({ error: 'An error occurred while adding cattle' });
    }
});

// Add routes for editing and deleting entries
app.post('/edit-cattle', async (req, res) => {
    try {
        const { id, type, updates } = req.body;

        if (!id || !type || !updates) {
            return res.status(400).send('Invalid request');
        }

        // Helpers
        const escapeRegExp = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const nameTakenExcept = async (name, excludeId) => {
            if (!name) return false;
            const rx = new RegExp('^' + escapeRegExp(name) + '$', 'i');
            const [c1, c2, c3] = await Promise.all([
                Cow.findOne({ cowName: rx }).lean(),
                Calf.findOne({ calfName: rx }).lean(),
                Bull.findOne({ bullName: rx }).lean(),
            ]);
            const found = c1 || c2 || c3;
            return found && String(found._id) !== String(excludeId);
        };
        const numberTakenExcept = async (num, excludeId) => {
            if (!num) return false;
            const rx = new RegExp('^' + escapeRegExp(num) + '$', 'i');
            const [c, b] = await Promise.all([
                Cow.findOne({ cowNumber: rx }).lean(),
                Bull.findOne({ bullNumber: rx }).lean(),
            ]);
            const found = c || b;
            return found && String(found._id) !== String(excludeId);
        };

        let model;
        let mapped = {};
        if (type === 'cow') {
            model = Cow;
            if (Object.prototype.hasOwnProperty.call(updates, 'registeringNumber')) {
                if (await numberTakenExcept(updates.registeringNumber, id)) {
                    return res.status(409).send('Number already in use by another animal');
                }
                mapped.cowNumber = updates.registeringNumber;
            }
            if (Object.prototype.hasOwnProperty.call(updates, 'registeringName')) {
                if (await nameTakenExcept(updates.registeringName, id)) {
                    return res.status(409).send('Name already in use by another animal');
                }
                mapped.cowName = updates.registeringName;
            }
            if (Object.prototype.hasOwnProperty.call(updates, 'registeringRace')) mapped.race = updates.registeringRace;
            ['dob','lastCalving','notes','motherCowNumber','motherCowName','motherCowBreed','sireBullNumber','sireBullName','sireBullBreed'].forEach(k=>{
                if (Object.prototype.hasOwnProperty.call(updates, k)) mapped[k] = updates[k];
            });
        } else if (type === 'calf') {
            model = Calf;
            if (Object.prototype.hasOwnProperty.call(updates, 'calfName')) {
                if (await nameTakenExcept(updates.calfName, id)) {
                    return res.status(409).send('Name already in use by another animal');
                }
            }
            // pass through for calves (field names already match)
            mapped = { ...updates };
        } else if (type === 'bull') {
            model = Bull;
            if (Object.prototype.hasOwnProperty.call(updates, 'registeringNumber')) {
                if (await numberTakenExcept(updates.registeringNumber, id)) {
                    return res.status(409).send('Number already in use by another animal');
                }
                mapped.bullNumber = updates.registeringNumber;
            }
            if (Object.prototype.hasOwnProperty.call(updates, 'registeringName')) {
                if (await nameTakenExcept(updates.registeringName, id)) {
                    return res.status(409).send('Name already in use by another animal');
                }
                mapped.bullName = updates.registeringName;
            }
            if (Object.prototype.hasOwnProperty.call(updates, 'registeringRace')) mapped.race = updates.registeringRace;
            if (Object.prototype.hasOwnProperty.call(updates, 'isInsemination')) {
                mapped.isInsemination = (String(updates.isInsemination).toLowerCase() === 'true' || updates.isInsemination === true);
                // If converting to insemination, strip parent references
                if (mapped.isInsemination) {
                    mapped.motherCowNumber = '';
                    mapped.motherCowName = '';
                    mapped.motherCowBreed = '';
                    mapped.sireBullNumber = '';
                    mapped.sireBullName = '';
                    mapped.sireBullBreed = '';
                }
            }
            ['dob','notes','motherCowNumber','motherCowName','motherCowBreed','sireBullNumber','sireBullName','sireBullBreed'].forEach(k=>{
                if (Object.prototype.hasOwnProperty.call(updates, k)) mapped[k] = updates[k];
            });
        } else {
            return res.status(400).send('Invalid cattle type');
        }

        // Auto-enrich parent fields on edits if only numbers supplied
        async function enrichEdit(mappedObj){
            if (mappedObj.motherCowNumber && (!mappedObj.motherCowName || !mappedObj.motherCowBreed)){
                const mc = await Cow.findOne({ cowNumber: mappedObj.motherCowNumber }).lean();
                if (mc){ mappedObj.motherCowName = mc.cowName; mappedObj.motherCowBreed = mc.race; }
            }
            if (mappedObj.sireBullNumber && (!mappedObj.sireBullName || !mappedObj.sireBullBreed)){
                const sb = await Bull.findOne({ bullNumber: mappedObj.sireBullNumber }).lean();
                if (sb){ mappedObj.sireBullName = sb.bullName; mappedObj.sireBullBreed = sb.race; }
            }
        }
        // Validate parent links on edit when provided and not AI bull
        async function validateParentOnEdit(obj){
            if (obj.motherCowNumber !== undefined && obj.motherCowNumber) {
                const c = await Cow.findOne({ cowNumber: obj.motherCowNumber }).lean();
                if (!c) return `Mother cow number ${obj.motherCowNumber} not found`;
            }
            if (obj.sireBullNumber !== undefined && obj.sireBullNumber) {
                const b = await Bull.findOne({ bullNumber: obj.sireBullNumber }).lean();
                if (!b) return `Sire bull number ${obj.sireBullNumber} not found`;
            }
            return null;
        }
        const parentErr = await validateParentOnEdit(mapped);
        if (parentErr) return res.status(400).send(parentErr);

        await enrichEdit(mapped);
        const updatedEntry = await model.findByIdAndUpdate(id, mapped, { new: true });
        res.status(200).json(updatedEntry);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Lightweight parent lookup by number (returns name & breed)
app.get('/lookup/:type/number/:num', async (req,res)=>{
    try {
        const { type, num } = req.params;
        let item;
        if (type === 'cow') item = await Cow.findOne({ cowNumber: num }).lean();
        else if (type === 'bull') item = await Bull.findOne({ bullNumber: num }).lean();
        else return res.status(400).json({ error:'Invalid type' });
        if (!item) return res.status(404).json({ error:'Not found' });
        return res.json({ id: item._id, number: type==='cow'?item.cowNumber:item.bullNumber, name: type==='cow'?item.cowName:item.bullName, breed: item.race, type, isInsemination: type==='bull' ? !!item.isInsemination : false });
    } catch(err){
        console.error('Lookup error:', err);
        res.status(500).json({ error:'Internal Server Error' });
    }
});

// Generic number lookup (detect type and presence for validation)
app.get('/lookup/number/:num', async (req,res)=>{
    try{
        const num = req.params.num;
        const [cow, bull] = await Promise.all([
            Cow.findOne({ cowNumber: num }).lean(),
            Bull.findOne({ bullNumber: num }).lean(),
        ]);
        if (!cow && !bull) return res.status(404).json({ exists:false });
        if (cow) return res.json({ exists:true, type:'cow', id:cow._id, number:cow.cowNumber, name:cow.cowName, breed:cow.race });
        return res.json({ exists:true, type:'bull', id:bull._id, number:bull.bullNumber, name:bull.bullName, breed:bull.race, isInsemination: !!bull.isInsemination });
    } catch(err){
        console.error('Number lookup error:', err);
        res.status(500).json({ error:'Internal Server Error' });
    }
});

app.post('/delete-cattle', async (req, res) => {
    try {
        const { id, type } = req.body;

        if (!id || !type) {
            return res.status(400).send('Invalid request');
        }

        let model;
        if (type === 'cow') model = Cow;
        else if (type === 'calf') model = Calf;
        else if (type === 'bull') model = Bull;
        else return res.status(400).send('Invalid cattle type');

        await model.findByIdAndDelete(id);
        res.status(200).send('Entry deleted successfully');
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Add route to fetch cattle data for editing
app.get('/get-cattle', async (req, res) => {
    try {
        const { id, type } = req.query;
        if (!id || !type) return res.status(400).json({ error: 'Missing id or type' });
        let Model;
        if (type === 'cow') Model = Cow;
        else if (type === 'calf') Model = Calf;
        else if (type === 'bull') Model = Bull;
        else return res.status(400).json({ error: 'Invalid cattle type' });
        if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id format' });
        const entry = await Model.findById(id).lean();
        if (!entry) return res.status(404).json({ error: 'Entry not found' });
        return res.json(entry);
    } catch (err) {
        console.error('GET /get-cattle error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
});

// Verify database connection
app.get('/test-db', async (req, res) => {
    try {
        const testCow = await Cow.findOne();
        console.log('Database connection test result:', testCow);
        res.status(200).send(testCow ? 'Database connection is active' : 'No data in database');
    } catch (err) {
        console.error('Database connection error:', err);
        res.status(500).send('Database connection error');
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

module.exports = app;