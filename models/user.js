const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    email: { 
        type: String, 
        required: true, 
        unique: true, 
        lowercase: true,
        trim: true 
    },
    password: { 
        type: String, 
        required: true 
    },
    firstName: { 
        type: String, 
        required: true,
        trim: true 
    },
    lastName: { 
        type: String, 
        required: true,
        trim: true 
    },
    // Global role - only SuperAdmin is set here
    role: { 
        type: String, 
        enum: ['SuperAdmin', 'User'], 
        default: 'User' 
    },
    // Community memberships with per-community roles
    memberships: [{
        community: { 
            type: mongoose.Schema.Types.ObjectId, 
            ref: 'Community',
            required: true 
        },
        role: { 
            type: String, 
            enum: ['Admin', 'Member'], 
            default: 'Member' 
        },
        joinedAt: { 
            type: Date, 
            default: Date.now 
        }
    }],
    // Currently active community (for session context)
    activeCommuntiy: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Community',
        default: null 
    },
    profileImageUrl: { 
        type: String, 
        default: null 
    },
    isActive: { 
        type: Boolean, 
        default: true 
    },
    lastLogin: { 
        type: Date, 
        default: null 
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

// Hash password before saving
userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();
    
    try {
        const salt = await bcrypt.genSalt(12);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (error) {
        next(error);
    }
});

// Update timestamp on save
userSchema.pre('save', function(next) {
    this.updatedAt = new Date();
    next();
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

// Get full name
userSchema.virtual('fullName').get(function() {
    return `${this.firstName} ${this.lastName}`;
});

// Check if user is SuperAdmin
userSchema.methods.isSuperAdmin = function() {
    return this.role === 'SuperAdmin';
};

// Check if user is Admin of a specific community
userSchema.methods.isAdminOf = function(communityId) {
    if (this.role === 'SuperAdmin') return true;
    const membership = this.memberships.find(
        m => m.community.toString() === communityId.toString()
    );
    return membership && membership.role === 'Admin';
};

// Check if user is Member of a specific community
userSchema.methods.isMemberOf = function(communityId) {
    if (this.role === 'SuperAdmin') return true;
    return this.memberships.some(
        m => m.community.toString() === communityId.toString()
    );
};

// Get user's role in a specific community
userSchema.methods.getRoleIn = function(communityId) {
    if (this.role === 'SuperAdmin') return 'SuperAdmin';
    const membership = this.memberships.find(
        m => m.community.toString() === communityId.toString()
    );
    return membership ? membership.role : null;
};

// Set JSON serialization options
userSchema.set('toJSON', {
    virtuals: true,
    transform: function(doc, ret) {
        delete ret.password;
        delete ret.__v;
        return ret;
    }
});

module.exports = mongoose.model('User', userSchema);
