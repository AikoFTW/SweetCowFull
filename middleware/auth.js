const User = require('../models/user');
const Community = require('../models/community');

/**
 * Check if user is authenticated
 */
const isAuthenticated = (req, res, next) => {
    if (req.session && req.session.userId) {
        return next();
    }
    
    // Store the original URL to redirect after login
    req.session.returnTo = req.originalUrl;
    res.redirect('/auth/login');
};

/**
 * Check if user is NOT authenticated (for login/register pages)
 */
const isNotAuthenticated = (req, res, next) => {
    if (req.session && req.session.userId) {
        return res.redirect('/');
    }
    next();
};

/**
 * Load current user and community into request
 * Also handles impersonation for SuperAdmins
 */
const loadUser = async (req, res, next) => {
    if (req.session && req.session.userId) {
        try {
            const user = await User.findById(req.session.userId)
                .populate('memberships.community')
                .lean();
            
            if (user && user.isActive) {
                req.user = user;
                res.locals.user = user;
                
                // Track impersonation status
                req.isImpersonating = !!req.session.impersonating;
                res.locals.isImpersonating = req.isImpersonating;
                
                // Handle impersonation - SuperAdmin viewing as another community's owner
                if (req.isImpersonating && req.session.impersonatingCommunityId) {
                    req.communityId = req.session.impersonatingCommunityId;
                    const community = await Community.findById(req.session.impersonatingCommunityId).lean();
                    req.community = community;
                    res.locals.community = community;
                    req.userRole = 'Admin'; // Impersonating user acts as Admin
                    res.locals.userRole = req.userRole;
                    return next();
                }
                
                // Set current community from session or default to first membership
                if (req.session.communityId) {
                    req.communityId = req.session.communityId;
                    const community = await Community.findById(req.session.communityId).lean();
                    req.community = community;
                    res.locals.community = community;
                } else if (user.memberships && user.memberships.length > 0) {
                    req.communityId = user.memberships[0].community._id;
                    req.community = user.memberships[0].community;
                    res.locals.community = user.memberships[0].community;
                    req.session.communityId = req.communityId.toString();
                }
                
                // Set user role in current community
                if (user.role === 'SuperAdmin') {
                    req.userRole = 'SuperAdmin';
                } else if (req.communityId) {
                    const membership = user.memberships.find(
                        m => m.community._id.toString() === req.communityId.toString()
                    );
                    req.userRole = membership ? membership.role : null;
                }
                res.locals.userRole = req.userRole;
            } else {
                // User not found or inactive, clear session
                req.session.destroy();
            }
        } catch (error) {
            console.error('Error loading user:', error);
        }
    }
    next();
};

/**
 * Check if user is SuperAdmin
 */
const isSuperAdmin = (req, res, next) => {
    if (!req.user) {
        return res.redirect('/auth/login');
    }
    
    if (req.user.role !== 'SuperAdmin') {
        return res.status(403).render('error', {
            title: 'Access Denied',
            message: 'You do not have permission to access this page.',
            error: { status: 403 }
        });
    }
    
    next();
};

/**
 * Check if user is Admin of current community (or SuperAdmin)
 */
const isAdmin = (req, res, next) => {
    if (!req.user) {
        return res.redirect('/auth/login');
    }
    
    if (req.user.role === 'SuperAdmin') {
        return next();
    }
    
    if (!req.communityId) {
        return res.status(403).render('error', {
            title: 'Access Denied',
            message: 'No community selected.',
            error: { status: 403 }
        });
    }
    
    const membership = req.user.memberships.find(
        m => m.community._id.toString() === req.communityId.toString()
    );
    
    if (!membership || membership.role !== 'Admin') {
        return res.status(403).render('error', {
            title: 'Access Denied',
            message: 'You must be an administrator to access this page.',
            error: { status: 403 }
        });
    }
    
    next();
};

/**
 * Check if user is member of current community (or SuperAdmin)
 */
const isMember = (req, res, next) => {
    if (!req.user) {
        return res.redirect('/auth/login');
    }
    
    if (req.user.role === 'SuperAdmin') {
        return next();
    }
    
    if (!req.communityId) {
        return res.status(403).render('error', {
            title: 'Access Denied',
            message: 'No community selected.',
            error: { status: 403 }
        });
    }
    
    const membership = req.user.memberships.find(
        m => m.community._id.toString() === req.communityId.toString()
    );
    
    if (!membership) {
        return res.status(403).render('error', {
            title: 'Access Denied',
            message: 'You are not a member of this community.',
            error: { status: 403 }
        });
    }
    
    next();
};

/**
 * Build a community filter for database queries
 * SuperAdmin sees all data unless impersonating, others only see their community's data
 */
const getCommunityFilter = (req) => {
    // If impersonating, always use the impersonated community
    if (req.session && req.session.impersonating && req.session.impersonatingCommunityId) {
        return { community: req.session.impersonatingCommunityId };
    }
    
    // Use query param if provided (for SuperAdmin cross-community queries)
    if (req.query.communityId) {
        return { community: req.query.communityId };
    }
    
    // For regular users or SuperAdmin with community selected, filter by community
    if (req.communityId) {
        return { community: req.communityId };
    }
    
    // SuperAdmin without specific community context sees all
    if (req.user && req.user.role === 'SuperAdmin') {
        return {};
    }
    
    // No community context - return filter that matches nothing (for safety)
    return { community: null };
};

/**
 * Middleware to ensure community context exists for tenant-scoped routes
 */
const requireCommunity = (req, res, next) => {
    if (!req.user) {
        return res.redirect('/auth/login');
    }
    
    // SuperAdmin can operate without community context
    if (req.user.role === 'SuperAdmin') {
        return next();
    }
    
    if (!req.communityId) {
        return res.redirect('/select-community');
    }
    
    next();
};

module.exports = {
    isAuthenticated,
    isNotAuthenticated,
    loadUser,
    isSuperAdmin,
    isAdmin,
    isMember,
    getCommunityFilter,
    requireCommunity
};
