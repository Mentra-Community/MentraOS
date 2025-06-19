import jwt from 'jsonwebtoken';
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET;
if (!AUGMENTOS_AUTH_JWT_SECRET) {
    throw new Error("AUGMENTOS_AUTH_JWT_SECRET is not defined");
}

/**
 * Generates a core token for a user with organization information
 * @param email - The user's email
 * @param sub - The subject identifier
 * @param organizations - Array of organization IDs the user belongs to
 * @param defaultOrg - The user's default organization ID
 * @returns The generated JWT token
 */
export async function generateCoreToken(
    email = "joe@mamas.house",
    sub = "1234567890",
    organizations = [],
    defaultOrg = null
): Promise<string> {
    // If organizations and defaultOrg aren't provided, try to fetch them
    if (!organizations.length || !defaultOrg) {
        try {
            // Dynamically import to avoid circular dependencies
            const { User } = require('../models/user.model');
            const user = await User.findByEmail(email);

            if (user) {
                organizations = user.organizations || [];
                defaultOrg = user.defaultOrg || null;
            }
        } catch (error) {
            console.error('Error fetching user organizations:', error);
            // Continue with empty organizations if there's an error
        }
    }

    const newData = {
        sub,
        email,
        organizations,
        defaultOrg
    };

    // Generate your own custom token (JWT or otherwise)
    const coreToken = jwt.sign(newData, AUGMENTOS_AUTH_JWT_SECRET as string);

    return coreToken;
}

export default generateCoreToken;