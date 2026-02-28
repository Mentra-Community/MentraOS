import {useState, useEffect} from "react"
import {useAuth} from "@mentra/shared"
import AccountLayout from "../components/AccountLayout"
import {toast} from "sonner"

const ProfilePage: React.FC = () => {
  const {user} = useAuth()
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [phoneNumber, setPhoneNumber] = useState("")

  // Load user data
  useEffect(() => {
    if (user) {
      // Initialize form with user metadata if available
      const metadata = user
      if (metadata) {
        setName(metadata.name || "")
        setDisplayName(metadata.name || "")
        setPhoneNumber(metadata.phoneNumber || "")
      }
    }
  }, [user])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    try {
      // This is a placeholder for the actual API call
      // In a real implementation, you would call your API service
      await new Promise((resolve) => setTimeout(resolve, 1000))

      toast.success("Profile updated successfully")
    } catch (error) {
      console.error("Error updating profile:", error)
      toast.error("Failed to update profile")
    } finally {
      setLoading(false)
    }
  }

  return (
    <AccountLayout>
      <div>
        <h1 className="text-2xl font-bold mb-6">Your Profile</h1>

        <div className="bg-blue-50 border border-blue-200 rounded-md p-4 mb-6">
          <div className="font-medium">Account Information</div>
          <div className="mt-2">
            <div>
              <span className="font-medium">Email:</span> {user?.email}
            </div>
            <div>
              <span className="font-medium">Account ID:</span> {user?.id}
            </div>
            <div>
              <span className="font-medium">Created at:</span>{" "}
              {user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : "Unknown"}
            </div>
          </div>
        </div>

        <div className="mt-6">
          <h2 className="text-xl font-semibold mb-4">Edit Profile</h2>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                Full Name
              </label>
              <input
                type="text"
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              />
            </div>

            <div>
              <label htmlFor="displayName" className="block text-sm font-medium text-gray-700">
                Display Name
              </label>
              <input
                type="text"
                id="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              />
            </div>

            <div>
              <label htmlFor="phoneNumber" className="block text-sm font-medium text-gray-700">
                Phone Number
              </label>
              <input
                type="tel"
                id="phoneNumber"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              />
            </div>

            <div>
              <button
                type="submit"
                disabled={loading}
                className="inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50">
                {loading ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </AccountLayout>
  )
}

export default ProfilePage
