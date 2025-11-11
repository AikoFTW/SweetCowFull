const mongoose = require('mongoose');

const inseminationSchema = new mongoose.Schema({
    cowId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Cow',
        required: true
    },
    date: {
        type: Date,
        required: true
    },
    success: {
        type: Boolean,
        default: false
    },
    notes: {
        type: String,
        default: ''
    }
}, { timestamps: true });

module.exports = mongoose.model('Insemination', inseminationSchema);