import { Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@mentra/shared";
import AppTypeTooltip from "./AppTypeTooltip";

enum AppType {
  STANDARD = "standard",
  BACKGROUND = "background",
}

interface AppTypeSelectProps {
  value: string;
  onChange: (value: string) => void;
}

export function AppTypeSelect({ value, onChange }: AppTypeSelectProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor="appType">MiniApp Type</Label>
        <AppTypeTooltip />
      </div>
      <p className="text-xs text-muted-foreground">
        Background MiniApps can run alongside other MiniApps.
        Only 1 foreground MiniApp can run at a time.
        Foreground MiniApps yield the display to background MiniApps when
        displaying content.
      </p>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder="Select app type" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AppType.BACKGROUND}>
            <div className="flex flex-col">
              <span className="font-medium">Background MiniApp</span>
            </div>
          </SelectItem>
          <SelectItem value={AppType.STANDARD}>
            <div className="flex flex-col">
              <span className="font-medium">Foreground MiniApp</span>
            </div>
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export default AppTypeSelect;
