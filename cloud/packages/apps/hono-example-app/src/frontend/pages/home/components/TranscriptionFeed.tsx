import { Card, CardContent, ScrollArea, Badge } from "../../../components/ui";

export interface Transcription {
  id: number;
  text: string;
  time: string;
  isFinal: boolean;
}

interface TranscriptionFeedProps {
  transcriptions: Transcription[];
}

export function TranscriptionFeed({ transcriptions }: TranscriptionFeedProps) {
  return (
    <Card>
      <CardContent className="pt-4">
        <ScrollArea className="h-72">
          {transcriptions.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-muted-foreground">
                Listening for audio input...
              </p>
            </div>
          ) : (
            <div className="space-y-2 pr-3">
              {transcriptions.map((trans) => (
                <div
                  key={trans.id}
                  className="p-2.5 rounded-lg bg-muted/50 animate-slide-down"
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <div
                      className={`w-1.5 h-1.5 rounded-full ${
                        trans.isFinal
                          ? "bg-chart-4"
                          : "bg-chart-2 animate-pulse"
                      }`}
                    />
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {trans.time}
                    </span>
                    {trans.isFinal && (
                      <Badge variant="secondary" className="text-[9px] h-4">
                        final
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-foreground">{trans.text}</p>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
