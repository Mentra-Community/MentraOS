import { useEffect, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { deleteStoreAsset, getStoreListing, updateStoreListing, uploadStoreAsset, type StoreAsset } from "./apps.api";

export function StoreListingCard({ packageName }: { packageName: string }) {
  const client = useQueryClient();
  const listingQuery = useQuery({
    queryKey: ["store-listing", packageName],
    queryFn: () => getStoreListing(packageName),
  });
  const [subtitle, setSubtitle] = useState("");
  const [description, setDescription] = useState("");
  const [categories, setCategories] = useState("");
  const [privacyPolicyUrl, setPrivacyPolicyUrl] = useState("");
  const [supportUrl, setSupportUrl] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");

  useEffect(() => {
    const listing = listingQuery.data?.listing;
    if (!listing) return;
    setSubtitle(listing.subtitle ?? "");
    setDescription(listing.longDescription ?? "");
    setCategories(listing.categories.join(", "));
    setPrivacyPolicyUrl(listing.privacyPolicyUrl ?? "");
    setSupportUrl(listing.supportUrl ?? "");
    setWebsiteUrl(listing.websiteUrl ?? "");
  }, [listingQuery.data]);

  const refresh = () => client.invalidateQueries({ queryKey: ["store-listing", packageName] });
  const save = useMutation({
    mutationFn: () =>
      updateStoreListing(packageName, {
        subtitle: subtitle || null,
        longDescription: description || null,
        categories: categories
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        privacyPolicyUrl: privacyPolicyUrl || null,
        supportUrl: supportUrl || null,
        websiteUrl: websiteUrl || null,
      }),
    onSuccess: refresh,
  });
  const upload = useMutation({
    mutationFn: ({ role, file }: { role: "store_icon" | "store_cover" | "gallery_screenshot"; file: File }) =>
      uploadStoreAsset(packageName, { role, file }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (assetId: string) => deleteStoreAsset(packageName, assetId),
    onSuccess: refresh,
  });

  const uploadInput = (role: "store_icon" | "store_cover" | "gallery_screenshot", label: string) => (
    <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-md border border-[#d7dcd6] bg-white px-3 text-sm font-semibold text-[#285e50] hover:bg-[#f4f7f4]">
      <ImagePlus className="size-4" />
      {label}
      <input
        className="sr-only"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/avif"
        disabled={upload.isPending}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const file = event.target.files?.[0];
          if (file) upload.mutate({ role, file });
          event.target.value = "";
        }}
      />
    </label>
  );

  const error = listingQuery.error ?? save.error ?? upload.error ?? remove.error;
  const assets = listingQuery.data?.listing.assets ?? [];

  return (
    <Card className="mt-6 rounded-[16px] border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)] sm:rounded-[18px]">
      <CardHeader className="border-b border-[#eceeeb] px-4 py-4 sm:px-6 sm:py-5">
        <CardTitle className="font-display text-[18px]">Store listing</CardTitle>
        <p className="text-sm text-[#747780]">
          This metadata is separate from the signed release manifest and can be edited without rebuilding.
        </p>
      </CardHeader>
      <CardContent className="space-y-5 p-4 sm:p-6">
        {listingQuery.isLoading ? <p className="text-sm text-[#747780]">Loading listing…</p> : null}
        {error ? (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error.message}
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Subtitle">
            <Input value={subtitle} maxLength={120} onChange={(event) => setSubtitle(event.target.value)} />
          </Field>
          <Field label="Categories">
            <Input
              value={categories}
              placeholder="productivity, accessibility"
              onChange={(event) => setCategories(event.target.value)}
            />
          </Field>
        </div>
        <Field label="Long description">
          <Textarea
            value={description}
            rows={6}
            maxLength={10_000}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Privacy policy URL">
            <Input type="url" value={privacyPolicyUrl} onChange={(event) => setPrivacyPolicyUrl(event.target.value)} />
          </Field>
          <Field label="Support URL">
            <Input type="url" value={supportUrl} onChange={(event) => setSupportUrl(event.target.value)} />
          </Field>
          <Field label="Website URL">
            <Input type="url" value={websiteUrl} onChange={(event) => setWebsiteUrl(event.target.value)} />
          </Field>
        </div>
        <div>
          <Label>Store artwork</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            {uploadInput("store_icon", "Upload icon")}
            {uploadInput("store_cover", "Upload cover")}
            {uploadInput("gallery_screenshot", "Add screenshot")}
          </div>
          <div className="mt-3 grid gap-2">
            {assets.map((asset) => (
              <AssetRow
                key={asset.id}
                asset={asset}
                deleting={remove.isPending}
                onDelete={() => remove.mutate(asset.id)}
              />
            ))}
          </div>
        </div>
        <div className="flex justify-end">
          <Button disabled={save.isPending || listingQuery.isLoading} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save listing"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function AssetRow({ asset, deleting, onDelete }: { asset: StoreAsset; deleting: boolean; onDelete: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[#e5e8e3] px-3 py-2 text-sm">
      <div className="min-w-0">
        <span className="font-semibold">{asset.role.replaceAll("_", " ")}</span>
        <span className="ml-2 text-[#747780]">
          {asset.fileName} · {formatBytes(asset.sizeBytes)}
        </span>
      </div>
      <button
        aria-label={`Delete ${asset.fileName}`}
        disabled={deleting}
        className="rounded p-1.5 text-[#9e3e38] hover:bg-red-50"
        onClick={onDelete}>
        <Trash2 className="size-4" />
      </button>
    </div>
  );
}

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
