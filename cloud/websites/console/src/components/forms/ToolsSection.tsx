import { Brain } from "lucide-react";
import ToolsEditor from "./ToolsEditor";
import { Tool } from "@/types/app";
import { ExternalLinkIcon } from "@/components/ui/icons";

interface ToolsSectionProps {
  tools: Tool[];
  onChange: (tools: Tool[]) => void;
}

export function ToolsSection({ tools, onChange }: ToolsSectionProps) {
  return (
    <div className="border rounded-lg p-5">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-base font-medium flex items-center gap-2">
          <Brain className="h-4 w-4" />
          Mentra AI Tools
        </h4>
        <a
          href="https://docs.mentraglass.com/app-devs/core-concepts/ai-tool-calls"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-link hover:text-link-hover hover:underline flex items-center gap-1"
        >
          Learn about AI tools
          <ExternalLinkIcon />
        </a>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Mentra AI Tools are entrypoints you can set up in your MiniApp that allow it to be
        used and controlled by Mentra AI. Users can invoke these tools through voice commands.
      </p>
      <ToolsEditor tools={tools} onChange={onChange} />
    </div>
  );
}

export default ToolsSection;
