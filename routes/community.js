const express = require('express');
const router = express.Router();
const User = require('../models/user');
const Community = require('../models/community');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { isAuthenticated, isAdmin, loadUser } = require('../middleware/auth');

// Apply middleware to all community routes
router.use(loadUser);
router.use(isAuthenticated);

/**
 * GET /community/dashboard - Community admin dashboard
 * Shows stats, member management, settings for the current community
 */
router.get('/dashboard', isAdmin, async (req, res) => {
    try {
        if (!req.communityId) {
            return res.redirect('/select-community');
        }

        const community = await Community.findById(req.communityId)
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
            .select('firstName lastName email memberships isActive lastLogin createdAt')
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

        // Get cattle counts for this community
        const Cow = mongoose.model('Cow');
        const Bull = mongoose.model('Bull');
        const Calf = mongoose.model('Calf');
        const Insemination = mongoose.model('Insemination');
        const Settings = mongoose.model('Settings');

        const [cowCount, bullCount, calfCount] = await Promise.all([
            Cow.countDocuments({ community: community._id }),
            Bull.countDocuments({ community: community._id }),
            Calf.countDocuments({ community: community._id })
        ]);

        // Calculate gender distribution for calves
        const [maleCalves, femaleCalves] = await Promise.all([
            Calf.countDocuments({ community: community._id, gender: 'male', status: 'alive' }),
            Calf.countDocuments({ community: community._id, gender: 'female', status: 'alive' })
        ]);

        // Get settings for timing calculations
        const settings = await Settings.findOne({ community: community._id }).lean() || {};
        const gestationDays = settings.gestationDays || 283;
        const postpartumDays = settings.postpartumInseminationStartDays || 45;
        const inseminationIntervalDays = settings.inseminationIntervalDays || 21;
        const femaleMaturityMonths = settings.femaleMaturityMonths || 24;
        const maleMaturityMonths = settings.maleMaturityMonths || 24;
        const femaleWeaningDays = settings.femaleWeaningDays || settings.weaningDays || 180;
        const maleWeaningDays = settings.maleWeaningDays || settings.weaningDays || 180;
        const calvingAlertDays = settings.calvingAlertBeforeDays || 14;

        const now = new Date();

        // ========== NEEDS ATTENTION DATA ==========

        // 1. Cows needing insemination
        // Criteria: No confirmed pregnancy, and either:
        //   - No insemination attempts, OR
        //   - Last insemination was > inseminationIntervalDays ago and not confirmed
        const allCows = await Cow.find({ community: community._id }).lean();
        const allInseminations = await Insemination.find({ community: community._id }).lean();
        
        // Group inseminations by cowId
        const insemByCow = {};
        allInseminations.forEach(ins => {
            const cowIdStr = ins.cowId.toString();
            if (!insemByCow[cowIdStr]) insemByCow[cowIdStr] = [];
            insemByCow[cowIdStr].push(ins);
        });

        const cowsNeedingInsemination = [];
        const cowsDueForCalving = [];

        for (const cow of allCows) {
            const cowIdStr = cow._id.toString();
            const insems = (insemByCow[cowIdStr] || []).sort((a, b) => new Date(b.date) - new Date(a.date));
            const lastInsem = insems[0];
            const hasConfirmedPregnancy = insems.some(i => i.confirmedPregnant && !i.failed);
            
            // Check if cow is due for calving (has confirmed pregnancy)
            if (hasConfirmedPregnancy) {
                const confirmedInsem = insems.find(i => i.confirmedPregnant && !i.failed);
                if (confirmedInsem) {
                    const dueDate = new Date(confirmedInsem.date);
                    dueDate.setDate(dueDate.getDate() + gestationDays);
                    const daysUntilDue = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));
                    if (daysUntilDue <= calvingAlertDays && daysUntilDue >= -7) {
                        cowsDueForCalving.push({
                            ...cow,
                            dueDate,
                            daysUntilDue,
                            reason: daysUntilDue < 0 ? 'Overdue' : daysUntilDue === 0 ? 'Due today' : `Due in ${daysUntilDue} days`
                        });
                    }
                }
                continue; // Pregnant cows don't need insemination
            }
            
            // Check if cow needs insemination
            let needsInsem = false;
            let reason = '';
            
            if (!lastInsem) {
                // No insemination history
                if (cow.lastCalving) {
                    const daysSinceCalving = Math.floor((now - new Date(cow.lastCalving)) / (1000 * 60 * 60 * 24));
                    if (daysSinceCalving >= postpartumDays) {
                        needsInsem = true;
                        reason = `${daysSinceCalving} days since calving`;
                    }
                } else {
                    needsInsem = true;
                    reason = 'No insemination history';
                }
            } else {
                const daysSinceLastInsem = Math.floor((now - new Date(lastInsem.date)) / (1000 * 60 * 60 * 24));
                if (lastInsem.failed) {
                    needsInsem = true;
                    reason = 'Last attempt failed';
                } else if (daysSinceLastInsem >= inseminationIntervalDays) {
                    needsInsem = true;
                    reason = `${daysSinceLastInsem} days since last attempt`;
                }
            }
            
            if (needsInsem) {
                cowsNeedingInsemination.push({ ...cow, reason, lastInsemination: lastInsem });
            }
        }

        // 2. Calves ready for graduation (maturity)
        const allCalves = await Calf.find({ 
            community: community._id, 
            status: 'alive',
            graduated: { $ne: true }
        }).lean();
        
        const calvesReadyForGraduation = [];
        const calvesReadyForWeaning = [];

        for (const calf of allCalves) {
            if (!calf.birthDate || !calf.gender) continue;
            
            const ageInDays = Math.floor((now - new Date(calf.birthDate)) / (1000 * 60 * 60 * 24));
            const ageInMonths = Math.floor(ageInDays / 30);
            
            // Check graduation readiness
            const maturityThreshold = calf.gender === 'female' ? femaleMaturityMonths : maleMaturityMonths;
            if (ageInMonths >= maturityThreshold) {
                calvesReadyForGraduation.push({
                    ...calf,
                    ageInMonths,
                    reason: `${ageInMonths} months old (threshold: ${maturityThreshold})`
                });
            }
            
            // Check weaning readiness
            const weaningThreshold = calf.gender === 'female' ? femaleWeaningDays : maleWeaningDays;
            if (ageInDays >= weaningThreshold && ageInMonths < maturityThreshold) {
                calvesReadyForWeaning.push({
                    ...calf,
                    ageInDays,
                    reason: `${ageInDays} days old (threshold: ${weaningThreshold})`
                });
            }
        }

        // 3. Bulls (for now just show inactive/old bulls - placeholder for future)
        const allBulls = await Bull.find({ community: community._id }).lean();

        res.render('community/dashboard', {
            title: `${community.name} - Dashboard`,
            community,
            members: membersWithRoles,
            stats: {
                totalCows: cowCount,
                totalBulls: bullCount,
                totalCalves: calfCount,
                totalMembers: members.length,
                admins: membersWithRoles.filter(m => m.communityRole === 'Admin').length,
                maleCalves,
                femaleCalves
            },
            needsAttention: {
                cowsNeedingInsemination: cowsNeedingInsemination.slice(0, 20),
                cowsDueForCalving: cowsDueForCalving.slice(0, 20),
                calvesReadyForGraduation: calvesReadyForGraduation.slice(0, 20),
                calvesReadyForWeaning: calvesReadyForWeaning.slice(0, 20),
                counts: {
                    insemination: cowsNeedingInsemination.length,
                    calving: cowsDueForCalving.length,
                    graduation: calvesReadyForGraduation.length,
                    weaning: calvesReadyForWeaning.length
                }
            }
        });

    } catch (error) {
        console.error('Community dashboard error:', error);
        res.status(500).render('error', {
            title: 'Error',
            message: 'Failed to load community dashboard.',
            error: { status: 500 }
        });
    }
});

