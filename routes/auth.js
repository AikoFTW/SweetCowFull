const express = require('express');
const router = express.Router();
const User = require('../models/user');
const Community = require('../models/community');
const { isAuthenticated, isNotAuthenticated, loadUser } = require('../middleware/auth');

// Apply loadUser middleware to all routes
router.use(loadUser);

/**
 * GET /auth/login - Show login page
 */
router.get('/login', isNotAuthenticated, (req, res) => {
    res.render('auth/login', { 
        title: 'Login',
        error: req.query.error || null,
        success: req.query.success || null
    });
});

/**
 * POST /auth/login - Process login
 */
router.post('/login', isNotAuthenticated, async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.render('auth/login', {
                title: 'Login',
                error: 'Please provide email and password.',
                email
            });
        }
        
        // Find user by email
        const user = await User.findOne({ email: email.toLowerCase() });
        
        if (!user) {
            return res.render('auth/login', {
                title: 'Login',
                error: 'Invalid email or password.',
                email
            });
        }
        
        // Check if user is active
        if (!user.isActive) {
            return res.render('auth/login', {
                title: 'Login',
                error: 'Your account has been deactivated. Please contact support.',
                email
            });
        }
        
        // Verify password
        const isMatch = await user.comparePassword(password);
        
        if (!isMatch) {
            return res.render('auth/login', {
                title: 'Login',
                error: 'Invalid email or password.',
                email
            });
        }
        
        // Update last login
        user.lastLogin = new Date();
        await user.save();
        
        // Set session
        req.session.userId = user._id;
        
        // Set community context
        if (user.role === 'SuperAdmin') {
            // SuperAdmin doesn't need a default community
            req.session.communityId = null;
        } else if (user.memberships && user.memberships.length > 0) {
            req.session.communityId = user.memberships[0].community.toString();
        }
        
        // Redirect to original URL or dashboard
        const returnTo = req.session.returnTo || '/';
        delete req.session.returnTo;
        res.redirect(returnTo);
        
    } catch (error) {
        console.error('Login error:', error);
        res.render('auth/login', {
            title: 'Login',
            error: 'An error occurred. Please try again.',
            email: req.body.email
        });
    }
});

/**
 * GET /auth/register - Show registration page
 */
router.get('/register', isNotAuthenticated, (req, res) => {
    res.render('auth/register', { 
        title: 'Register',
        error: null
    });
});

/**
 * POST /auth/register - Process registration
 */
router.post('/register', isNotAuthenticated, async (req, res) => {
    try {
        const { email, password, confirmPassword, firstName, lastName, farmName } = req.body;
        
        // Validation
        if (!email || !password || !confirmPassword || !firstName || !lastName || !farmName) {
            return res.render('auth/register', {
                title: 'Register',
                error: 'All fields are required.',
                ...req.body
            });
        }
        
        if (password !== confirmPassword) {
            return res.render('auth/register', {
                title: 'Register',
                error: 'Passwords do not match.',
                ...req.body
            });
        }
        
        if (password.length < 8) {
            return res.render('auth/register', {
                title: 'Register',
                error: 'Password must be at least 8 characters long.',
                ...req.body
            });
        }
        
        // Check if email already exists
        const existingUser = await User.findOne({ email: email.toLowerCase() });
        
        if (existingUser) {
            return res.render('auth/register', {
                title: 'Register',
                error: 'An account with this email already exists.',
                ...req.body
            });
        }
        
        // Generate unique slug for farm
        const slug = await Community.generateUniqueSlug(farmName);
        
        // Create user first (without community)
        const user = new User({
            email: email.toLowerCase(),
            password,
            firstName,
            lastName,
            role: 'User'
        });
        
        await user.save();
        
        // Create community/farm with user as owner
        const community = new Community({
            name: farmName,
            slug,
            owner: user._id
        });
        
        await community.save();
        
        // Add user as Admin of the new community
        user.memberships.push({
            community: community._id,
            role: 'Admin'
        });
        
        await user.save();
        
        // Redirect to login with success message
        res.redirect('/auth/login?success=Registration successful! Please log in.');
        
    } catch (error) {
        console.error('Registration error:', error);
        res.render('auth/register', {
            title: 'Register',
            error: 'An error occurred during registration. Please try again.',
            ...req.body
        });
    }
});

/**
 * GET /auth/logout - Logout user
 */
router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
        }
        res.redirect('/auth/login');
    });
});

/**
 * POST /auth/logout - Logout user (POST version)
 */
router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
        }
        res.redirect('/auth/login');
    });
});

/**
 * POST /auth/switch-community - Switch active community
 */
router.post('/switch-community', isAuthenticated, async (req, res) => {
    try {
        const { communityId } = req.body;
        const user = await User.findById(req.session.userId);
        
        // SuperAdmin can switch to any community
        if (user.role === 'SuperAdmin') {
            req.session.communityId = communityId;
            return res.redirect(req.get('referer') || '/');
        }
        
        // Regular users can only switch to communities they're members of
        const isMember = user.memberships.some(
            m => m.community.toString() === communityId
        );
        
        if (!isMember) {
            return res.status(403).json({ error: 'You are not a member of this community.' });
        }
        
        req.session.communityId = communityId;
        res.redirect(req.get('referer') || '/');
        
    } catch (error) {
        console.error('Switch community error:', error);
        res.status(500).json({ error: 'Failed to switch community.' });
    }
});

module.exports = router;
