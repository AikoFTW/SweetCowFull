const express = require('express');
const router = express.Router();
const User = require('../models/user');
const Community = require('../models/community');
const { isAuthenticated, isSuperAdmin, loadUser } = require('../middleware/auth');

// Apply middleware to all admin routes
router.use(loadUser);
router.use(isAuthenticated);
router.use(isSuperAdmin);

/**
 * POST /admin/impersonate/:communityId - Impersonate a community (view as owner)
 * SuperAdmin can view any community as if they were the owner
 */
router.post('/impersonate/:communityId', async (req, res) => {
    try {
        const community = await Community.findById(req.params.communityId);
        
        if (!community) {
            return res.status(404).json({ error: 'Community not found.' });
        }
        
        // Store original state and set impersonation
        req.session.originalCommunityId = req.session.communityId;
        req.session.impersonating = true;
        req.session.impersonatingCommunityId = community._id.toString();
        req.session.communityId = community._id.toString();
        
        res.redirect('/?impersonating=true');
        
    } catch (error) {
        console.error('Impersonate error:', error);
        res.status(500).json({ error: 'Failed to impersonate community.' });
    }
});

/**
 * POST /admin/stop-impersonating - Stop impersonating and return to admin view
 */
router.post('/stop-impersonating', async (req, res) => {
    try {
        // Restore original state
        if (req.session.originalCommunityId) {
            req.session.communityId = req.session.originalCommunityId;
        } else {
            delete req.session.communityId;
        }
        
        delete req.session.impersonating;
        delete req.session.impersonatingCommunityId;
        delete req.session.originalCommunityId;
        
        res.redirect('/admin');
        
    } catch (error) {
        console.error('Stop impersonating error:', error);
        res.redirect('/admin');
    }
});

/**
 * GET /admin - Admin dashboard
 */
router.get('/', async (req, res) => {
    try {
        const [communities, users] = await Promise.all([
            Community.find().populate('owner', 'firstName lastName email').sort({ createdAt: -1 }).lean(),
            User.find().sort({ createdAt: -1 }).lean()
        ]);
        
        // Get member counts for each community
        const communityData = await Promise.all(
            communities.map(async (c) => {
                const memberCount = await User.countDocuments({ 'memberships.community': c._id });
                return { ...c, memberCount };
            })
        );
        
        res.render('admin/dashboard', {
            title: 'Super Admin Dashboard',
            communities: communityData,
            users,
            stats: {
                totalCommunities: communities.length,
                totalUsers: users.length,
                activeUsers: users.filter(u => u.isActive).length,
                superAdmins: users.filter(u => u.role === 'SuperAdmin').length
            }
        });
    } catch (error) {
        console.error('Admin dashboard error:', error);
        res.status(500).render('error', {
            title: 'Error',
            message: 'Failed to load admin dashboard.',
            error: { status: 500 }
        });
    }
});

/**
 * GET /admin/communities - List all communities
 */
router.get('/communities', async (req, res) => {
    try {
        const communities = await Community.find()
            .populate('owner', 'firstName lastName email')
            .sort({ createdAt: -1 })
            .lean();
        
        const communityData = await Promise.all(
            communities.map(async (c) => {
                const memberCount = await User.countDocuments({ 'memberships.community': c._id });
                return { ...c, memberCount };
            })
        );
        
        res.render('admin/communities', {
            title: 'Manage Communities',
            communities: communityData
        });
    } catch (error) {
        console.error('List communities error:', error);
        res.status(500).render('error', {
            title: 'Error',
            message: 'Failed to load communities.',
            error: { status: 500 }
        });
    }
});

/**
 * GET /admin/communities/create - Show create community form
 */
router.get('/communities/create', async (req, res) => {
    const users = await User.find({ role: 'User', isActive: true }).select('firstName lastName email').lean();
    res.render('admin/community-form', {
        title: 'Create Community',
        community: null,
        users,
        error: null
    });
});

/**
 * POST /admin/communities/create - Create new community (and owner user if needed)
 */