/**
 * GET /community/members - List community members
 */
router.get('/members', isAdmin, async (req, res) => {
    try {
        if (!req.communityId) {
            return res.redirect('/select-community');
        }

        const community = await Community.findById(req.communityId).lean();
        
        if (!community) {
            return res.status(404).render('error', {
                title: 'Not Found',
                message: 'Community not found.',
                error: { status: 404 }
            });
        }

        // Get all members of this community
        const members = await User.find({ 'memberships.community': community._id })
            .select('firstName lastName email memberships isActive lastLogin createdAt')
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

        res.render('community/members', {
            title: `${community.name} - Members`,
            community,
            members: membersWithRoles,
            success: req.query.success || null,
            error: req.query.error || null
        });

    } catch (error) {
        console.error('List members error:', error);
        res.status(500).render('error', {
            title: 'Error',
            message: 'Failed to load members.',
            error: { status: 500 }
        });
    }
});

/**
 * GET /community/members/create - Show create member form
 */
router.get('/members/create', isAdmin, async (req, res) => {
    try {
        if (!req.communityId) {
            return res.redirect('/select-community');
        }

        const community = await Community.findById(req.communityId).lean();

        res.render('community/member-form', {
            title: `Add Member - ${community.name}`,
            community,
            member: null,
            isNewUser: true,
            error: null
        });

    } catch (error) {
        console.error('Create member form error:', error);
        res.status(500).render('error', {
            title: 'Error',
            message: 'Failed to load form.',
            error: { status: 500 }
        });
    }
});

/**
 * POST /community/members/create - Create new member (and user if needed)
 */
router.post('/members/create', isAdmin, async (req, res) => {
    try {
        if (!req.communityId) {
            return res.redirect('/select-community');
        }

        const community = await Community.findById(req.communityId).lean();
        const { email, password, firstName, lastName, communityRole, existingUser } = req.body;

        // Validate required fields
        if (!email) {
            return res.render('community/member-form', {
                title: `Add Member - ${community.name}`,
                community,
                member: req.body,
                isNewUser: true,
                error: 'Email is required.'
            });
        }

        let user = await User.findOne({ email: email.toLowerCase() });

        if (existingUser === 'on' || existingUser === 'true') {
            // Adding existing user to community
            if (!user) {
                return res.render('community/member-form', {
                    title: `Add Member - ${community.name}`,
                    community,
                    member: req.body,
                    isNewUser: false,
                    error: 'No user found with that email address.'
                });
            }

            // Check if already a member
            const existingMembership = user.memberships.find(
                m => m.community.toString() === community._id.toString()
            );

            if (existingMembership) {
                return res.render('community/member-form', {
                    title: `Add Member - ${community.name}`,
                    community,
                    member: req.body,
                    isNewUser: false,
                    error: 'This user is already a member of this community.'
                });
            }
        } else {
            // Creating new user
            if (user) {
                return res.render('community/member-form', {
                    title: `Add Member - ${community.name}`,
                    community,
                    member: req.body,
                    isNewUser: true,
                    error: 'A user with this email already exists. Check "Add existing user" to add them.'
                });
            }

            if (!password || !firstName || !lastName) {
                return res.render('community/member-form', {
                    title: `Add Member - ${community.name}`,
                    community,
                    member: req.body,
                    isNewUser: true,
                    error: 'Password, first name, and last name are required for new users.'
                });
            }

            if (password.length < 8) {
                return res.render('community/member-form', {
                    title: `Add Member - ${community.name}`,
                    community,
                    member: req.body,
                    isNewUser: true,
                    error: 'Password must be at least 8 characters.'
                });
            }

            // Create new user
            user = new User({
                email: email.toLowerCase(),
                password,
                firstName,
                lastName,
                role: 'User'
            });
        }

        // Add membership to community
        user.memberships.push({
            community: community._id,
            role: communityRole || 'Member'
        });

        await user.save();

        res.redirect(`/community/members?success=Member added successfully`);

    } catch (error) {
        console.error('Create member error:', error);
        const community = await Community.findById(req.communityId).lean();
        res.render('community/member-form', {
            title: `Add Member - ${community.name}`,
            community,
            member: req.body,
            isNewUser: true,
            error: 'Failed to create member. Please try again.'
        });
    }
});

