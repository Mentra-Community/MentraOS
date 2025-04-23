import jwt from 'jsonwebtoken';
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET;
if (!AUGMENTOS_AUTH_JWT_SECRET) {
    throw new Error("AUGMENTOS_AUTH_JWT_SECRET is not defined");
}

export function generateCoreToken(email = "joe@mamas.house", sub ="1234567890"): string {
    const newData = { sub, email };

    // Generate your own custom token (JWT or otherwise)
    const coreToken = jwt.sign(newData, AUGMENTOS_AUTH_JWT_SECRET as string);

    return coreToken;
}

export default generateCoreToken;