router.post('/communities/create', async (req, res) => {
    try {
        const { 
            name, description, 
            // Owner selection or new owner creation
            ownerId, ownerEmail, ownerPassword, ownerFirstName, ownerLastName,
            contactPhone, contactEmail, 
            street, city, state, country, postalCode 
        } = req.body;
        
        const users = await User.find({ role: 'User', isActive: true }).select('firstName lastName email').lean();
        
        if (!name) {
            return res.render('admin/community-form', {
                title: 'Create Community',
                community: req.body,
                users,
                error: 'Community name is required.'
            });
        }
        
        let owner = null;
        
        // Determine owner: existing user or create new one
        if (ownerId && ownerId !== 'new') {
            // Using existing user
            owner = await User.findById(ownerId);
            if (!owner) {
                return res.render('admin/community-form', {
                    title: 'Create Community',
                    community: req.body,
                    users,
                    error: 'Selected owner not found.'
                });
            }
        } else {
            // Creating new user as owner
            if (!ownerEmail || !ownerPassword || !ownerFirstName || !ownerLastName) {
                return res.render('admin/community-form', {
                    title: 'Create Community',
                    community: req.body,
                    users,
                    error: 'All owner fields (email, password, first name, last name) are required when creating a new owner.'
                });
            }
            
            if (ownerPassword.length < 8) {
                return res.render('admin/community-form', {
                    title: 'Create Community',
                    community: req.body,
                    users,
                    error: 'Owner password must be at least 8 characters.'
                });
            }
            
            // Check if email already exists
            const existingUser = await User.findOne({ email: ownerEmail.toLowerCase() });
            if (existingUser) {
                return res.render('admin/community-form', {
                    title: 'Create Community',
                    community: req.body,
                    users,
                    error: 'A user with this email already exists. Select them from the dropdown instead.'
                });
            }
            
            // Create new owner user
            owner = new User({
                email: ownerEmail.toLowerCase(),
                password: ownerPassword,
                firstName: ownerFirstName,
                lastName: ownerLastName,
                role: 'User',
                isActive: true
            });
            
            await owner.save();
        }
        
        const slug = await Community.generateUniqueSlug(name);
        
        const community = new Community({
            name,
            slug,
            description: description || '',
            owner: owner._id,
            contactPhone: contactPhone || '',
            contactEmail: contactEmail || '',
            address: {
                street: street || '',
                city: city || '',
                state: state || '',
                country: country || '',
                postalCode: postalCode || ''
            }
        });
        
        await community.save();
        
        // Add owner as Admin of the community
        if (!owner.memberships.some(m => m.community && m.community.toString() === community._id.toString())) {
            owner.memberships.push({
                community: community._id,
                role: 'Admin'
            });
            await owner.save();
        }
        
        res.redirect('/admin/communities?success=Community created successfully');
        
    } catch (error) {
        console.error('Create community error:', error);
        const users = await User.find({ role: 'User', isActive: true }).select('firstName lastName email').lean();
        res.render('admin/community-form', {
            title: 'Create Community',
            community: req.body,
            users,
            error: 'Failed to create community. ' + (error.message || '')
        });
    }
});

/**
 * GET /admin/communities/:id - View community details
 */
router.get('/communities/:id', async (req, res) => {
    try {
        const community = await Community.findById(req.params.id)
            .populate('owner', 'firstName lastName email')
            .lean();
        
        if (!community) {
            return res.status(404).render('error', {
                title: 'Not Found',
                message: 'Community not found.',
                error: { status: 404 }
            });
        }
        
        // Get all members of this community
        const members = await User.find({ 'memberships.community': community._id })
            .select('firstName lastName email memberships isActive lastLogin')
            .lean();
        
        // Add role info to members
        const membersWithRoles = members.map(m => {
            const membership = m.memberships.find(
                mem => mem.community.toString() === community._id.toString()
            );
            return {
                ...m,
                communityRole: membership ? membership.role : 'Member',
                joinedAt: membership ? membership.joinedAt : null
            };
        });
        
        res.render('admin/community-detail', {
            title: `Community: ${community.name}`,
            community,
            members: membersWithRoles
        });
        
    } catch (error) {
        console.error('View community error:', error);
        res.status(500).render('error', {
            title: 'Error',
            message: 'Failed to load community.',
            error: { status: 500 }
        });
    }
});

/**
 * GET /admin/communities/:id/edit - Edit community form
 */
