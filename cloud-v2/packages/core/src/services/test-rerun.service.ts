import {TestRerunModel} from "../models/test-rerun.model";
import {testWriteConcern} from "../models/test-write-concern";
import {testBuildSourceSchema} from "../types/test-build.types";
import {frameworkIdentitySchema, frameworkRequestInputSchema} from "../types/framework-request.types";
import {individualRerunSchema, rerunPlanSchema, rerunPreviewSchema, rerunSubmitSchema,
  rerunTerminalStatuses, type RerunPlan, type RerunMember, type RerunAttempt} from "../types/test-rerun.types";
import {TestSuiteService} from "./test-suite.service";
import {RoutineDispatchService} from "./routine-dispatch.service";
import {TestRequestService, requestInputDigest, type StoredTestRequest} from "./test-request.service";
import {FrameworkResultService} from "./framework-result.service";
import {TestRunError} from "./test-result-error";

export interface RerunRecord {rerunId: string; inputDigest: string; previewDigest: string; plan: RerunPlan;
  state: "preview" | "accepted"; acceptedAt?: string}
export interface RerunRepository {
  get(id: string): Promise<RerunRecord | null>;
  insert(row: RerunRecord): Promise<void>;
  accept(id: string, digest: string, claimKeys: string[], acceptedAt: string): Promise<RerunRecord | null>;
  history(rootKey: string, before: number, limit: number): Promise<RerunRecord[]>;
  children(suiteId: string, before: string, limit: number): Promise<RerunRecord[]>;
  byRequest(requestId: string): Promise<RerunRecord | null>;
}
export const testRerunRepository: RerunRepository = {
  async get(rerunId) {return await TestRerunModel.findOne({rerunId}).read("primary").readConcern("majority").lean() as RerunRecord | null;},
  async insert(row) {await TestRerunModel.create([row], {writeConcern: testWriteConcern});},
  async accept(rerunId, previewDigest, claimKeys, acceptedAt) {
    return await TestRerunModel.findOneAndUpdate({rerunId, previewDigest, state: "preview"},
      {$set: {state: "accepted", claimKeys, acceptedAt}}, {new: true, writeConcern: testWriteConcern}).lean() as RerunRecord | null;
  },
  async history(rootKey, before, limit) {
    return await TestRerunModel.aggregate([
      {$match: {state: "accepted", "plan.members": {$elemMatch: {rootKey, attemptNumber: {$lt: before}}}}},
      {$set: {historyMember: {$arrayElemAt: [{$filter: {input: "$plan.members", as: "member", cond: {$eq: ["$$member.rootKey", rootKey]}}},0]}}},
      {$sort: {"historyMember.attemptNumber": -1}}, {$limit: limit}, {$unset: "historyMember"},
    ]).read("primary").readConcern("majority") as RerunRecord[];
  },
  async children(suiteId, before, limit) {
    const cursor = before ? decodeChildCursor(before) : undefined;
    return await TestRerunModel.find({state: "accepted", "plan.parent.suiteId": suiteId, ...(cursor ? {$or:[{acceptedAt:{$lt:cursor.acceptedAt}},{acceptedAt:cursor.acceptedAt,rerunId:{$lt:cursor.rerunId}}]} : {})})
      .sort({acceptedAt: -1,rerunId: -1}).limit(limit).read("primary").readConcern("majority").lean() as RerunRecord[];
  },
  async byRequest(requestId) {return await TestRerunModel.findOne({state: "accepted", "plan.members.requestId": requestId})
    .read("primary").readConcern("majority").lean() as RerunRecord | null;},
};
type ParentMember = {memberId: string; requestId?: string; routineId: string; platform: string; status: string;
  build?: RerunMember["input"]["build"]; publicationComplete?: boolean; runId?: string; startedAt?: string; finishedAt?: string};
