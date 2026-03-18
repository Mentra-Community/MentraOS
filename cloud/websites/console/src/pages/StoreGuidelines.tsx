import React from "react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mentra/shared";
import { ExternalLink, FileText, CheckCircle, AlertCircle, Info } from "lucide-react";
import DashboardLayout from "../components/DashboardLayout";

/**
 * Store Guidelines page with placeholder content.
 * Full guidelines content will be hosted on docs.mentraglass.com.
 */
const StoreGuidelines: React.FC = () => {
  return (
    <DashboardLayout>
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6 min-h-10">
          <h1 className="text-2xl font-semibold text-foreground">Store Guidelines</h1>
        </div>

        <div className="space-y-6">
          {/* Overview Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Info className="h-5 w-5 text-link" />
                Overview
              </CardTitle>
              <CardDescription>
                Understanding the Mentra MiniApp Store review process
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-muted-foreground">
                Before your MiniApp can be published to the Mentra MiniApp Store,
                it must go through our review process. This ensures all MiniApps
                meet our quality standards and provide a great experience for
                MentraOS users.
              </p>
            </CardContent>
          </Card>

          {/* Requirements Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-success" />
                Requirements Checklist
              </CardTitle>
              <CardDescription>
                Ensure your MiniApp meets these requirements before submitting
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                <li className="flex items-start gap-2">
                  <CheckCircle className="h-4 w-4 text-success mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">
                    Display name, description,
                    and logo accurately represent your MiniApp&apos;s functionality
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="h-4 w-4 text-success mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">
                    Your Server URL must be
                    reachable and respond to health checks
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="h-4 w-4 text-success mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">
                    Only request permissions
                    that are necessary for your MiniApp&apos;s core functionality
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="h-4 w-4 text-success mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">
                    Complete your
                    organization profile with a valid contact email
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle className="h-4 w-4 text-success mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">
                    Include at least one preview
                    image showing your MiniApp in use (recommended)
                  </span>
                </li>
              </ul>
            </CardContent>
          </Card>

          {/* Common Rejections Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-warning" />
                Common Rejection Reasons
              </CardTitle>
              <CardDescription>
                Avoid these issues to speed up your review
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                <li className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">
                    Server URL is unreachable or returns errors
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">
                    Description doesn&apos;t accurately describe functionality
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">
                    Logo is missing, low quality, or not representative
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">
                    Requesting unnecessary permissions
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">
                    MiniApp crashes or doesn&apos;t respond to webhook events
                  </span>
                </li>
              </ul>
            </CardContent>
          </Card>

          {/* Help Card */}
          <Card className="bg-accent/10 border-border">
            <CardContent className="pt-6">
              <div className="flex items-start gap-4">
                <Info className="h-6 w-6 text-link shrink-0" />
                <div>
                  <h3 className="font-medium text-foreground mb-1">
                    Need Help?
                  </h3>
                  <p className="text-muted-foreground text-sm mb-3">
                    For detailed guidelines, best practices, and troubleshooting,
                    visit our comprehensive documentation.
                  </p>
                  <Button variant="outline" size="sm" asChild>
                    <a
                      href="https://docs.mentraglass.com/app-devs/getting-started/deployment/overview"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-link border-border hover:bg-secondary"
                    >
                      View Publishing Guide
                      <ExternalLink className="h-3 w-3 ml-1" />
                    </a>
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default StoreGuidelines;