/**
 * POST /community/members/:userId/update-role - Update member's role
 */
router.post('/members/:userId/update-role', isAdmin, async (req, res) => {
    try {
        if (!req.communityId) {
            return res.redirect('/select-community');
        }

        const { communityRole } = req.body;
        const user = await User.findById(req.params.userId);

        if (!user) {
            return res.redirect('/community/members?error=User not found');
        }

        const membership = user.memberships.find(
            m => m.community.toString() === req.communityId.toString()
        );

        if (!membership) {
            return res.redirect('/community/members?error=User is not a member of this community');
        }

        // Check if this is the owner (can't demote owner)
        const community = await Community.findById(req.communityId);
        if (community.owner.toString() === user._id.toString() && communityRole !== 'Admin') {
            return res.redirect('/community/members?error=Cannot change the owner\'s role');
        }

        membership.role = communityRole;
        await user.save();

        res.redirect('/community/members?success=Role updated successfully');

    } catch (error) {
        console.error('Update role error:', error);
        res.redirect('/community/members?error=Failed to update role');
    }
});

/**
 * POST /community/members/:userId/remove - Remove member from community
 */
router.post('/members/:userId/remove', isAdmin, async (req, res) => {
    try {
        if (!req.communityId) {
            return res.redirect('/select-community');
        }

        const user = await User.findById(req.params.userId);

        if (!user) {
            return res.redirect('/community/members?error=User not found');
        }

        // Check if this is the owner (can't remove owner)
        const community = await Community.findById(req.communityId);
        if (community.owner.toString() === user._id.toString()) {
            return res.redirect('/community/members?error=Cannot remove the owner from the community');
        }

        // Remove membership
        user.memberships = user.memberships.filter(
            m => m.community.toString() !== req.communityId.toString()
        );
        await user.save();

        res.redirect('/community/members?success=Member removed successfully');

    } catch (error) {
        console.error('Remove member error:', error);
        res.redirect('/community/members?error=Failed to remove member');
    }
});

/**
 * GET /community/settings - Community settings page
 */
router.get('/settings', isAdmin, async (req, res) => {
    try {
        if (!req.communityId) {
            return res.redirect('/select-community');
        }

        const community = await Community.findById(req.communityId).lean();

        if (!community) {
            return res.status(404).render('error', {
                title: 'Not Found',
                message: 'Community not found.',
                error: { status: 404 }
            });
        }

        res.render('community/settings', {
            title: `${community.name} - Settings`,
            community,
            success: req.query.success || null,
            error: req.query.error || null
        });

    } catch (error) {
        console.error('Settings page error:', error);
        res.status(500).render('error', {
            title: 'Error',
            message: 'Failed to load settings.',
            error: { status: 500 }
        });
    }
});

/**
 * POST /community/settings - Update community settings
 */
router.post('/settings', isAdmin, async (req, res) => {
    try {
        if (!req.communityId) {
            return res.redirect('/select-community');
        }

        const community = await Community.findById(req.communityId);

        if (!community) {
            return res.status(404).render('error', {
                title: 'Not Found',
                message: 'Community not found.',
                error: { status: 404 }
            });
        }

        const {
            name, description, contactPhone, contactEmail,
            street, city, state, country, postalCode,
            primaryColor, secondaryColor, accentColor,
            allowMemberInvites, requireApproval, maxMembers
        } = req.body;

        // Update basic info
        if (name) community.name = name;
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

        // Update theme
        if (primaryColor) community.theme.primaryColor = primaryColor;
        if (secondaryColor) community.theme.secondaryColor = secondaryColor;
        if (accentColor) community.theme.accentColor = accentColor;

        // Update settings
        community.settings.allowMemberInvites = allowMemberInvites === 'on';
        community.settings.requireApproval = requireApproval !== 'off';
        if (maxMembers) community.settings.maxMembers = parseInt(maxMembers) || 50;

        await community.save();

        res.redirect('/community/settings?success=Settings updated successfully');

    } catch (error) {
        console.error('Update settings error:', error);
        res.redirect('/community/settings?error=Failed to update settings');
    }
});

/**
 * POST /community/settings/cattle - Update cattle-specific settings
 */