const terminal = (status: string) => (rerunTerminalStatuses as readonly string[]).includes(status);
export const rerunRootKey = (parent: RerunPlan["parent"], memberId: string) => requestInputDigest({parent, memberId});
const originalId = (rootKey: string, requestId?: string) => requestId ?? `original-${rootKey}`;
const verified = (row: RerunRecord): RerunRecord => {
  const plan = rerunPlanSchema.safeParse(row.plan);
  if (!plan.success || row.rerunId !== plan.data.rerunId || requestInputDigest(plan.data) !== row.previewDigest)
    throw new TestRunError(503, "Rerun plan integrity is unavailable");
  return {...row, plan: plan.data};
};

/** Reruns freeze native inputs once and reuse ordinary queue/result ownership. */
export class TestRerunService {
  constructor(private readonly store: RerunRepository = testRerunRepository,
    private readonly suites: Pick<TestSuiteService, "detail"> & Partial<Pick<TestSuiteService,"originalMember">> = new TestSuiteService(),
    private readonly dispatch: Pick<RoutineDispatchService, "prepare"> = new RoutineDispatchService(),
    private readonly requests: Pick<TestRequestService, "get" | "submit"> = new TestRequestService(),
    private readonly results: Pick<FrameworkResultService, "summary"> = new FrameworkResultService(),
    private readonly now: () => number = Date.now) {}

