/**
 * Checks if a user is a Mentra team member based on their email
 * @param email - The user's email address
 * @returns true if the user is a Mentra team member, false otherwise
 */
export function isMentraUser(email: string | null | undefined): boolean {
  if (!email) return false

  // Check for @mentra.glass domain
  if (email.endsWith("@mentra.glass")) return true

  // Specific allowed emails
  const allowedEmails = ["julesreider@gmail.com", "jreider@luc.edu"]

  return allowedEmails.includes(email.toLowerCase())
}
