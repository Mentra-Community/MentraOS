import { Card, CardContent, ScrollArea } from "../../../components/ui";

export interface Log {
  id: number;
  message: string;
  time: string;
}

interface SystemLogsProps {
  logs: Log[];
}

export function SystemLogs({ logs }: SystemLogsProps) {
  return (
    <Card>
      <CardContent className="pt-4">
        <ScrollArea className="h-72">
          {logs.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-muted-foreground">
                No system logs yet...
              </p>
            </div>
          ) : (
            <div className="space-y-0.5 font-mono text-[11px] pr-3">
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="px-2 py-1 rounded text-foreground/80 animate-slide-down"
                >
                  <span className="text-muted-foreground">[{log.time}]</span>{" "}
                  <span className="text-chart-5">&rarr;</span> {log.message}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