router.post('/settings/cattle', isAdmin, async (req, res) => {
    try {
        if (!req.communityId) {
            return res.redirect('/select-community');
        }

        const community = await Community.findById(req.communityId);

        if (!community) {
            return res.status(404).render('error', {
                title: 'Not Found',
                message: 'Community not found.',
                error: { status: 404 }
            });
        }

        const {
            gestationDays, dryOffAfterSuccessfulInsemDays, changeFeedAfterSuccessfulInsemDays,
            postpartumInseminationStartDays, inseminationIntervalDays,
            calvingAlertBeforeDays, dryOffAlertBeforeDays, changeFeedAlertBeforeDays,
            pregnancyCheckAlertBeforeDays, inseminationAlertBeforeDays,
            graduationAlertBeforeDays, weaningAlertBeforeDays,
            femaleWeaningDays, maleWeaningDays,
            femaleMaturityMonths, maleMaturityMonths
        } = req.body;

        // Update cattle settings
        community.cattleSettings = {
            gestationDays: parseInt(gestationDays) || 283,
            dryOffAfterSuccessfulInsemDays: parseInt(dryOffAfterSuccessfulInsemDays) || 220,
            changeFeedAfterSuccessfulInsemDays: parseInt(changeFeedAfterSuccessfulInsemDays) || 210,
            postpartumInseminationStartDays: parseInt(postpartumInseminationStartDays) || 45,
            inseminationIntervalDays: parseInt(inseminationIntervalDays) || 21,
            calvingAlertBeforeDays: parseInt(calvingAlertBeforeDays) || 7,
            dryOffAlertBeforeDays: parseInt(dryOffAlertBeforeDays) || 7,
            changeFeedAlertBeforeDays: parseInt(changeFeedAlertBeforeDays) || 7,
            pregnancyCheckAlertBeforeDays: parseInt(pregnancyCheckAlertBeforeDays) || 7,
            inseminationAlertBeforeDays: parseInt(inseminationAlertBeforeDays) || 7,
            graduationAlertBeforeDays: parseInt(graduationAlertBeforeDays) || 30,
            weaningAlertBeforeDays: parseInt(weaningAlertBeforeDays) || 7,
            femaleWeaningDays: parseInt(femaleWeaningDays) || 60,
            maleWeaningDays: parseInt(maleWeaningDays) || 60,
            femaleMaturityMonths: parseInt(femaleMaturityMonths) || 24,
            maleMaturityMonths: parseInt(maleMaturityMonths) || 24
        };

        await community.save();

        res.redirect('/community/settings?success=Cattle settings updated successfully');

    } catch (error) {
        console.error('Update cattle settings error:', error);
        res.redirect('/community/settings?error=Failed to update cattle settings');
    }
});

// ============== IMPORT / EXPORT ROUTES ==============

/**
 * GET /community/data - Data management page (import/export)
 */
router.get('/data', isAdmin, async (req, res) => {
    try {
        if (!req.communityId) {
            return res.redirect('/select-community');
        }

        const community = await Community.findById(req.communityId).lean();
        if (!community) {
            return res.status(404).render('error', {
                title: 'Not Found',
                message: 'Community not found.',
                error: { status: 404 }
            });
        }

        // Get counts for display
        const Cow = mongoose.model('Cow');
        const Bull = mongoose.model('Bull');
        const Calf = mongoose.model('Calf');
        const Insemination = mongoose.model('Insemination');
        const Audit = mongoose.model('Audit');
        const Settings = mongoose.model('Settings');

        const [cowCount, bullCount, calfCount, insemCount, auditCount] = await Promise.all([
            Cow.countDocuments({ community: community._id }),
            Bull.countDocuments({ community: community._id }),
            Calf.countDocuments({ community: community._id }),
            Insemination.countDocuments({ community: community._id }),
            Audit.countDocuments({ community: community._id })
        ]);

        res.render('community/data', {
            title: 'Data Management',
            community,
            counts: { cows: cowCount, bulls: bullCount, calves: calfCount, inseminations: insemCount, audits: auditCount }
        });

    } catch (error) {
        console.error('Data management page error:', error);
        res.status(500).render('error', {
            title: 'Error',
            message: 'Failed to load data management page.',
            error: { status: 500 }
        });
    }
});

/**
 * GET /community/export/:type - Export data as JSON
 * Types: all, settings, cows, bulls, calves
 */
