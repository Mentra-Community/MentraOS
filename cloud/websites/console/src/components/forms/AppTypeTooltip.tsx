import React from 'react';
import { Info } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const AppTypeTooltip: React.FC = () => {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Info className="h-4 w-4 text-muted-foreground cursor-help" />
        </TooltipTrigger>
        <TooltipContent className="max-w-sm p-4">
          <div className="space-y-3">
            <div>
              <p className="font-semibold text-link">Standard Apps (Foreground)</p>
              <p className="text-sm text-popover-foreground/80">
                • Only one standard app can run at a time<br />
                • Has primary control of the display<br />
                • Starting a standard app closes any other running standard app
              </p>
            </div>
            <div>
              <p className="font-semibold text-success">Background Apps</p>
              <p className="text-sm text-popover-foreground/80">
                • Multiple background apps can be active simultaneously<br />
                • Can temporarily take control of the display<br />
                • Take priority when no standard app is displaying content
              </p>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

export default AppTypeTooltip;