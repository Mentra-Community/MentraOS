import { Camera, Image } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../../../components/ui";

export interface Photo {
  id: string;
  url: string;
  timestamp: string;
  requestId: string;
}

interface PhotoStreamProps {
  photos: Photo[];
}

export function PhotoStream({ photos }: PhotoStreamProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Camera className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-sm">Photo Stream</CardTitle>
        </div>
        <CardDescription className="text-xs">
          {photos.length} captured
        </CardDescription>
      </CardHeader>
      <CardContent>
        {photos.length === 0 ? (
          <div className="text-center py-10">
            <div className="inline-flex p-3 rounded-xl bg-muted mb-3">
              <Image className="w-6 h-6 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">
              Waiting for photo captures...
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Tap the right side of your temple to take a picture
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {photos.map((photo) => (
              <div
                key={photo.id}
                className="group relative aspect-video rounded-lg overflow-hidden bg-muted animate-photo-in"
              >
                <img
                  src={photo.url}
                  alt={`Captured at ${photo.timestamp}`}
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="absolute bottom-2 left-2">
                    <span className="text-[10px] text-white font-mono">
                      {photo.timestamp}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