router.get('/export/:type', isAdmin, async (req, res) => {
    try {
        if (!req.communityId) {
            return res.status(400).json({ error: 'No community selected' });
        }

        const { type } = req.params;
        const communityId = req.communityId;

        const Cow = mongoose.model('Cow');
        const Bull = mongoose.model('Bull');
        const Calf = mongoose.model('Calf');
        const Insemination = mongoose.model('Insemination');
        const Audit = mongoose.model('Audit');
        const Confirmation = mongoose.model('Confirmation');
        const Settings = mongoose.model('Settings');

        const exportData = {
            exportedAt: new Date().toISOString(),
            exportType: type,
            version: '1.0',
            communityName: (await Community.findById(communityId).lean())?.name || 'Unknown'
        };

        if (type === 'all' || type === 'settings') {
            const settings = await Settings.findOne({ community: communityId }).lean();
            exportData.settings = settings ? {
                gestationDays: settings.gestationDays,
                dryOffAfterSuccessfulInsemDays: settings.dryOffAfterSuccessfulInsemDays,
                changeFeedAfterSuccessfulInsemDays: settings.changeFeedAfterSuccessfulInsemDays,
                postpartumInseminationStartDays: settings.postpartumInseminationStartDays,
                inseminationIntervalDays: settings.inseminationIntervalDays,
                calvingAlertBeforeDays: settings.calvingAlertBeforeDays,
                dryOffAlertBeforeDays: settings.dryOffAlertBeforeDays,
                changeFeedAlertBeforeDays: settings.changeFeedAlertBeforeDays,
                pregnancyCheckAlertBeforeDays: settings.pregnancyCheckAlertBeforeDays,
                inseminationAlertBeforeDays: settings.inseminationAlertBeforeDays,
                graduationAlertBeforeDays: settings.graduationAlertBeforeDays,
                weaningAlertBeforeDays: settings.weaningAlertBeforeDays,
                femaleWeaningDays: settings.femaleWeaningDays,
                maleWeaningDays: settings.maleWeaningDays,
                femaleMaturityMonths: settings.femaleMaturityMonths,
                maleMaturityMonths: settings.maleMaturityMonths
            } : null;
        }

        if (type === 'all' || type === 'cows') {
            const cows = await Cow.find({ community: communityId }).lean();
            const cowIds = cows.map(c => c._id);
            const inseminations = await Insemination.find({ cowId: { $in: cowIds } }).lean();
            const audits = await Audit.find({ cowId: { $in: cowIds } }).lean();
            const cowConfirmations = await Confirmation.find({ entityType: 'cow', entityId: { $in: cowIds } }).lean();

            // Group inseminations, audits, and confirmations by cowId
            const insemByCow = {};
            const auditByCow = {};
            const confirmByCow = {};
            inseminations.forEach(i => {
                const k = i.cowId.toString();
                if (!insemByCow[k]) insemByCow[k] = [];
                insemByCow[k].push({
                    date: i.date,
                    confirmedPregnant: i.confirmedPregnant,
                    failed: i.failed,
                    forced: i.forced,
                    notes: i.notes
                });
            });
            audits.forEach(a => {
                const k = a.cowId.toString();
                if (!auditByCow[k]) auditByCow[k] = [];
                auditByCow[k].push({
                    action: a.action,
                    actor: a.actor,
                    at: a.at,
                    payload: a.payload
                });
            });
            cowConfirmations.forEach(c => {
                const k = c.entityId.toString();
                if (!confirmByCow[k]) confirmByCow[k] = [];
                confirmByCow[k].push({
                    type: c.type,
                    when: c.when,
                    alertOn: c.alertOn,
                    note: c.note,
                    undone: c.undone
                });
            });

            exportData.cows = cows.map(c => ({
                cowNumber: c.cowNumber,
                cowName: c.cowName,
                race: c.race,
                dob: c.dob,
                lastCalving: c.lastCalving,
                notes: c.notes,
                profileImageUrl: c.profileImageUrl,
                motherCowNumber: c.motherCowNumber,
                motherCowName: c.motherCowName,
                motherCowBreed: c.motherCowBreed,
                sireBullNumber: c.sireBullNumber,
                sireBullName: c.sireBullName,
                sireBullBreed: c.sireBullBreed,
                inseminations: insemByCow[c._id.toString()] || [],
                history: auditByCow[c._id.toString()] || [],
                confirmations: confirmByCow[c._id.toString()] || []
            }));
        }

        if (type === 'all' || type === 'bulls') {
            const bulls = await Bull.find({ community: communityId }).lean();
            const bullIds = bulls.map(b => b._id);
            const bullConfirmations = await Confirmation.find({ entityType: 'bull', entityId: { $in: bullIds } }).lean();
            
            // Group confirmations by bullId
            const confirmByBull = {};
            bullConfirmations.forEach(c => {
                const k = c.entityId.toString();
                if (!confirmByBull[k]) confirmByBull[k] = [];
                confirmByBull[k].push({
                    type: c.type,
                    when: c.when,
                    alertOn: c.alertOn,
                    note: c.note,
                    undone: c.undone
                });
            });
            
            exportData.bulls = bulls.map(b => ({
                bullNumber: b.bullNumber,
                bullName: b.bullName,
                race: b.race,
                dob: b.dob,
                notes: b.notes,
                profileImageUrl: b.profileImageUrl,
                motherCowNumber: b.motherCowNumber,
                motherCowName: b.motherCowName,
                motherCowBreed: b.motherCowBreed,
                sireBullNumber: b.sireBullNumber,
                sireBullName: b.sireBullName,
                sireBullBreed: b.sireBullBreed,
                isInsemination: b.isInsemination,
                confirmations: confirmByBull[b._id.toString()] || []
            }));
        }

        if (type === 'all' || type === 'calves') {
            const calves = await Calf.find({ community: communityId }).lean();
            const calfIds = calves.map(c => c._id);
            const calfConfirmations = await Confirmation.find({ entityType: 'calf', entityId: { $in: calfIds } }).lean();
            
            // Group confirmations by calfId
            const confirmByCalf = {};
            calfConfirmations.forEach(c => {
                const k = c.entityId.toString();
                if (!confirmByCalf[k]) confirmByCalf[k] = [];
                confirmByCalf[k].push({
                    type: c.type,
                    when: c.when,
                    alertOn: c.alertOn,
                    note: c.note,
                    undone: c.undone
                });
            });
            
            exportData.calves = calves.map(c => ({
                calfName: c.calfName,
                calfBreed: c.calfBreed,
                birthDate: c.birthDate,
                gender: c.gender,
                status: c.status,
                notes: c.notes,
                profileImageUrl: c.profileImageUrl,
                motherCowNumber: c.motherCowNumber,
                motherCowName: c.motherCowName,
                motherCowBreed: c.motherCowBreed,
                sireBullNumber: c.sireBullNumber,
                sireBullName: c.sireBullName,
                sireBullBreed: c.sireBullBreed,
                graduated: c.graduated,
                graduatedAt: c.graduatedAt,
                adultType: c.adultType,
                confirmations: confirmByCalf[c._id.toString()] || []
            }));
        }

        const community = await Community.findById(communityId).lean();
        const filename = `${community?.name?.replace(/[^a-z0-9]/gi, '_') || 'farm'}_${type}_${new Date().toISOString().slice(0,10)}.json`;

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.json(exportData);

    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ error: 'Failed to export data' });
    }
});

/**
 * POST /community/import/preview - Preview import data and detect duplicates
 */
