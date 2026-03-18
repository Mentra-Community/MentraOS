import { Input, Label } from "@mentra/shared";

interface ServerUrlFieldProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur: (e: React.FocusEvent<HTMLInputElement>) => void;
  error?: string;
  required?: boolean;
}

export function ServerUrlField({
  value,
  onChange,
  onBlur,
  error,
  required = false
}: ServerUrlFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor="publicUrl">
        Server URL {required && <span className="text-destructive">*</span>}
      </Label>
      <Input
        id="publicUrl"
        name="publicUrl"
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        placeholder="yourserver.com"
        className={error ? "border-destructive" : ""}
      />
      {error && (
        <p className="text-xs text-destructive mt-1">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        This is the public URL of your MiniApp server. MentraOS will automatically
        append &quot;/webhook&quot; to handle events when your app is activated.
        If your MiniApp is hosted locally, you can use a service like{" "}
        <a
          href="https://docs.mentraglass.com/app-devs/getting-started/deployment/local-development"
          target="_blank"
          rel="noopener noreferrer"
          className="text-link hover:text-link-hover hover:underline"
        >
          Ngrok
        </a>{" "}
        to get a public URL.
      </p>
    </div>
  );
}

export default ServerUrlField;
