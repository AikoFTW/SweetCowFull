# Ferma Tech - Multi-Tenant Authentication System

## Overview

Ferma Tech now includes a complete multi-tenant authentication system that allows multiple farms (communities) to use the same platform while keeping their data isolated.

## Architecture

### Pattern: Shared Database with Community ID

- **One MongoDB database** for all data
- Every document includes a `community` field (ObjectId)
- All queries are filtered by community from the request context
- SuperAdmin can access all data across communities

## Roles

### SuperAdmin (Global)
- Full access to all communities and data
- Can create/edit/delete communities
- Can create/edit users and manage memberships
- Can view data from any community
- Access the admin dashboard at `/admin`

### Admin (Per Community)
- Full access to their assigned community's data
- Can manage settings for their community
- Cannot access other communities or admin functions

### Member (Per Community)
- View and interact with their assigned community's data
- Limited management capabilities

## File Structure

```
models/
├── user.js          # User model with memberships
├── community.js     # Community (Farm) model

middleware/
└── auth.js          # Authentication & authorization middleware

routes/
├── auth.js          # Login, register, logout routes
└── admin.js         # SuperAdmin management routes

views/
├── auth/
│   ├── login.ejs
│   └── register.ejs
├── admin/
│   ├── dashboard.ejs
│   ├── communities.ejs
│   ├── community-form.ejs
│   ├── community-detail.ejs
│   ├── users.ejs
│   ├── user-form.ejs
│   └── user-detail.ejs
├── select-community.ejs
└── error.ejs

scripts/
└── setup-admin.js   # Setup script for first SuperAdmin
```

## Getting Started

### 1. Setup First SuperAdmin

Run the setup script to create the first SuperAdmin:

```bash
npm run setup
```

This will prompt you to:
1. Enter admin details (name, email, password)
2. Optionally create a demo community

### 2. User Registration

New users can register at `/auth/register`. When registering:
- They provide personal info and create a password
- They name their farm (creates a new community)
- They become the Admin of their new community

### 3. Login

Users log in at `/auth/login` with email and password.

## Database Schema Updates

All existing models now include a `community` field:

```javascript
// Example: Cow schema
const cowSchema = new mongoose.Schema({
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', index: true },
    cowNumber: String,
    cowName: String,
    // ... other fields
});
```

### Affected Collections
- `cows`
- `calves`
- `bulls`
- `inseminations`
- `confirmations`
- `settings`
- `audits`

## Middleware

### `loadUser`
Loads the current user and community into request context.

### `isAuthenticated`
Ensures user is logged in, redirects to login if not.

### `isMember`
Ensures user is a member of the current community.

### `isAdmin`
Ensures user is an Admin of current community or SuperAdmin.

### `isSuperAdmin`
Ensures user is a SuperAdmin.

### `getCommunityFilter(req)`
Returns a MongoDB filter object for community-scoped queries:
- SuperAdmin without specific community: `{}` (all data)
- Others: `{ community: currentCommunityId }`

## API Routes

### Authentication
- `GET /auth/login` - Login page
- `POST /auth/login` - Process login
- `GET /auth/register` - Registration page
- `POST /auth/register` - Process registration
- `GET /auth/logout` - Logout
- `POST /auth/switch-community` - Switch active community

### Admin (SuperAdmin only)
- `GET /admin` - Admin dashboard
- `GET /admin/communities` - List communities
- `GET /admin/communities/create` - Create community form
- `POST /admin/communities/create` - Create community
- `GET /admin/communities/:id` - View community
- `GET /admin/communities/:id/edit` - Edit community form
- `POST /admin/communities/:id/edit` - Update community
- `POST /admin/communities/:id/delete` - Delete community
- `GET /admin/users` - List users
- `GET /admin/users/create` - Create user form
- `POST /admin/users/create` - Create user
- `GET /admin/users/:id` - View user
- `GET /admin/users/:id/edit` - Edit user form
- `POST /admin/users/:id/edit` - Update user
- `POST /admin/users/:id/toggle-status` - Toggle user active status
- `POST /admin/users/:id/add-membership` - Add user to community
- `POST /admin/users/:id/remove-membership` - Remove user from community

## Session Management

Sessions use `express-session` with:
- 7-day expiry for authenticated sessions
- Stored in memory (consider Redis for production)
- Session contains: `userId`, `communityId`

## Best Practices

### Always Filter by Community

When querying data in routes:

```javascript
const communityFilter = getCommunityFilter(req);
const cows = await Cow.find(communityFilter).lean();
```

### Creating New Documents

Always include the community ID:

```javascript
const newCow = new Cow({
    community: req.communityId,
    cowName: 'Bessie',
    // ... other fields
});
```

### SuperAdmin Cross-Community Queries

SuperAdmins can query specific communities:

```javascript
// From admin panel with specific community
const cows = await Cow.find({ community: specificCommunityId });
```

## Migration Notes

Existing data without a `community` field will need to be:
1. Assigned to a default community, OR
2. Migrated to appropriate communities

Consider creating a migration script for production deployments.

## Security Considerations

1. **Password Hashing**: Uses bcryptjs with salt rounds of 12
2. **Session Security**: Use secure cookies in production
3. **CSRF Protection**: Consider adding for production
4. **Rate Limiting**: Consider adding for login attempts
5. **Input Validation**: Validate all user inputs

## Environment Variables

```env
mongoURI=mongodb://localhost:27017/fermatech
OVERRIDE_SESSION_SECRET=your-secure-secret-key
```

For production, ensure strong session secrets and use HTTPS.