router.post('/import/preview', isAdmin, async (req, res) => {
    try {
        if (!req.communityId) {
            return res.status(400).json({ error: 'No community selected' });
        }

        const importData = req.body;
        const communityId = req.communityId;

        if (!importData || !importData.version) {
            return res.status(400).json({ error: 'Invalid import file format' });
        }

        const Cow = mongoose.model('Cow');
        const Bull = mongoose.model('Bull');
        const Calf = mongoose.model('Calf');

        const preview = {
            settings: null,
            cows: { new: [], duplicates: [] },
            bulls: { new: [], duplicates: [] },
            calves: { new: [], duplicates: [] }
        };

        // Check settings
        if (importData.settings) {
            preview.settings = importData.settings;
        }

        // Check cows for duplicates (by cowNumber)
        if (importData.cows && Array.isArray(importData.cows)) {
            const existingCows = await Cow.find({ community: communityId }).lean();
            const existingByNumber = {};
            const existingByName = {};
            existingCows.forEach(c => {
                if (c.cowNumber) existingByNumber[c.cowNumber.toLowerCase()] = c;
                if (c.cowName) existingByName[c.cowName.toLowerCase()] = c;
            });

            for (const cow of importData.cows) {
                const matchByNumber = cow.cowNumber ? existingByNumber[cow.cowNumber.toLowerCase()] : null;
                const matchByName = cow.cowName ? existingByName[cow.cowName.toLowerCase()] : null;
                const existing = matchByNumber || matchByName;

                if (existing) {
                    preview.cows.duplicates.push({
                        incoming: cow,
                        existing: {
                            _id: existing._id,
                            cowNumber: existing.cowNumber,
                            cowName: existing.cowName,
                            race: existing.race,
                            dob: existing.dob
                        },
                        matchedBy: matchByNumber ? 'number' : 'name'
                    });
                } else {
                    preview.cows.new.push(cow);
                }
            }
        }

        // Check bulls for duplicates (by bullNumber)
        if (importData.bulls && Array.isArray(importData.bulls)) {
            const existingBulls = await Bull.find({ community: communityId }).lean();
            const existingByNumber = {};
            const existingByName = {};
            existingBulls.forEach(b => {
                if (b.bullNumber) existingByNumber[b.bullNumber.toLowerCase()] = b;
                if (b.bullName) existingByName[b.bullName.toLowerCase()] = b;
            });

            for (const bull of importData.bulls) {
                const matchByNumber = bull.bullNumber ? existingByNumber[bull.bullNumber.toLowerCase()] : null;
                const matchByName = bull.bullName ? existingByName[bull.bullName.toLowerCase()] : null;
                const existing = matchByNumber || matchByName;

                if (existing) {
                    preview.bulls.duplicates.push({
                        incoming: bull,
                        existing: {
                            _id: existing._id,
                            bullNumber: existing.bullNumber,
                            bullName: existing.bullName,
                            race: existing.race,
                            dob: existing.dob
                        },
                        matchedBy: matchByNumber ? 'number' : 'name'
                    });
                } else {
                    preview.bulls.new.push(bull);
                }
            }
        }

        // Check calves for duplicates (by calfName + birthDate)
        if (importData.calves && Array.isArray(importData.calves)) {
            const existingCalves = await Calf.find({ community: communityId }).lean();
            const existingByKey = {};
            existingCalves.forEach(c => {
                const key = `${(c.calfName || '').toLowerCase()}_${c.birthDate ? new Date(c.birthDate).toISOString().slice(0,10) : ''}`;
                existingByKey[key] = c;
            });

            for (const calf of importData.calves) {
                const key = `${(calf.calfName || '').toLowerCase()}_${calf.birthDate ? new Date(calf.birthDate).toISOString().slice(0,10) : ''}`;
                const existing = existingByKey[key];

                if (existing) {
                    preview.calves.duplicates.push({
                        incoming: calf,
                        existing: {
                            _id: existing._id,
                            calfName: existing.calfName,
                            calfBreed: existing.calfBreed,
                            birthDate: existing.birthDate,
                            gender: existing.gender
                        },
                        matchedBy: 'name+birthDate'
                    });
                } else {
                    preview.calves.new.push(calf);
                }
            }
        }

        res.json(preview);

    } catch (error) {
        console.error('Import preview error:', error);
        res.status(500).json({ error: 'Failed to preview import' });
    }
});

/**
 * POST /community/import/execute - Execute the import with duplicate decisions
 */