router.get('/communities/:id/edit', async (req, res) => {
    try {
        const community = await Community.findById(req.params.id)
            .populate('owner', 'email firstName lastName')
            .lean();
        
        if (!community) {
            return res.status(404).render('error', {
                title: 'Not Found',
                message: 'Community not found.',
                error: { status: 404 }
            });
        }
        
        const users = await User.find({ role: 'User', isActive: true }).select('firstName lastName email').lean();
        
        res.render('admin/community-form', {
            title: 'Edit Community',
            community: {
                ...community,
                ownerId: community.owner ? community.owner._id : '',
                ownerEmail: community.owner ? community.owner.email : '',
                street: community.address?.street || '',
                city: community.address?.city || '',
                state: community.address?.state || '',
                country: community.address?.country || '',
                postalCode: community.address?.postalCode || ''
            },
            users,
            error: null
        });
        
    } catch (error) {
        console.error('Edit community form error:', error);
        res.status(500).render('error', {
            title: 'Error',
            message: 'Failed to load community.',
            error: { status: 500 }
        });
    }
});

/**
 * POST /admin/communities/:id/edit - Update community
 */
router.post('/communities/:id/edit', async (req, res) => {
    try {
        const { name, description, contactPhone, contactEmail, street, city, state, country, postalCode, isActive } = req.body;
        
        const community = await Community.findById(req.params.id);
        
        if (!community) {
            return res.status(404).render('error', {
                title: 'Not Found',
                message: 'Community not found.',
                error: { status: 404 }
            });
        }
        
        community.name = name || community.name;
        community.description = description || '';
        community.contactPhone = contactPhone || '';
        community.contactEmail = contactEmail || '';
        community.address = {
            street: street || '',
            city: city || '',
            state: state || '',
            country: country || '',
            postalCode: postalCode || ''
        };
        community.isActive = isActive === 'on' || isActive === true;
        
        await community.save();
        
        res.redirect(`/admin/communities/${community._id}?success=Community updated successfully`);
        
    } catch (error) {
        console.error('Update community error:', error);
        res.render('admin/community-form', {
            title: 'Edit Community',
            community: { ...req.body, _id: req.params.id },
            error: 'Failed to update community.'
        });
    }
});

/**
 * POST /admin/communities/:id/delete - Delete community
 */
router.post('/communities/:id/delete', async (req, res) => {
    try {
        const community = await Community.findById(req.params.id);
        
        if (!community) {
            return res.status(404).json({ error: 'Community not found.' });
        }
        
        // Remove community from all users' memberships
        await User.updateMany(
            { 'memberships.community': community._id },
            { $pull: { memberships: { community: community._id } } }
        );
        
        // Delete the community
        await Community.findByIdAndDelete(req.params.id);
        
        res.redirect('/admin/communities?success=Community deleted successfully');
        
    } catch (error) {
        console.error('Delete community error:', error);
        res.status(500).json({ error: 'Failed to delete community.' });
    }
});

/**
 * GET /admin/users - List all users
 */
router.get('/users', async (req, res) => {
    try {
        const users = await User.find()
            .populate('memberships.community', 'name')
            .sort({ createdAt: -1 })
            .lean();
        
        res.render('admin/users', {
            title: 'Manage Users',
            users
        });
    } catch (error) {
        console.error('List users error:', error);
        res.status(500).render('error', {
            title: 'Error',
            message: 'Failed to load users.',
            error: { status: 500 }
        });
    }
});

/**
 * GET /admin/users/create - Show create user form
 */
router.get('/users/create', async (req, res) => {
    const communities = await Community.find().select('name').lean();
    res.render('admin/user-form', {
        title: 'Create User',
        user: null,
        communities,
        error: null
    });
});

/**
 * POST /admin/users/create - Create new user
 */
router.post('/users/create', async (req, res) => {
    try {
        const { email, password, firstName, lastName, role, communityId, communityRole } = req.body;
        const communities = await Community.find().select('name').lean();
        
        if (!email || !password || !firstName || !lastName) {
            return res.render('admin/user-form', {
                title: 'Create User',
                user: req.body,
                communities,
                error: 'All fields are required.'
            });
        }
        
        // Check if email exists
        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) {
            return res.render('admin/user-form', {
                title: 'Create User',
                user: req.body,
                communities,
                error: 'A user with this email already exists.'
            });
        }
        
        const user = new User({
            email: email.toLowerCase(),
            password,
            firstName,
            lastName,
            role: role || 'User'
        });
        
        // Add to community if specified
        if (communityId) {
            user.memberships.push({
                community: communityId,
                role: communityRole || 'Member'
            });
        }
        
        await user.save();
        
        res.redirect('/admin/users?success=User created successfully');
        
    } catch (error) {
        console.error('Create user error:', error);
        const communities = await Community.find().select('name').lean();
        res.render('admin/user-form', {
            title: 'Create User',
            user: req.body,
            communities,
            error: 'Failed to create user.'
        });
    }
});

