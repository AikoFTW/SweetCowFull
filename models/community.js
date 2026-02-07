const mongoose = require('mongoose');

const communitySchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true,
        trim: true 
    },
    slug: { 
        type: String, 
        required: true, 
        unique: true,
        lowercase: true,
        trim: true 
    },
    description: { 
        type: String, 
        default: '' 
    },
    // Farm-specific details
    address: {
        street: { type: String, default: '' },
        city: { type: String, default: '' },
        state: { type: String, default: '' },
        country: { type: String, default: '' },
        postalCode: { type: String, default: '' }
    },
    contactPhone: { 
        type: String, 
        default: '' 
    },
    contactEmail: { 
        type: String, 
        default: '' 
    },
    logoUrl: { 
        type: String, 
        default: null 
    },
    // Owner/creator of the community
    owner: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User',
        required: true 
    },
    // Community settings
    settings: {
        allowMemberInvites: { type: Boolean, default: false },
        requireApproval: { type: Boolean, default: true },
        maxMembers: { type: Number, default: 50 }
    },
    // Color scheme / theming for the community
    theme: {
        primaryColor: { type: String, default: '#108044' },    // Default green
        secondaryColor: { type: String, default: '#064430' },
        accentColor: { type: String, default: '#d0f0c0' },
        logoBackground: { type: String, default: '#ffffff' }
    },
    // Community-specific cattle settings (each farm can customize)
    cattleSettings: {
        // Core cow timing
        gestationDays: { type: Number, default: 283 },
        dryOffAfterSuccessfulInsemDays: { type: Number, default: 220 },
        changeFeedAfterSuccessfulInsemDays: { type: Number, default: 210 },
        postpartumInseminationStartDays: { type: Number, default: 45 },
        inseminationIntervalDays: { type: Number, default: 21 },
        // Alerts
        calvingAlertBeforeDays: { type: Number, default: 7 },
        dryOffAlertBeforeDays: { type: Number, default: 7 },
        changeFeedAlertBeforeDays: { type: Number, default: 7 },
        pregnancyCheckAlertBeforeDays: { type: Number, default: 7 },
        inseminationAlertBeforeDays: { type: Number, default: 7 },
        graduationAlertBeforeDays: { type: Number, default: 30 },
        weaningAlertBeforeDays: { type: Number, default: 7 },
        // Calf management
        femaleWeaningDays: { type: Number, default: 60 },
        maleWeaningDays: { type: Number, default: 60 },
        femaleMaturityMonths: { type: Number, default: 24 },
        maleMaturityMonths: { type: Number, default: 24 }
    },
    // Community statistics (cached for dashboard)
    stats: {
        totalCows: { type: Number, default: 0 },
        totalBulls: { type: Number, default: 0 },
        totalCalves: { type: Number, default: 0 },
        lastUpdated: { type: Date, default: Date.now }
    },
    // Status
    isActive: { 
        type: Boolean, 
        default: true 
    },
    createdAt: { 
        type: Date, 
        default: Date.now 
    },
    updatedAt: { 
        type: Date, 
        default: Date.now 
    }
});

// Generate slug from name before saving
communitySchema.pre('save', function(next) {
    if (this.isModified('name') && !this.slug) {
        this.slug = this.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
    }
    this.updatedAt = new Date();
    next();
});

// Static method to generate unique slug
communitySchema.statics.generateUniqueSlug = async function(name) {
    let slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
    
    let uniqueSlug = slug;
    let counter = 1;
    
    while (await this.findOne({ slug: uniqueSlug })) {
        uniqueSlug = `${slug}-${counter}`;
        counter++;
    }
    
    return uniqueSlug;
};

// Get member count
communitySchema.methods.getMemberCount = async function() {
    const User = mongoose.model('User');
    return User.countDocuments({ 'memberships.community': this._id });
};

// Set JSON serialization options
communitySchema.set('toJSON', {
    virtuals: true,
    transform: function(doc, ret) {
        delete ret.__v;
        return ret;
    }
});

module.exports = mongoose.model('Community', communitySchema);