router.post('/import/execute', isAdmin, async (req, res) => {
    try {
        if (!req.communityId) {
            return res.status(400).json({ error: 'No community selected' });
        }

        const { importData, decisions } = req.body;
        // decisions = { 
        //   mode: 'overwrite-all' | 'keep-all' | 'selective',
        //   cows: { [index]: 'replace' | 'skip' },
        //   bulls: { [index]: 'replace' | 'skip' },
        //   calves: { [index]: 'replace' | 'skip' }
        // }

        if (!importData || !decisions) {
            return res.status(400).json({ error: 'Invalid request' });
        }

        const communityId = req.communityId;
        const Cow = mongoose.model('Cow');
        const Bull = mongoose.model('Bull');
        const Calf = mongoose.model('Calf');
        const Insemination = mongoose.model('Insemination');
        const Audit = mongoose.model('Audit');
        const Confirmation = mongoose.model('Confirmation');
        const Settings = mongoose.model('Settings');

        const results = {
            settings: false,
            cows: { created: 0, updated: 0, skipped: 0 },
            bulls: { created: 0, updated: 0, skipped: 0 },
            calves: { created: 0, updated: 0, skipped: 0 }
        };

        // Import settings
        if (importData.settings) {
            // Remove _id and __v to avoid trying to update immutable fields
            const { _id, __v, ...settingsData } = importData.settings;
            await Settings.findOneAndUpdate(
                { community: communityId },
                { ...settingsData, community: communityId },
                { upsert: true }
            );
            results.settings = true;
        }

        // Helper to check if should replace
        const shouldReplace = (type, index, hasDuplicate) => {
            if (!hasDuplicate) return false;
            if (decisions.mode === 'overwrite-all') return true;
            if (decisions.mode === 'keep-all') return false;
            return decisions[type]?.[index] === 'replace';
        };

        // Import cows
        if (importData.cows && Array.isArray(importData.cows)) {
            const existingCows = await Cow.find({ community: communityId }).lean();
            const existingByNumber = {};
            const existingByName = {};
            existingCows.forEach(c => {
                if (c.cowNumber) existingByNumber[c.cowNumber.toLowerCase()] = c;
                if (c.cowName) existingByName[c.cowName.toLowerCase()] = c;
            });

            for (let i = 0; i < importData.cows.length; i++) {
                const cow = importData.cows[i];
                const matchByNumber = cow.cowNumber ? existingByNumber[cow.cowNumber.toLowerCase()] : null;
                const matchByName = cow.cowName ? existingByName[cow.cowName.toLowerCase()] : null;
                const existing = matchByNumber || matchByName;

                if (existing) {
                    if (shouldReplace('cows', i, true)) {
                        // Update existing cow
                        await Cow.findByIdAndUpdate(existing._id, {
                            cowNumber: cow.cowNumber,
                            cowName: cow.cowName,
                            race: cow.race,
                            dob: cow.dob ? new Date(cow.dob) : undefined,
                            lastCalving: cow.lastCalving ? new Date(cow.lastCalving) : undefined,
                            notes: cow.notes,
                            motherCowNumber: cow.motherCowNumber,
                            motherCowName: cow.motherCowName,
                            motherCowBreed: cow.motherCowBreed,
                            sireBullNumber: cow.sireBullNumber,
                            sireBullName: cow.sireBullName,
                            sireBullBreed: cow.sireBullBreed
                        });

                        // Replace inseminations if included
                        if (cow.inseminations && cow.inseminations.length > 0) {
                            await Insemination.deleteMany({ cowId: existing._id, community: communityId });
                            for (const ins of cow.inseminations) {
                                await Insemination.create({
                                    cowId: existing._id,
                                    community: communityId,
                                    date: new Date(ins.date),
                                    confirmedPregnant: ins.confirmedPregnant,
                                    failed: ins.failed,
                                    forced: ins.forced,
                                    notes: ins.notes
                                });
                            }
                        }

                        // Replace history/audits if included
                        if (cow.history && cow.history.length > 0) {
                            await Audit.deleteMany({ cowId: existing._id, community: communityId });
                            for (const audit of cow.history) {
                                await Audit.create({
                                    cowId: existing._id,
                                    community: communityId,
                                    action: audit.action,
                                    actor: audit.actor || 'import',
                                    at: audit.at ? new Date(audit.at) : new Date(),
                                    payload: audit.payload
                                });
                            }
                        }

                        // Replace confirmations if included
                        if (cow.confirmations && cow.confirmations.length > 0) {
                            await Confirmation.deleteMany({ entityType: 'cow', entityId: existing._id });
                            for (const conf of cow.confirmations) {
                                await Confirmation.create({
                                    community: communityId,
                                    entityType: 'cow',
                                    entityId: existing._id,
                                    type: conf.type,
                                    when: conf.when ? new Date(conf.when) : undefined,
                                    alertOn: conf.alertOn ? new Date(conf.alertOn) : undefined,
                                    note: conf.note,
                                    undone: conf.undone
                                });
                            }
                        }

                        results.cows.updated++;
                    } else {
                        results.cows.skipped++;
                    }
                } else {
                    // Create new cow
                    const newCow = await Cow.create({
                        community: communityId,
                        cowNumber: cow.cowNumber,
                        cowName: cow.cowName,
                        race: cow.race,
                        dob: cow.dob ? new Date(cow.dob) : undefined,
                        lastCalving: cow.lastCalving ? new Date(cow.lastCalving) : undefined,
                        notes: cow.notes,
                        motherCowNumber: cow.motherCowNumber,
                        motherCowName: cow.motherCowName,
                        motherCowBreed: cow.motherCowBreed,
                        sireBullNumber: cow.sireBullNumber,
                        sireBullName: cow.sireBullName,
                        sireBullBreed: cow.sireBullBreed
                    });

                    // Create inseminations
                    if (cow.inseminations && cow.inseminations.length > 0) {
                        for (const ins of cow.inseminations) {
                            await Insemination.create({
                                cowId: newCow._id,
                                community: communityId,
                                date: new Date(ins.date),
                                confirmedPregnant: ins.confirmedPregnant,
                                failed: ins.failed,
                                forced: ins.forced,
                                notes: ins.notes
                            });
                        }
                    }

                    // Create history/audits
                    if (cow.history && cow.history.length > 0) {
                        for (const audit of cow.history) {
                            await Audit.create({
                                cowId: newCow._id,
                                community: communityId,
                                action: audit.action,
                                actor: audit.actor || 'import',
                                at: audit.at ? new Date(audit.at) : new Date(),
                                payload: audit.payload
                            });
                        }
                    }

                    // Create confirmations
                    if (cow.confirmations && cow.confirmations.length > 0) {
                        for (const conf of cow.confirmations) {
                            await Confirmation.create({
                                community: communityId,
                                entityType: 'cow',
                                entityId: newCow._id,
                                type: conf.type,
                                when: conf.when ? new Date(conf.when) : undefined,
                                alertOn: conf.alertOn ? new Date(conf.alertOn) : undefined,
                                note: conf.note,
                                undone: conf.undone
                            });
                        }
                    }

                    results.cows.created++;
                }
            }
        }

        // Import bulls
        if (importData.bulls && Array.isArray(importData.bulls)) {
            const existingBulls = await Bull.find({ community: communityId }).lean();
            const existingByNumber = {};
            const existingByName = {};
            existingBulls.forEach(b => {
                if (b.bullNumber) existingByNumber[b.bullNumber.toLowerCase()] = b;
                if (b.bullName) existingByName[b.bullName.toLowerCase()] = b;
            });

            for (let i = 0; i < importData.bulls.length; i++) {
                const bull = importData.bulls[i];
                const matchByNumber = bull.bullNumber ? existingByNumber[bull.bullNumber.toLowerCase()] : null;
                const matchByName = bull.bullName ? existingByName[bull.bullName.toLowerCase()] : null;
                const existing = matchByNumber || matchByName;

                if (existing) {
                    if (shouldReplace('bulls', i, true)) {
                        await Bull.findByIdAndUpdate(existing._id, {
                            bullNumber: bull.bullNumber,
                            bullName: bull.bullName,
                            race: bull.race,
                            dob: bull.dob ? new Date(bull.dob) : undefined,
                            notes: bull.notes,
                            motherCowNumber: bull.motherCowNumber,
                            motherCowName: bull.motherCowName,
                            motherCowBreed: bull.motherCowBreed,
                            sireBullNumber: bull.sireBullNumber,
                            sireBullName: bull.sireBullName,
                            sireBullBreed: bull.sireBullBreed,
                            isInsemination: bull.isInsemination
                        });

                        // Replace confirmations if included
                        if (bull.confirmations && bull.confirmations.length > 0) {
                            await Confirmation.deleteMany({ entityType: 'bull', entityId: existing._id });
                            for (const conf of bull.confirmations) {
                                await Confirmation.create({
                                    community: communityId,
                                    entityType: 'bull',
                                    entityId: existing._id,
                                    type: conf.type,
                                    when: conf.when ? new Date(conf.when) : undefined,
                                    alertOn: conf.alertOn ? new Date(conf.alertOn) : undefined,
                                    note: conf.note,
                                    undone: conf.undone
                                });
                            }
                        }

                        results.bulls.updated++;
                    } else {
                        results.bulls.skipped++;
                    }
                } else {
                    const newBull = await Bull.create({
                        community: communityId,
                        bullNumber: bull.bullNumber,
                        bullName: bull.bullName,
                        race: bull.race,
                        dob: bull.dob ? new Date(bull.dob) : undefined,
                        notes: bull.notes,
                        motherCowNumber: bull.motherCowNumber,
                        motherCowName: bull.motherCowName,
                        motherCowBreed: bull.motherCowBreed,
                        sireBullNumber: bull.sireBullNumber,
                        sireBullName: bull.sireBullName,
                        sireBullBreed: bull.sireBullBreed,
                        isInsemination: bull.isInsemination
                    });

                    // Create confirmations
                    if (bull.confirmations && bull.confirmations.length > 0) {
                        for (const conf of bull.confirmations) {
                            await Confirmation.create({
                                community: communityId,
                                entityType: 'bull',
                                entityId: newBull._id,
                                type: conf.type,
                                when: conf.when ? new Date(conf.when) : undefined,
                                alertOn: conf.alertOn ? new Date(conf.alertOn) : undefined,
                                note: conf.note,
                                undone: conf.undone
                            });
                        }
                    }

                    results.bulls.created++;
                }
            }
        }

        // Import calves
        if (importData.calves && Array.isArray(importData.calves)) {
            const existingCalves = await Calf.find({ community: communityId }).lean();
            const existingByKey = {};
            existingCalves.forEach(c => {
                const key = `${(c.calfName || '').toLowerCase()}_${c.birthDate ? new Date(c.birthDate).toISOString().slice(0,10) : ''}`;
                existingByKey[key] = c;
            });

            for (let i = 0; i < importData.calves.length; i++) {
                const calf = importData.calves[i];
                const key = `${(calf.calfName || '').toLowerCase()}_${calf.birthDate ? new Date(calf.birthDate).toISOString().slice(0,10) : ''}`;
                const existing = existingByKey[key];

                if (existing) {
                    if (shouldReplace('calves', i, true)) {
                        await Calf.findByIdAndUpdate(existing._id, {
                            calfName: calf.calfName,
                            calfBreed: calf.calfBreed,
                            birthDate: calf.birthDate ? new Date(calf.birthDate) : undefined,
                            gender: calf.gender,
                            status: calf.status,
                            notes: calf.notes,
                            motherCowNumber: calf.motherCowNumber,
                            motherCowName: calf.motherCowName,
                            motherCowBreed: calf.motherCowBreed,
                            sireBullNumber: calf.sireBullNumber,
                            sireBullName: calf.sireBullName,
                            sireBullBreed: calf.sireBullBreed,
                            graduated: calf.graduated,
                            graduatedAt: calf.graduatedAt ? new Date(calf.graduatedAt) : undefined,
                            adultType: calf.adultType
                        });

                        // Replace confirmations if included
                        if (calf.confirmations && calf.confirmations.length > 0) {
                            await Confirmation.deleteMany({ entityType: 'calf', entityId: existing._id });
                            for (const conf of calf.confirmations) {
                                await Confirmation.create({
                                    community: communityId,
                                    entityType: 'calf',
                                    entityId: existing._id,
                                    type: conf.type,
                                    when: conf.when ? new Date(conf.when) : undefined,
                                    alertOn: conf.alertOn ? new Date(conf.alertOn) : undefined,
                                    note: conf.note,
                                    undone: conf.undone
                                });
                            }
                        }

                        results.calves.updated++;
                    } else {
                        results.calves.skipped++;
                    }
                } else {
                    const newCalf = await Calf.create({
                        community: communityId,
                        calfName: calf.calfName,
                        calfBreed: calf.calfBreed,
                        birthDate: calf.birthDate ? new Date(calf.birthDate) : undefined,
                        gender: calf.gender,
                        status: calf.status || 'alive',
                        notes: calf.notes,
                        motherCowNumber: calf.motherCowNumber,
                        motherCowName: calf.motherCowName,
                        motherCowBreed: calf.motherCowBreed,
                        sireBullNumber: calf.sireBullNumber,
                        sireBullName: calf.sireBullName,
                        sireBullBreed: calf.sireBullBreed,
                        graduated: calf.graduated,
                        graduatedAt: calf.graduatedAt ? new Date(calf.graduatedAt) : undefined,
                        adultType: calf.adultType
                    });

                    // Create confirmations
                    if (calf.confirmations && calf.confirmations.length > 0) {
                        for (const conf of calf.confirmations) {
                            await Confirmation.create({
                                community: communityId,
                                entityType: 'calf',
                                entityId: newCalf._id,
                                type: conf.type,
                                when: conf.when ? new Date(conf.when) : undefined,
                                alertOn: conf.alertOn ? new Date(conf.alertOn) : undefined,
                                note: conf.note,
                                undone: conf.undone
                            });
                        }
                    }

                    results.calves.created++;
                }
            }
        }

        res.json({ success: true, results });

    } catch (error) {
        console.error('Import execute error:', error);
        res.status(500).json({ error: 'Failed to execute import' });
    }
});

module.exports = router;
