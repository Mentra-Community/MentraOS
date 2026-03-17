// components/MiniAppTable.tsx
import {useEffect, useState, type FC} from "react"
import {useNavigate} from "react-router-dom"
import {Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Spinner} from "@mentra/shared"
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@/components/ui/table"
import {Link} from "react-router-dom"
import {Edit, Trash, Share2, Plus, BadgeCheck, BadgeMinus} from "lucide-react"
import {Tooltip, TooltipContent, TooltipTrigger} from "@/components/ui/tooltip"
import api, {AppResponse} from "../services/api.service"
import {useOrganization} from "../context/OrganizationContext"

// Import dialogs
import ApiKeyDialog from "./dialogs/ApiKeyDialog"
import SharingDialog from "./dialogs/SharingDialog"
import DeleteDialog from "./dialogs/DeleteDialog"
import PublishDialog from "./dialogs/PublishDialog"
import InstallDialog from "./dialogs/InstallDialog"

interface MiniAppTableProps {
  apps: AppResponse[]
  isLoading: boolean
  error: string | null
  maxDisplayCount?: number
  showViewAll?: boolean
  showSearch?: boolean
  onAppDeleted?: (packageName: string) => void
  onAppUpdated?: (updatedApp: AppResponse) => void
}

const MiniAppTable: FC<MiniAppTableProps> = ({
  apps,
  isLoading,
  error,
  maxDisplayCount = Infinity,
  showViewAll = false,
  showSearch = true,
  onAppDeleted,
  onAppUpdated,
}) => {
  const navigate = useNavigate()
  const {currentOrg} = useOrganization()

  useEffect(() => {
    console.log("Apps data:", apps)
  }, [apps])

  // States for dialogs
  const [selectedApp, setSelectedApp] = useState<AppResponse | null>(null)
  const [isApiKeyDialogOpen, setIsApiKeyDialogOpen] = useState(false)
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false)
  const [isInstallDialogOpen, setIsInstallDialogOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [generatedApiKey, setGeneratedApiKey] = useState("")
  const [installedAppPackages, setInstalledAppPackages] = useState<Set<string>>(new Set())

  // Fetch installed apps when component mounts
  useEffect(() => {
    const fetchInstalledApps = async () => {
      try {
        const installedApps = await api.userApps.getInstalledApps()
        const packageNames = new Set(installedApps.map((app) => app.packageName))
        setInstalledAppPackages(packageNames)
        console.log("Fetched installed apps:", packageNames)
      } catch (error) {
        console.error("Error fetching installed apps:", error)
      }
    }

    fetchInstalledApps()
  }, [])

  // Helper function to check if an app is installed
  const isAppInstalled = (packageName: string): boolean => {
    return installedAppPackages.has(packageName)
  }

  // Handler for when install status changes
  const handleInstallStatusChange = (packageName: string, installed: boolean) => {
    setInstalledAppPackages((prev) => {
      const newSet = new Set(prev)
      if (installed) {
        newSet.add(packageName)
      } else {
        newSet.delete(packageName)
      }
      return newSet
    })
  }

  // Filter Apps based on search query
  const filteredApps = searchQuery
    ? apps.filter(
        (app) =>
          app.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          app.packageName.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : apps

  // Limit the number of Apps displayed
  const displayedApps = filteredApps.slice(0, maxDisplayCount)
  const hasNoApps = apps.length === 0

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-lg">Your MiniApps</CardTitle>
          <CardDescription>Manage your MiniApps</CardDescription>
        </div>
        {(showSearch || showViewAll) && (
          <div className="flex items-center gap-4">
            {showSearch && (
              <div className="w-64">
                <Input
                  placeholder="Search your MiniApps..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            )}
            {showViewAll && (
              <Button variant="outline" size="sm" asChild>
                <Link to="/apps">View All</Link>
              </Button>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          {isLoading ? (
            <div className="p-8 text-center flex flex-col items-center">
              <Spinner size="lg" />
              <p className="mt-2 text-muted-foreground">Loading MiniApps...</p>
            </div>
          ) : error ? (
            <div className="p-8 text-center text-destructive">
              <p>{error}</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => window.location.reload()}>
                Try Again
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Display Name</TableHead>
                  <TableHead>Package Name</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayedApps.length > 0 ? (
                  displayedApps.map((app) => (
                    <TableRow key={app.packageName}>
                      <TableCell>
                        <a
                          key={app.packageName}
                          className="font-medium flex flex-row items-center"
                          href={`https://apps.mentra.glass/package/${app.packageName}`}>
                          <img src={app.logoURL} alt={app.name} className="w-6 h-6 rounded-full mr-2" />
                          {app.name}
                        </a>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{app.packageName}</TableCell>
                      <TableCell className="text-muted-foreground">{new Date(app.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell>
                        <div>
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              app.appStoreStatus === "PUBLISHED"
                                ? "bg-success-light text-success"
                                : app.appStoreStatus === "SUBMITTED"
                                  ? "bg-warning-light text-warning"
                                  : app.appStoreStatus === "REJECTED"
                                    ? "bg-destructive/10 text-destructive"
                                    : "bg-secondary text-foreground"
                            }`}>
                            {app.appStoreStatus === "DEVELOPMENT"
                              ? "Development"
                              : app.appStoreStatus === "SUBMITTED"
                                ? "Submitted"
                                : app.appStoreStatus === "REJECTED"
                                  ? "Rejected"
                                  : app.appStoreStatus === "PUBLISHED"
                                    ? "Published"
                                    : "Development"}
                          </span>
                          {app.appStoreStatus === "REJECTED" && app.reviewNotes && (
                            <div className="mt-1">
                              <button
                                onClick={() => navigate(`/apps/${app.packageName}/edit`)}
                                className="text-xs text-destructive hover:underline focus:outline-none"
                                title={app.reviewNotes}>
                                View Rejection Reason
                              </button>
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setSelectedApp(app)
                                  setIsInstallDialogOpen(true)
                                }}
                                title={isAppInstalled(app.packageName) ? "Click to uninstall" : "Click to install"}
                                className="cursor-pointer">
                                {isAppInstalled(app.packageName) ? (
                                  <BadgeCheck className="h-4 w-4" />
                                ) : (
                                  <BadgeMinus className="h-4 w-4" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>
                                {isAppInstalled(app.packageName)
                                  ? "Installed - Click to uninstall"
                                  : "Not installed - Click to install"}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => navigate(`/apps/${app.packageName}/edit`)}
                                title="Edit MiniApp">
                                <Edit className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Edit MiniApp</p>
                            </TooltipContent>
                          </Tooltip>

                          {/* <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={async () => {
                                  // Reset generated API key state before opening dialog
                                  setGeneratedApiKey("");
                                  // Set selected App after resetting key state
                                  setSelectedApp(app);
                                  // Then open the dialog
                                  setIsApiKeyDialogOpen(true);
                                }}
                                title="Manage API Key"
                              >
                                <KeyRound className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Manage API Key</p>
                            </TooltipContent>
                          </Tooltip> */}

                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setSelectedApp(app)
                                  setIsShareDialogOpen(true)
                                }}
                                title="Share with Testers">
                                <Share2 className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Share with Testers</p>
                            </TooltipContent>
                          </Tooltip>

                          {/* <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setSelectedApp(app);
                                  setIsPublishDialogOpen(true);
                                }}
                                title={
                                  app.appStoreStatus === "REJECTED"
                                    ? "Resubmit to App Store"
                                    : "Publish to App Store"
                                }
                              >
                                <Upload className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>
                                {app.appStoreStatus === "REJECTED"
                                  ? "Resubmit to App Store"
                                  : "Publish to App Store"}
                              </p>
                            </TooltipContent>
                          </Tooltip> */}

                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setSelectedApp(app)
                                  setIsDeleteDialogOpen(true)
                                }}
                                title="Delete MiniApp">
                                <Trash className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Delete MiniApp</p>
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-6 text-muted-foreground">
                      {searchQuery ? "No MiniApps match your search criteria" : "No MiniApps to display"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}

          {showViewAll && (
            <div className="text-center pt-4">
              <Button variant="outline" size="sm" asChild>
                <Link to="/apps">View All</Link>
              </Button>
            </div>
          )}
        </div>

        {hasNoApps && !isLoading && !error && !searchQuery && (
          <div className="p-6 text-center">
            <p className="text-muted-foreground mb-4">Get started by creating your first MiniApp</p>
            <Button onClick={() => navigate("/apps/create")} className="gap-2">
              <Plus className="h-4 w-4" />
              Create MiniApp
            </Button>
          </div>
        )}
      </CardContent>

      {/* Dialogs */}
      {selectedApp && (
        <>
          <ApiKeyDialog
            app={selectedApp}
            open={isApiKeyDialogOpen}
            onOpenChange={setIsApiKeyDialogOpen}
            apiKey={generatedApiKey}
            onKeyRegenerated={(newKey) => {
              // Update the API key in the parent component's state
              setGeneratedApiKey(newKey)
              console.log(`API key regenerated for ${selectedApp?.name}`)
            }}
            orgId={currentOrg?.id}
          />

          <SharingDialog
            app={selectedApp}
            open={isShareDialogOpen}
            onOpenChange={setIsShareDialogOpen}
            orgId={currentOrg?.id}
          />

          <PublishDialog
            app={selectedApp}
            open={isPublishDialogOpen}
            onOpenChange={setIsPublishDialogOpen}
            orgId={currentOrg?.id}
            onPublishComplete={(updatedApp) => {
              // Update the selected App with the new data
              setSelectedApp(updatedApp)

              // Notify parent component to update the app
              if (onAppUpdated) {
                onAppUpdated(updatedApp)
              }
            }}
          />

          <DeleteDialog
            app={selectedApp}
            open={isDeleteDialogOpen}
            onOpenChange={setIsDeleteDialogOpen}
            orgId={currentOrg?.id}
            onConfirmDelete={(packageName) => {
              // Notify parent component of deletion
              if (onAppDeleted) {
                onAppDeleted(packageName)
              }
            }}
          />

          <InstallDialog
            app={selectedApp}
            open={isInstallDialogOpen}
            onOpenChange={setIsInstallDialogOpen}
            isInstalled={selectedApp ? isAppInstalled(selectedApp.packageName) : false}
            onInstallStatusChange={handleInstallStatusChange}
          />
        </>
      )}
    </Card>
  )
}

export default MiniAppTable