  private async requestAttempt(requestId: string, identity: Pick<RerunAttempt, "parent" | "memberId" | "attemptNumber" | "attemptId">,
    frozen?: RerunMember): Promise<RerunAttempt> {
    const request = await this.requests.get(requestId);
    if (!request) return {...identity, requestId, status: "admission-pending", publicationComplete: false,
      ...(frozen ? {build: frozen.input.build, definitionRevision: frozen.input.definitionRevision} : {})};
    const input = frameworkRequestInputSchema.safeParse(request.input);
    if (!input.success || requestInputDigest(input.data) !== request.inputSha256 || frozen &&
      (request.hostId !== frozen.hostId || request.inputSha256 !== requestInputDigest(frozen.input)))
      throw new TestRunError(503, "Rerun request differs from its frozen input");
    let result;
    try {result = await this.results.summary(requestId);} catch (error) {
      if (!(error instanceof TestRunError && error.status === 404)) throw error;
    }
    if (result && (result.routineId !== input.data.routineId || result.platform !== input.data.platform ||
      result.definitionRevision !== input.data.definitionRevision || requestInputDigest(result.build) !== requestInputDigest(input.data.build)))
      throw new TestRunError(503, "Rerun result differs from its admitted app or definition");
    return {...identity, requestId, status: result?.outcome ?? request.terminalStatus ?? request.state,
      publicationComplete: result?.uploadsComplete === true && result.evidenceStatus === "complete", build: input.data.build, definitionRevision: input.data.definitionRevision,
      ...(result ? {runId: result.runId, startedAt: result.startedAt, finishedAt: result.finishedAt} : {}),
      ...(request.hostRejection ? {reason: request.hostRejection.reason} : {})};
  }
  private async parentMembers(parent: RerunPlan["parent"]): Promise<ParentMember[]> {
    if (!frameworkIdentitySchema.safeParse("suiteId" in parent ? parent.suiteId : parent.requestId).success)
      throw new TestRunError(400, "Invalid original identity");
    if ("suiteId" in parent) return (await this.suites.detail(parent.suiteId)).members;
    if (await this.suites.originalMember?.(parent.requestId)) throw new TestRunError(409, "Use the original suite member to preserve its history");
    if (await this.store.byRequest(parent.requestId)) throw new TestRunError(409, "Use the rerun's original parent to preserve its history");
    const request = await this.requests.get(parent.requestId);
    if (!request) throw new TestRunError(404, "Original test request was not found");
    const input = frameworkRequestInputSchema.parse(request.input);
    const attempt = await this.requestAttempt(parent.requestId, {parent, memberId: parent.requestId, attemptNumber: 0, attemptId: parent.requestId});
    return [{...attempt, memberId: parent.requestId, routineId: input.routineId, platform: input.platform}];
  }
  private async latest(rootKey: string) {
    const rows = await this.store.history(rootKey, Number.MAX_SAFE_INTEGER, 1);
    if (!rows.length) return null;
    const row = verified(rows[0]!); const member = row.plan.members.find(m => m.rootKey === rootKey)!;
    return {row, member, attempt: await this.attempt(row, member)};
  }
  private async attempt(row: RerunRecord, member: RerunMember): Promise<RerunAttempt> {
    return {...await this.requestAttempt(member.requestId, {attemptId: member.requestId, attemptNumber: member.attemptNumber,
      parent: row.plan.parent, memberId: member.memberId}, member), rerunId: row.rerunId,
      predecessorAttemptId: member.predecessorAttemptId, createdAt: row.acceptedAt, reason: row.plan.reason};
  }
  async preview(input: unknown, actor: string): Promise<{rerunId:string;previewDigest:string;plan:RerunPlan;state:"preview"|"accepted"}> {
    const parsed = rerunPreviewSchema.safeParse(input);
    if (!parsed.success) throw new TestRunError(400, "Invalid rerun selection or exact app source");
    const selected = parsed.data, inputDigest = requestInputDigest(selected);
    const old = await this.store.get(selected.rerunId);
    if (old) {
      const row = verified(old);
      if (row.inputDigest !== inputDigest) throw new TestRunError(409, "Rerun ID already has a different selection or app source");
      if (row.state === "preview" && Date.parse(row.plan.expiresAt) <= this.now()) throw new TestRunError(409, "Preview expired; use a new rerun ID");
      return {rerunId: row.rerunId, previewDigest: row.previewDigest, plan: row.plan, state: row.state};
    }
    const parentMembers = await this.parentMembers(selected.parent);
    const selection = selected.selection;
    const known = new Set(parentMembers.map(m => m.memberId));
    const referenced = "memberIds" in selection ? selection.memberIds : selection.filter.excludeMemberIds ?? [];
    if (referenced.some(id => !known.has(id))) throw new TestRunError(400, "Selection names an unknown original member");
    const chosen = parentMembers.filter(m => "memberIds" in selection ? selection.memberIds.includes(m.memberId) :
      (selection.filter.statuses as string[]).includes(m.status) && !selection.filter.excludeMemberIds?.includes(m.memberId));
    if (!chosen.length || chosen.length > 100) throw new TestRunError(400, "Rerun selection must contain one to 100 members");
    if (chosen.some(m => !terminal(m.status))) throw new TestRunError(409, "Original selected members must be terminal");
    if (selected.predecessorAttemptId && chosen.length !== 1) throw new TestRunError(400, "A predecessor is valid only for an individual rerun");
    const members: RerunMember[] = [];
    for (const member of chosen.sort((a, b) => a.memberId.localeCompare(b.memberId))) {
      const rootKey = rerunRootKey(selected.parent, member.memberId), latest = await this.latest(rootKey);
      if (latest && !terminal(latest.attempt.status)) throw new TestRunError(409, `Member already has an active rerun: ${latest.member.requestId}`);
      const predecessorAttemptId = latest?.member.requestId ?? originalId(rootKey, member.requestId);
      if (selected.predecessorAttemptId && selected.predecessorAttemptId !== predecessorAttemptId)
        throw new TestRunError(409, `Predecessor changed; latest attempt is ${predecessorAttemptId}`);
      const requestId = `rerun-${requestInputDigest({rerunId: selected.rerunId, rootKey})}`;
      let source = selected.source;
      let originalBuild = member.build;
      if (!source) {
        if (member.requestId) {
          const original = await this.requests.get(member.requestId);
          if (original) {
            const parsedInput = frameworkRequestInputSchema.safeParse(original.input);
            if (!parsedInput.success || requestInputDigest(parsedInput.data) !== original.inputSha256)
              throw new TestRunError(503, "Original app provenance is unavailable");
            originalBuild = parsedInput.data.build;
          }
        }
        const parsedSource = testBuildSourceSchema.safeParse(originalBuild?.source);
        if (!parsedSource.success) throw new TestRunError(409, "Original exact app artifact is unavailable; choose an explicit replacement artifact");
        source = parsedSource.data;
      }
      const frozen = await this.dispatch.prepare({requestId, routineId: member.routineId, platform: member.platform, source}, selected.source ? undefined : originalBuild);
      if (!selected.source && originalBuild && ["headSha", "archive", "receipt"].some(key =>
        requestInputDigest(frozen.input.build[key] ?? null) !== requestInputDigest(originalBuild![key] ?? null)))
        throw new TestRunError(409, "Resolved original artifact differs from its recorded identity");
      members.push({memberId: member.memberId, rootKey, ...(member.requestId ? {originalRequestId: member.requestId} : {}), predecessorAttemptId,
        attemptNumber: (latest?.member.attemptNumber ?? 0) + 1, requestId, ...frozen});
    }
    const plan = rerunPlanSchema.parse({rerunId: selected.rerunId, parent: selected.parent, ...(selected.source ? {source: selected.source} : {}),
      reason: selected.reason, actor, createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + 600_000).toISOString(), members});
    const row: RerunRecord = {rerunId: plan.rerunId, inputDigest, previewDigest: requestInputDigest(plan), plan, state: "preview"};
    try {await this.store.insert(row);} catch (error) {
      if ((error as {code?: number}).code !== 11000) throw error;
      return this.preview(selected, actor);
    }
    return {rerunId: row.rerunId, previewDigest: row.previewDigest, plan, state: row.state};
  }
  async submit(input: unknown) {
    const parsed = rerunSubmitSchema.safeParse(input);
    if (!parsed.success) throw new TestRunError(400, "Invalid rerun submission");
    let row = await this.store.get(parsed.data.rerunId);
    if (!row) throw new TestRunError(404, "Preview was not found");
    row = verified(row);
    if (row.previewDigest !== parsed.data.previewDigest) throw new TestRunError(409, "Preview digest changed");
    if (row.state === "preview") {
      if (Date.parse(row.plan.expiresAt) <= this.now()) throw new TestRunError(409, "Preview expired; use a new rerun ID");
      try {
        const accepted = await this.store.accept(row.rerunId, row.previewDigest,
          row.plan.members.map(m => requestInputDigest({rootKey: m.rootKey, predecessor: m.predecessorAttemptId})), new Date(this.now()).toISOString());
        row = accepted ? verified(accepted) : verified((await this.store.get(row.rerunId))!);
      } catch (error) {
        if ((error as {code?: number}).code !== 11000) throw error;
        throw new TestRunError(409, "Another rerun already claimed a selected predecessor; refresh its history");
      }
      if (row.state !== "accepted") throw new TestRunError(409, "Rerun acceptance is unavailable");
    }
    const admissions = [];
    for (const member of row.plan.members) {
      try {await this.requests.submit(member.requestId, member.hostId, member.input); admissions.push({requestId: member.requestId, admitted: true});}
      catch {admissions.push({requestId: member.requestId, admitted: false, reason: "Admission unavailable; retry this same rerun ID and preview digest"});}
    }
    return {...await this.detail(row.rerunId), admissions};
  }
  async individual(input: unknown, actor: string) {
    const parsed = individualRerunSchema.safeParse(input);
    if (!parsed.success) throw new TestRunError(400, "Invalid individual rerun");
    const value = parsed.data, parent = "suiteId" in value.parent ? {suiteId: value.parent.suiteId} : value.parent;
    const memberId = "suiteId" in value.parent ? value.parent.memberId : value.parent.requestId;
    return this.preview({rerunId: value.requestId, parent, selection: {memberIds: [memberId]}, ...(value.source ? {source: value.source} : {}),
      reason: value.reason, predecessorAttemptId: value.predecessorAttemptId}, actor);
  }
  async detail(id: string) {
    if (!frameworkIdentitySchema.safeParse(id).success) throw new TestRunError(400, "Invalid rerun identity");
    const stored = await this.store.get(id);
    if (!stored) throw new TestRunError(404, "Rerun was not found");
    const row = verified(stored);
    const attempts = await Promise.all(row.plan.members.map(m => this.attempt(row, m)));
    return {rerunId: id, previewDigest: row.previewDigest, parent: row.plan.parent, reason: row.plan.reason, source: row.plan.source, state: row.state,
      createdAt: row.plan.createdAt, attempts, passed: attempts.filter(a => a.status === "pass" && a.publicationComplete).length,
      outcome: attempts.every(a => terminal(a.status)) ? attempts.every(a => a.status === "pass" && a.publicationComplete) ? "passed" : "failed" : "running"};
  }
  async history(parent: RerunPlan["parent"], memberId: string, before = Number.MAX_SAFE_INTEGER, limit = 20) {
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 25)
      throw new TestRunError(400, "Invalid history page");
    const members = await this.parentMembers(parent), member = members.find(m => m.memberId === memberId);
    if (!member) throw new TestRunError(404, "Original member was not found");
    const rootKey = rerunRootKey(parent, memberId);
    const rows = (await this.store.history(rootKey, before, limit + 1)).map(verified);
    const entries = rows.map(row => ({row, member: row.plan.members.find(m => m.rootKey === rootKey)!})).sort((a,b) => b.member.attemptNumber - a.member.attemptNumber);
    const page = entries.slice(0, limit), attempts = await Promise.all(page.map(({row, member}) => this.attempt(row, member)));
    const original = member.requestId ? await this.requestAttempt(member.requestId, {parent, memberId, attemptId: member.requestId, attemptNumber: 0}) :
      {parent, memberId, attemptId: originalId(rootKey), attemptNumber: 0, status: member.status, publicationComplete: member.publicationComplete === true};
    return {original: {...original, status: member.status, publicationComplete: member.publicationComplete === true,
      runId: member.runId ?? original.runId}, attempts, nextBefore: entries.length > limit ? page.at(-1)!.member.attemptNumber : null};
  }
  async progress(suiteId: string) {
    const parent = {suiteId}, members = await this.parentMembers(parent);
    const latest = await Promise.all(members.map(async m => ({memberId: m.memberId, originalStatus: m.status,
      latest: (await this.latest(rerunRootKey(parent, m.memberId)))?.attempt ?? null})));
    const children = await this.store.children(suiteId, "", 21);
    return {members: latest, children: children.slice(0,20).map(verified).map(r => ({rerunId: r.rerunId, reason: r.plan.reason, createdAt: r.acceptedAt})),
      nextChildrenCursor: children.length > 20 ? encodeChildCursor(children[19]!) : null};
  }
  async children(suiteId: string, before = "") {
    if (!frameworkIdentitySchema.safeParse(suiteId).success || before && before.length > 1000)
      throw new TestRunError(400, "Invalid child history page");
    if (before) decodeChildCursor(before);
    const rows = await this.store.children(suiteId, before, 21);
    return {children: rows.slice(0,20).map(verified).map(r => ({rerunId:r.rerunId,reason:r.plan.reason,createdAt:r.acceptedAt})),
      nextCursor: rows.length > 20 ? encodeChildCursor(rows[19]!) : null};
  }
  async lineage(requestId: string) {
    if (!frameworkIdentitySchema.safeParse(requestId).success) throw new TestRunError(400, "Invalid request identity");
    const row = await this.store.byRequest(requestId);
    if (!row) return {lineage: null, original: await this.suites.originalMember?.(requestId) ?? null};
    const stored = verified(row), member = stored.plan.members.find(m => m.requestId === requestId)!;
    return {lineage: {parent: stored.plan.parent, memberId: member.memberId, rerunId: stored.rerunId,
      predecessorAttemptId: member.predecessorAttemptId}};
  }
}

const encodeChildCursor = (row:RerunRecord) => Buffer.from(JSON.stringify({acceptedAt:row.acceptedAt,rerunId:row.rerunId})).toString("base64url");
function decodeChildCursor(value:string): {acceptedAt:string;rerunId:string} {
  try {const parsed=JSON.parse(Buffer.from(value,"base64url").toString());if (!Number.isFinite(Date.parse(parsed.acceptedAt)) || !frameworkIdentitySchema.safeParse(parsed.rerunId).success)throw new Error();return parsed;}
  catch {throw new TestRunError(400,"Invalid child history cursor");}
}
