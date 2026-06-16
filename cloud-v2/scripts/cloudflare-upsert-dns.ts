#!/usr/bin/env bun

type DnsRecordInput = {
  type: "A" | "AAAA" | "CNAME" | "TXT";
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
  comment?: string;
};

type CloudflareListResponse<T> = {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T[];
};

type CloudflareItemResponse<T> = {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T;
};

type CloudflareRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl: number;
};

const apiToken = mustEnv("CLOUDFLARE_API_TOKEN");

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main(): Promise<void> {
  const zoneName = process.env.CLOUDFLARE_ZONE_NAME ?? "mentraglass.com";
  const records = parseRecords(mustEnv("CF_DNS_RECORDS"));
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  const zoneId = await findZoneId(zoneName, accountId);
  for (const record of records) {
    await upsertRecord(zoneId, record);
  }
}

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseRecords(raw: string): DnsRecordInput[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("CF_DNS_RECORDS must be a JSON array");
  for (const record of parsed) {
    if (!record?.type || !record?.name || !record?.content) {
      throw new Error("each DNS record requires type, name, and content");
    }
  }
  return parsed;
}

async function findZoneId(name: string, account?: string): Promise<string> {
  const params = new URLSearchParams({ name });
  if (account) params.set("account.id", account);

  const res = await cf<CloudflareListResponse<{ id: string; name: string }>>(
    `/zones?${params.toString()}`,
  );
  const zone = res.result.find((candidate) => candidate.name === name);
  if (!zone) throw new Error(`Cloudflare zone not found: ${name}`);
  return zone.id;
}

async function upsertRecord(zoneId: string, input: DnsRecordInput): Promise<void> {
  const params = new URLSearchParams({ type: input.type, name: input.name });
  const existing = await cf<CloudflareListResponse<CloudflareRecord>>(
    `/zones/${zoneId}/dns_records?${params.toString()}`,
  );

  const payload = {
    type: input.type,
    name: input.name,
    content: input.content,
    proxied: input.proxied ?? false,
    ttl: input.ttl ?? 1,
    comment: input.comment,
  };

  const current = existing.result[0];
  if (current) {
    await cf<CloudflareItemResponse<CloudflareRecord>>(
      `/zones/${zoneId}/dns_records/${current.id}`,
      {
        method: "PUT",
        body: JSON.stringify(payload),
      },
    );
    console.log(`[cloudflare] updated ${input.type} ${input.name} -> ${input.content}`);
    return;
  }

  await cf<CloudflareItemResponse<CloudflareRecord>>(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  console.log(`[cloudflare] created ${input.type} ${input.name} -> ${input.content}`);
}

async function cf<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json()) as T & { success?: boolean; errors?: unknown };
  if (!res.ok || body.success === false) {
    throw new Error(
      `Cloudflare API failed (${res.status}): ${JSON.stringify(body.errors ?? body)}`,
    );
  }
  return body;
}
