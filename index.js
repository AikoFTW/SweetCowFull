const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
// Insemination model not used in current registry view

const app = express();
const PORT = 3000;

// Connect to MongoDB
mongoose.connect('mongodb://localhost:27017/sweetcow', {
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
    // Pregnancy tracking removed per UI simplification
    motherCowNumber: String,
    motherCowName: String,
    motherCowBreed: String,
    sireBullNumber: String,
    sireBullName: String,
    sireBullBreed: String,
});

const calfSchema = new mongoose.Schema({
    calfName: { type: String },
    calfBreed: { type: String },
    birthDate: { type: Date },
    gender: { type: String, enum: ['male','female'], required: true },
    notes: { type: String },
    motherCowNumber: String,
    motherCowName: String,
    motherCowBreed: String,
    sireBullNumber: String,
    sireBullName: String,
    sireBullBreed: String,
});

const bullSchema = new mongoose.Schema({
    bullNumber: String,
    bullName: String,
    race: String,
    dob: Date,
    notes: String,
    motherCowNumber: String,
    motherCowName: String,
    motherCowBreed: String,
    sireBullNumber: String,
    sireBullName: String,
    sireBullBreed: String,
});

const settingsSchema = new mongoose.Schema({
    // Core cow timing
    gestationDays: Number,
    dryOffAfterSuccessfulInsemDays: Number,
    changeFeedAfterSuccessfulInsemDays: Number,
    postpartumInseminationStartDays: Number,
    inseminationIntervalMonths: Number,

    // Alerts
    calvingAlertBeforeDays: Number,
    dryOffAlertBeforeDays: Number,
    changeFeedAlertBeforeDays: Number,

    // Calf management
    femaleWeaningMonths: Number,
    maleWeaningMonths: Number,
    maleSellAgeMonths: Number,
});

// Create models
const Cow = mongoose.model('Cow', cowSchema);
const Calf = mongoose.model('Calf', calfSchema);
const Bull = mongoose.model('Bull', bullSchema);
const Settings = mongoose.model('Settings', settingsSchema);
const Cattle = require('./models/cattle');

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded
app.use(express.json()); // Middleware to parse JSON data

// Middleware to set default title
app.use((req, res, next) => {
    res.locals.title = '';
    next();
});

// Replace mock data with database queries
app.get('/', async (req, res) => {
    try {
        const cows = await Cow.find();
        const calves = await Calf.find();
        const bulls = await Bull.find();
        res.render('index', { title: 'SweetCow Dashboard', cows, calves, bulls });
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Route for Cattle Management page
app.get('/cattle-management', (req, res) => {
    res.render('cattle-management', { title: 'Cattle Management' });
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
                inseminationIntervalMonths: 3,
                calvingAlertBeforeDays: 10,
                dryOffAlertBeforeDays: 1,
                changeFeedAlertBeforeDays: 1,
                femaleWeaningMonths: 14,
                maleWeaningMonths: 8,
                maleSellAgeMonths: 16,
            });
            await settings.save();
        }
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
          inseminationIntervalMonths,
          calvingAlertBeforeDays,
          dryOffAlertBeforeDays,
          changeFeedAlertBeforeDays,
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
        settings.inseminationIntervalMonths = n(inseminationIntervalMonths);
        settings.calvingAlertBeforeDays = n(calvingAlertBeforeDays);
        settings.dryOffAlertBeforeDays = n(dryOffAlertBeforeDays);
        settings.changeFeedAlertBeforeDays = n(changeFeedAlertBeforeDays);
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
app.get('/cattle-viewer', (req, res) => {
    res.locals.title = 'Cattle Viewer';
    res.render('cattle-viewer');
});

// Route to add cattle
app.post('/add-cattle', async (req, res) => {
    try {
        const { type } = req.body;

        if (!type) {
            return res.status(400).json({ error: 'Cattle type is required' });
        }

        let newEntry;

        if (type === 'cow') {
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
        } else if (type === 'calf') {
            // Validate gender
            const gender = req.body.gender;
            if (!['male','female'].includes(gender)) {
                return res.status(400).json({ error: 'Calf gender must be male or female' });
            }
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
        } else if (type === 'bull') {
            newEntry = new Bull({
                bullNumber: req.body.registeringNumber,
                bullName: req.body.registeringName,
                race: req.body.registeringRace,
                dob: req.body.dob,
                notes: req.body.notes,
                motherCowNumber: req.body.motherCowNumber,
                motherCowName: req.body.motherCowName,
                motherCowBreed: req.body.motherCowBreed,
                sireBullNumber: req.body.sireBullNumber,
                sireBullName: req.body.sireBullName,
                sireBullBreed: req.body.sireBullBreed,
            });
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

        let model;
        if (type === 'cow') model = Cow;
        else if (type === 'calf') model = Calf;
        else if (type === 'bull') model = Bull;
        else return res.status(400).send('Invalid cattle type');

        const updatedEntry = await model.findByIdAndUpdate(id, updates, { new: true });
        res.status(200).json(updatedEntry);
    } catch (err) {
        res.status(500).send(err.message);
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

        if (!id || !type) {
            return res.status(400).send('Invalid request');
        }

        let model;
        if (type === 'cow') model = Cow;
        else if (type === 'calf') model = Calf;
        else if (type === 'bull') model = Bull;
        else return res.status(400).send('Invalid cattle type');

        const entry = await model.findById(id);
        res.status(200).json(entry);
    } catch (err) {
        res.status(500).send(err.message);
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