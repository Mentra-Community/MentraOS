import {useAuth} from "@mentra/shared"
import DashboardLayout from "../components/DashboardLayout"
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "../components/ui/card"
import {Input} from "../components/ui/input"
import {Label} from "../components/ui/label"

const AccountPage: React.FC = () => {
  const {user, isLoading} = useAuth()

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-gray-900">Your Account</h1>
        </div>

        <div className="grid grid-cols-1 gap-6">
          {/* Account Information */}
          <Card>
            <CardHeader>
              <CardTitle>Profile Information</CardTitle>
              <CardDescription>Manage your account details and preferences</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4">
                  <div>
                    <Label htmlFor="email">Email</Label>
                    <Input id="email" type="email" value={user?.email || ""} disabled className="bg-gray-100" />
                    <p className="text-xs text-gray-500 mt-1">Your email address cannot be changed</p>
                  </div>
                  <div>
                    <Label htmlFor="displayName">Display Name</Label>
                    <Input
                      id="displayName"
                      value={user?.name || user?.email?.split("@")[0] || ""}
                      disabled
                      className="bg-gray-100"
                    />
                    <p className="text-xs text-gray-500 mt-1">Display name is based on your account information</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Account Connections - Commented out
          <Card>
            <CardHeader>
              <CardTitle>Connected Services</CardTitle>
              <CardDescription>
                Manage your connections to Mentra services
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between py-2 border-b">
                  <div>
                    <h3 className="font-medium">Mentra App Store</h3>
                    <p className="text-sm text-gray-500">Access apps for your smart glasses</p>
                  </div>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                    Connected
                  </span>
                </div>

                <div className="flex items-center justify-between py-2 border-b">
                  <div>
                    <h3 className="font-medium">Mentra Developer Portal</h3>
                    <p className="text-sm text-gray-500">Develop apps for Mentra</p>
                  </div>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                    Not Connected
                  </span>
                </div>

                <div className="flex items-center justify-between py-2">
                  <div>
                    <h3 className="font-medium">Mentra Mobile App</h3>
                    <p className="text-sm text-gray-500">Manage your smart glasses</p>
                  </div>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                    Connected
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
          */}

          {/* Account Activity - Commented out
          <Card>
            <CardHeader>
              <CardTitle>Recent Activity</CardTitle>
              <CardDescription>
                Recent actions and changes to your account
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-start">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900">
                      Account Login
                    </p>
                    <p className="text-sm text-gray-500">
                      Logged in from Chrome on macOS
                    </p>
                  </div>
                  <div className="ml-4 flex-shrink-0">
                    <p className="text-xs text-gray-500">Just now</p>
                  </div>
                </div>
                <div className="flex items-start">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900">
                      Password Changed
                    </p>
                    <p className="text-sm text-gray-500">
                      Your account password was updated
                    </p>
                  </div>
                  <div className="ml-4 flex-shrink-0">
                    <p className="text-xs text-gray-500">2 days ago</p>
                  </div>
                </div>
                <div className="flex items-start">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900">
                      Account Created
                    </p>
                    <p className="text-sm text-gray-500">
                      Welcome to Mentra!
                    </p>
                  </div>
                  <div className="ml-4 flex-shrink-0">
                    <p className="text-xs text-gray-500">30 days ago</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
          */}
        </div>
      </div>
    </DashboardLayout>
  )
}

export default AccountPage
