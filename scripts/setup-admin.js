/**
 * Setup script to create the first SuperAdmin user
 * Run this after deploying the app for the first time
 * 
 * Usage: node scripts/setup-admin.js
 */

const dotenv = require('dotenv');
dotenv.config();

const mongoose = require('mongoose');
const readline = require('readline');

// Import models
const User = require('../models/user');
const Community = require('../models/community');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

async function setup() {
    try {
        // Connect to MongoDB
        await mongoose.connect(process.env.mongoURI || 'mongodb://localhost:27017/', {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('Connected to MongoDB\n');

        // Check if any SuperAdmin exists
        const existingSuperAdmin = await User.findOne({ role: 'SuperAdmin' });
        
        if (existingSuperAdmin) {
            console.log('⚠️  A SuperAdmin already exists:');
            console.log(`   Email: ${existingSuperAdmin.email}`);
            console.log(`   Name: ${existingSuperAdmin.firstName} ${existingSuperAdmin.lastName}`);
            
            const proceed = await question('\nDo you want to create another SuperAdmin? (yes/no): ');
            if (proceed.toLowerCase() !== 'yes') {
                console.log('\nSetup cancelled.');
                process.exit(0);
            }
        }

        console.log('=== Create SuperAdmin Account ===\n');

        // Collect user info
        const firstName = await question('First Name: ');
        const lastName = await question('Last Name: ');
        const email = await question('Email: ');
        const password = await question('Password (min 8 chars): ');

        if (!firstName || !lastName || !email || !password) {
            console.log('\n❌ All fields are required.');
            process.exit(1);
        }

        if (password.length < 8) {
            console.log('\n❌ Password must be at least 8 characters.');
            process.exit(1);
        }

        // Check if email exists
        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) {
            console.log('\n❌ A user with this email already exists.');
            process.exit(1);
        }

        // Create SuperAdmin
        const superAdmin = new User({
            firstName,
            lastName,
            email: email.toLowerCase(),
            password,
            role: 'SuperAdmin',
            isActive: true
        });

        await superAdmin.save();

        console.log('\n✅ SuperAdmin created successfully!');
        console.log(`   Email: ${superAdmin.email}`);
        console.log(`   Role: SuperAdmin`);
        console.log('\nYou can now log in at /auth/login\n');

        // Ask if they want to create a demo community
        const createDemo = await question('Would you like to create a demo community? (yes/no): ');
        
        if (createDemo.toLowerCase() === 'yes') {
            const farmName = await question('Farm Name (e.g., Green Valley Farm): ');
            
            if (farmName) {
                const slug = await Community.generateUniqueSlug(farmName);
                const community = new Community({
                    name: farmName,
                    slug,
                    owner: superAdmin._id,
                    description: 'Demo farm community'
                });
                
                await community.save();
                
                // Add SuperAdmin as Admin of the community
                superAdmin.memberships.push({
                    community: community._id,
                    role: 'Admin'
                });
                await superAdmin.save();
                
                console.log(`\n✅ Demo community "${farmName}" created!`);
            }
        }

        console.log('\n=== Setup Complete ===\n');

    } catch (error) {
        console.error('Setup error:', error);
    } finally {
        rl.close();
        mongoose.connection.close();
    }
}

setup();