/**
 * GET /admin/users/:id - View user details
 */
router.get('/users/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id)
            .populate('memberships.community', 'name slug')
            .lean();
        
        if (!user) {
            return res.status(404).render('error', {
                title: 'Not Found',
                message: 'User not found.',
                error: { status: 404 }
            });
        }
        
        res.render('admin/user-detail', {
            title: `User: ${user.firstName} ${user.lastName}`,
            targetUser: user
        });
        
    } catch (error) {
        console.error('View user error:', error);
        res.status(500).render('error', {
            title: 'Error',
            message: 'Failed to load user.',
            error: { status: 500 }
        });
    }
});

/**
 * GET /admin/users/:id/edit - Edit user form
 */
router.get('/users/:id/edit', async (req, res) => {
    try {
        const user = await User.findById(req.params.id).lean();
        const communities = await Community.find().select('name').lean();
        
        if (!user) {
            return res.status(404).render('error', {
                title: 'Not Found',
                message: 'User not found.',
                error: { status: 404 }
            });
        }
        
        res.render('admin/user-form', {
            title: 'Edit User',
            user,
            communities,
            error: null
        });
        
    } catch (error) {
        console.error('Edit user form error:', error);
        res.status(500).render('error', {
            title: 'Error',
            message: 'Failed to load user.',
            error: { status: 500 }
        });
    }
});

/**
 * POST /admin/users/:id/edit - Update user
 */
router.post('/users/:id/edit', async (req, res) => {
    try {
        const { firstName, lastName, role, isActive, password } = req.body;
        
        const user = await User.findById(req.params.id);
        
        if (!user) {
            return res.status(404).render('error', {
                title: 'Not Found',
                message: 'User not found.',
                error: { status: 404 }
            });
        }
        
        user.firstName = firstName || user.firstName;
        user.lastName = lastName || user.lastName;
        user.role = role || user.role;
        user.isActive = isActive === 'on' || isActive === true;
        
        // Only update password if provided
        if (password && password.trim().length > 0) {
            user.password = password;
        }
        
        await user.save();
        
        res.redirect(`/admin/users/${user._id}?success=User updated successfully`);
        
    } catch (error) {
        console.error('Update user error:', error);
        const communities = await Community.find().select('name').lean();
        res.render('admin/user-form', {
            title: 'Edit User',
            user: { ...req.body, _id: req.params.id },
            communities,
            error: 'Failed to update user.'
        });
    }
});

/**
 * POST /admin/users/:id/toggle-status - Toggle user active status
 */
router.post('/users/:id/toggle-status', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }
        
        user.isActive = !user.isActive;
        await user.save();
        
        res.redirect(`/admin/users?success=User ${user.isActive ? 'activated' : 'deactivated'} successfully`);
        
    } catch (error) {
        console.error('Toggle user status error:', error);
        res.status(500).json({ error: 'Failed to toggle user status.' });
    }
});

/**
 * POST /admin/users/:id/add-membership - Add user to community
 */
router.post('/users/:id/add-membership', async (req, res) => {
    try {
        const { communityId, communityRole } = req.body;
        const user = await User.findById(req.params.id);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }
        
        // Check if already a member
        const existingMembership = user.memberships.find(
            m => m.community.toString() === communityId
        );
        
        if (existingMembership) {
            existingMembership.role = communityRole || 'Member';
        } else {
            user.memberships.push({
                community: communityId,
                role: communityRole || 'Member'
            });
        }
        
        await user.save();
        
        res.redirect(`/admin/users/${user._id}?success=Membership updated successfully`);
        
    } catch (error) {
        console.error('Add membership error:', error);
        res.status(500).json({ error: 'Failed to add membership.' });
    }
});

/**
 * POST /admin/users/:id/remove-membership - Remove user from community
 */
router.post('/users/:id/remove-membership', async (req, res) => {
    try {
        const { communityId } = req.body;
        const user = await User.findById(req.params.id);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }
        
        user.memberships = user.memberships.filter(
            m => m.community.toString() !== communityId
        );
        
        await user.save();
        
        res.redirect(`/admin/users/${user._id}?success=Membership removed successfully`);
        
    } catch (error) {
        console.error('Remove membership error:', error);
        res.status(500).json({ error: 'Failed to remove membership.' });
    }
});

module.exports = router;
