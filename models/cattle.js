const mongoose = require('mongoose');

const cattleSchema = new mongoose.Schema({
    type: { type: String, required: true }, // 'cow', 'calf', or 'bull'
    motherCowNumber: { type: String },
    motherCowName: { type: String },
    motherCowBreed: { type: String },
    sireBullNumber: { type: String },
    sireBullName: { type: String },
    sireBullBreed: { type: String },
    registeringNumber: { type: String, required: function() { return this.type !== 'calf'; } },
    registeringName: { type: String, required: function() { return this.type !== 'calf'; } },
    registeringRace: { type: String },
    dob: { type: Date },
    lastCalving: { type: Date },
    calfName: { type: String, required: function() { return this.type === 'calf'; } },
    calfBreed: { type: String },
    calfDob: { type: Date },
    calfGender: { type: String },
    notes: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('Cattle', cattleSchema);