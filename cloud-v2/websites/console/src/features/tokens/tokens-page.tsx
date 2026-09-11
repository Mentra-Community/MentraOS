import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Code2, Copy, KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sessionQuery } from "@/features/session/session.queries";
import { createApiToken, deleteApiToken, type ApiToken } from "./tokens.api";
import { apiTokensQuery } from "./tokens.queries";

export function TokensPage() {
  const queryClient = useQueryClient();
  const session = useQuery(sessionQuery());
  const tokens = useQuery(apiTokensQuery(session.isSuccess && !session.data.onboardingRequired));
  const tokenList = tokens.data?.tokens ?? [];
  const canManageKeys = session.data?.viewerRole === "owner" || session.data?.viewerRole === "admin";
  const [tokenName, setTokenName] = useState("");
  const [createdToken, setCreatedToken] = useState<ApiToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedLoginCommand, setCopiedLoginCommand] = useState(false);
  const [createFormOpen, setCreateFormOpen] = useState(false);

  const createToken = useMutation({
    mutationFn: createApiToken,
    onSuccess: async ({ token }) => {
      setTokenName("");
      setCreatedToken(token);
      setCopied(false);
      setCreateFormOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });
  const revokeToken = useMutation({
    mutationFn: deleteApiToken,
    onSuccess: async (_result, tokenId) => {
      if (createdToken?.id === tokenId) {
        setCreatedToken(null);
        setCopied(false);
      }
      await queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });
  const canCreate = canManageKeys && tokenName.trim().length > 0 && !createToken.isPending;

  async function copyCreatedToken() {
    if (!createdToken?.value) return;
    const didCopy = await copyTextToClipboard(createdToken.value);
    setCopied(didCopy);
  }

  async function copyLoginCommand() {
    const didCopy = await copyTextToClipboard("mentra login");
    setCopiedLoginCommand(didCopy);
    window.setTimeout(() => setCopiedLoginCommand(false), 1600);
  }

  return (
    <AppShell>
      <main className="mx-auto w-full max-w-[960px] px-4 py-4 sm:px-5 sm:py-6 md:px-8 md:py-8">
        <Card className="overflow-hidden rounded-[16px] border-[#e0e4de] bg-white py-0 shadow-[0_1px_2px_rgba(20,21,27,0.06)] sm:rounded-[18px]">
          <CardHeader className="border-b border-[#eceeeb] px-4 py-4 sm:px-6 sm:py-5">
            <CardTitle className="font-display text-[20px]">CLI login</CardTitle>
            <CardDescription className="mt-1 max-w-2xl text-[13px] leading-5 sm:text-[14px]">
              Use browser login for local development. Use API keys below for CI/CD and automation.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 sm:p-6">
            <section className="grid gap-4 rounded-[14px] bg-[#f6f7f5] p-4 sm:grid-cols-[44px_minmax(0,1fr)_minmax(220px,320px)] sm:items-center sm:p-5">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-white text-[#087d50] shadow-[0_0_0_1px_#e0e4de] sm:size-11">
                <Code2 className="size-5" />
              </div>
              <div className="min-w-0">
                <h2 className="font-display text-[18px] font-semibold text-[#14151b]">Interactive login</h2>
                <p className="mt-1 text-sm leading-6 text-[#747780]">
                  Best for day-to-day local development on your machine.
                </p>
              </div>
              <CommandRow command="mentra login" copied={copiedLoginCommand} onCopy={copyLoginCommand} />
            </section>
          </CardContent>
        </Card>

        <Card className="mt-5 overflow-hidden rounded-[16px] border-[#e0e4de] bg-white py-0 shadow-[0_1px_2px_rgba(20,21,27,0.06)] sm:mt-6 sm:rounded-[18px]">
          <CardHeader className="border-b border-[#eceeeb] px-4 py-4 sm:px-6 sm:py-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="font-display text-[20px]">API keys</CardTitle>
                <CardDescription className="mt-1 text-[13px] leading-5 sm:text-[14px]">
                  Keys are scoped to this org and can be revoked at any time.
                </CardDescription>
                {!canManageKeys ? (
                  <p className="mt-1 text-xs leading-5 text-[#8a8d95]">
                    Only owners and admins can create or revoke API keys.
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                className="h-10 rounded-full bg-[#111217] px-5 text-white hover:bg-[#25262c]"
                onClick={() => setCreateFormOpen(open => !open)}
                disabled={!canManageKeys}
              >
                {createFormOpen ? "Cancel" : "Create API key"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-5 p-4 sm:p-6">
            {createFormOpen ? (
              <CreateApiKeyForm
                tokenName={tokenName}
                setTokenName={setTokenName}
                canCreate={canCreate}
                isCreating={createToken.isPending}
                onSubmit={() => createToken.mutate({ name: tokenName.trim() })}
              />
            ) : null}

            {createToken.isError ? (
              <div className="rounded-[12px] bg-[#fff3f1] px-4 py-3 text-sm text-[#a64235]">
                {createToken.error.message || "Could not create API key."}
              </div>
            ) : null}

            {createdToken?.value ? (
              <div className="rounded-[14px] border border-[#ccefe2] bg-[#f1fbf6] p-4">
                <div className="text-sm font-semibold text-[#0e513d]">Copy this API key now</div>
                <p className="mt-1 text-sm leading-6 text-[#256953]">
                  It will only be shown once.
                </p>
                <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <code className="min-w-0 flex-1 overflow-x-auto rounded-[12px] bg-white px-3 py-2 font-mono text-xs text-[#1c1d22] shadow-[0_0_0_1px_#ccefe2]">
                    {createdToken.value}
                  </code>
                  <Button
                    type="button"
                    className="h-10 rounded-full bg-[#111217] px-4 text-white hover:bg-[#25262c]"
                    onClick={copyCreatedToken}
                  >
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="overflow-hidden rounded-[14px] border border-[#eceeeb]">
              {tokenList.length === 0 ? (
                <div className="flex min-h-48 flex-col items-center justify-center px-4 py-8 text-center">
                  <div className="flex size-12 items-center justify-center rounded-[14px] bg-[#e9f8f1] text-[#087d50] shadow-[0_0_0_1px_#ccefe2]">
                    <KeyRound className="size-5" />
                  </div>
                  <div className="mt-4 font-display text-[18px] font-semibold text-[#14151b]">No API keys yet</div>
                  <p className="mt-2 max-w-sm text-sm leading-6 text-[#747780]">
                    Create one when a CI job or script needs to publish without browser login.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-[#eceeeb]">
                  {tokenList.map(token => (
                    <TokenRow
                      key={token.id}
                      token={token}
                      canRevoke={canManageKeys}
                      isRevoking={revokeToken.isPending}
                      onRevoke={() => revokeToken.mutate(token.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </main>
    </AppShell>
  );
}

function CommandRow({
  command,
  copied,
  onCopy,
}: {
  command: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-[13px] border border-[#e0e4de] bg-white p-2 shadow-[0_1px_1px_rgba(20,21,27,0.03)]">
      <code className="min-w-0 flex-1 truncate px-2 font-mono text-[13px] text-[#1c1d22]">
        <span className="select-none text-[#087d50]">$ </span>
        {command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0 rounded-full text-[#5d6068] hover:bg-[#edf2ec] hover:text-[#111217]"
        onClick={onCopy}
        aria-label={`Copy ${command}`}
      >
        {copied ? <Check className="size-4 text-[#087d50]" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}

function CreateApiKeyForm({
  tokenName,
  setTokenName,
  canCreate,
  isCreating,
  onSubmit,
}: {
  tokenName: string;
  setTokenName: (value: string) => void;
  canCreate: boolean;
  isCreating: boolean;
  onSubmit: () => void;
}) {
  return (
    <form
      className="grid gap-3 rounded-[14px] bg-[#f6f7f5] p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canCreate) return;
        onSubmit();
      }}
    >
      <div>
        <Label htmlFor="apiKeyName" className="mb-2 text-sm font-semibold text-[#1c1d22]">
          API key name
        </Label>
        <Input
          id="apiKeyName"
          className="h-11 rounded-[12px] border-[#dfe3dc] bg-white px-3 shadow-none placeholder:text-[#b6bbb5] focus-visible:ring-[#9dddc7]/35 sm:px-4"
          placeholder="e.g. GitHub Actions deploy"
          value={tokenName}
          onChange={event => setTokenName(event.target.value)}
        />
      </div>
      <Button
        className="h-11 rounded-full bg-[#111217] px-5 text-white hover:bg-[#25262c] sm:self-end"
        disabled={!canCreate}
      >
        {isCreating ? "Creating..." : "Create API key"}
      </Button>
    </form>
  );
}

function TokenRow({
  token,
  canRevoke,
  isRevoking,
  onRevoke,
}: {
  token: ApiToken;
  canRevoke: boolean;
  isRevoking: boolean;
  onRevoke: () => void;
}) {
  return (
    <div className="grid gap-3 px-4 py-4 sm:px-5 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center">
      <div className="min-w-0">
        <div className="truncate text-[15px] font-semibold text-[#1c1d22]">{token.name}</div>
        <div className="mt-1 truncate font-mono text-xs text-[#8a8d95]">
          {token.obfuscatedValue || token.id}
        </div>
      </div>
      <div className="text-xs leading-5 text-[#8a8d95]">
        <div>{token.createdAt ? `Created ${formatDate(token.createdAt)}` : "Created recently"}</div>
        <div>{token.lastUsedAt ? `Used ${formatDate(token.lastUsedAt)}` : "Never used"}</div>
      </div>
      {canRevoke ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="justify-self-start rounded-full text-[#8a8d95] hover:bg-[#fff3f1] hover:text-[#a64235] md:justify-self-end"
          disabled={isRevoking}
          onClick={onRevoke}
          aria-label={`Revoke ${token.name}`}
        >
          <Trash2 className="size-4" />
        </Button>
      ) : (
        <span className="md:justify-self-end" />
      )}
    </div>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }
}
