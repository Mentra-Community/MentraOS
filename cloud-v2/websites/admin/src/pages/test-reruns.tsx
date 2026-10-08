import {LoadingIndicator} from "../components/loading-indicator";
import {HistoryStatus} from "../components/test-history-table";
import {TESTING_PANEL, TESTING_LINK, TESTING_FIELD, TestingButton} from "../components/testing-ui";
import {useEffect, useState} from "react";
import {keepPreviousData, useQuery, useQueryClient} from "@tanstack/react-query";
import {api, ApiError} from "../lib/api";
import type {RerunAttempt, RerunPlan} from "../../../../packages/core/src/types/test-rerun.types";
import type {TestBuildSource} from "../../../../packages/core/src/types/test-build.types";
import {frameworkRunHref} from "./routine-catalog";

export function readRerunId(search: string) {
  const values = new URLSearchParams(search).getAll("testRerun");
  return values.length === 1 && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(values[0]!) ? values[0]! : null;
}
export const attemptHref = (attempt: RerunAttempt) => frameworkRunHref(attempt.runId ?? attempt.requestId ?? attempt.attemptId);
export function AttemptLine({attempt}: {attempt: RerunAttempt}) {
  const source = attempt.build?.source as TestBuildSource | undefined;
  return <p className="my-2 text-sm"><a className={TESTING_LINK} href={attemptHref(attempt)}>{attempt.attemptNumber === 0 ? "Original" : `Attempt ${attempt.attemptNumber}`} · {attempt.status}</a>
    {attempt.status === "pass" && !attempt.publicationComplete && " · Evidence pending"}
    {attempt.build && <> · App {attempt.build.headSha.slice(0,10)}{source && <> · Build {source.buildRunId}, publication {source.publicationAttempt}</>}</>}
    {!!attempt.build?.archive && <span className="block text-xs">Artifact {(attempt.build.archive as {sha256:string}).sha256.slice(0,12)}</span>}
    {attempt.definitionRevision && <> · Definition {attempt.definitionRevision.slice(0,10)}</>}
    {attempt.createdAt && <> · {new Date(attempt.createdAt).toLocaleString()}</>}
    {attempt.rerunId && <> · <a className={TESTING_LINK} href={`/?testRerun=${encodeURIComponent(attempt.rerunId)}`}>Rerun batch</a></>}
    {attempt.reason && <span className="block text-[#68746d]">{attempt.reason}</span>}</p>;
}
type AttemptHistoryData = {original:RerunAttempt;attempts:RerunAttempt[];nextBefore:number|null};
export function AttemptHistoryView({page, before, error, loading, onOpen, onBefore, onRetry}: {
  page?: AttemptHistoryData; before: number|null; error?: Error|null; loading: boolean;
  onOpen:(open:boolean)=>void; onBefore:(before:number|null)=>void; onRetry:()=>void;
}) {
  const message = error && <p role="alert">History unavailable. <TestingButton onClick={onRetry}>Retry</TestingButton></p>;
  if (before === null && (!page || !page.attempts.length)) return message || null;
  return <details onToggle={event=>onOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm font-medium">Attempt history</summary>
    {message}{loading && <LoadingIndicator label="Loading attempts" />}
    {page && <><AttemptLine attempt={page.original}/>{page.attempts.map(attempt=><AttemptLine key={attempt.attemptId} attempt={attempt}/>)}
      {page.nextBefore && <TestingButton busy={loading} onClick={()=>onBefore(page.nextBefore)}>Older attempts</TestingButton>}</>}
    {before !== null && <TestingButton className="ml-3" onClick={()=>onBefore(null)}>Latest attempts</TestingButton>}
  </details>;
}
export function AttemptHistory({suiteId, memberId, originalRequestId}: {suiteId?:string;memberId:string;originalRequestId?:string}) {
  const [open,setOpen]=useState(false), [before,setBefore]=useState<number | null>(null);
  const [retainedPage,setRetainedPage]=useState<AttemptHistoryData>();
  const history=useQuery({queryKey:["rerun-history",suiteId??originalRequestId,memberId,before],enabled:before === null || open,placeholderData:keepPreviousData,
    queryFn:()=>api<AttemptHistoryData>(`/api/admin/test-runs/reruns/${suiteId?`suite/${encodeURIComponent(suiteId)}/members/${encodeURIComponent(memberId)}`:`request/${encodeURIComponent(originalRequestId!)}`}/history${before ? `?before=${before}` : ""}`),refetchInterval:15000});
  useEffect(()=>{if(history.data && !history.isPlaceholderData) setRetainedPage(history.data);},[history.data,history.isPlaceholderData]);
  return <AttemptHistoryView page={history.data ?? retainedPage} before={before} error={history.error} loading={history.isFetching}
    onOpen={setOpen} onBefore={setBefore} onRetry={()=>history.refetch()}/>;
}
type Preview={rerunId:string;previewDigest:string;plan:RerunPlan;state:string};
export function RerunPreviewMembers({plan}:{plan:RerunPlan}) {
  return <ul>{plan.members.map(member=><li key={member.memberId}>{member.selection.routineId} · {member.selection.platform} · App {member.selection.build.headSha.slice(0,10)} · Definition {member.selection.routineRevision.slice(0,10)} · Lane assigned when dispatched</li>)}</ul>;
}
export function RerunForm({suiteId, originalRequestId, memberIds, onClose}: {suiteId?:string;originalRequestId?:string;memberIds:string[];onClose:()=>void}) {
  const [override,setOverride]=useState(false), [routineRevision,setRoutineRevision]=useState("");
  const [channel,setChannel]=useState<TestBuildSource["channel"]>("dev"), [build,setBuild]=useState(""),[publication,setPublication]=useState("1"),[pr,setPr]=useState(""),[reason,setReason]=useState("");
  const [id,setId]=useState(()=>crypto.randomUUID()),[preview,setPreview]=useState<Preview|null>(null),[message,setMessage]=useState(""),[busy,setBusy]=useState(false),[entered,setEntered]=useState(false),[previewEntered,setPreviewEntered]=useState(false);
  const client=useQueryClient();
  async function prepare() {
    setBusy(true); setMessage("");
    try {
      for(const value of override?[build,publication,...(channel==="pr"?[pr]:[])]:[]) if(!/^[1-9]\d*$/.test(value)||!Number.isSafeInteger(Number(value))) throw new Error("Enter exact positive build/publication coordinates.");
      const source:TestBuildSource|undefined=!override?undefined:channel==="pr"?{channel,prNumber:Number(pr),buildRunId:Number(build),publicationAttempt:Number(publication)}:{channel,buildRunId:Number(build),publicationAttempt:Number(publication)};
      if(routineRevision && !/^[a-f0-9]{40}$/.test(routineRevision)) throw new Error("Enter an exact 40-character routine revision.");
      if(!reason.trim()) throw new Error("Enter a reason for this rerun.");
      setPreviewEntered(true);
      const value=await api<Preview>("/api/admin/test-runs/reruns/preview",{method:"POST",body:{rerunId:id,parent:suiteId?{suiteId}:{requestId:originalRequestId},selection:{memberIds},...(source?{source}:{}),...(routineRevision?{routineRevision}:{}),reason}});setPreview(value);
    }catch(error){if(error instanceof ApiError && error.status<500){setPreviewEntered(false);setId(crypto.randomUUID());}setMessage(error instanceof Error?error.message:"Preview unavailable; retry the same selection.");}finally{setBusy(false);}
  }
  async function submit() {
    if(!preview)return;setBusy(true);setEntered(true);
    try {
      const result=await api<{admissions:{admitted:boolean}[]}>("/api/admin/test-runs/reruns/submit",{method:"POST",body:{rerunId:preview.rerunId,previewDigest:preview.previewDigest}});
      setMessage(result.admissions.every(a=>a.admitted)?"Rerun accepted. Follow its progress below.":"Some admissions are pending. Retry this same submission to reconcile them.");
      await client.invalidateQueries({queryKey:["rerun-progress",suiteId]});
    }catch(error){if(error instanceof ApiError && error.status<500){setEntered(false);setPreview(null);setPreviewEntered(false);setId(crypto.randomUUID());}setMessage(error instanceof Error?error.message:"Submission uncertain; retry this same submission.");}finally{setBusy(false);}
  }
  return <div className="my-4 space-y-4 rounded-xl border border-[#e0e4de] bg-[#fafbfa] p-4"><h3 className="font-semibold">Rerun {memberIds.length} selected item{memberIds.length!==1?"s":""}</h3>
    <details className="text-xs text-[#747780]"><summary className="cursor-pointer">Build and source selection</summary><p className="mt-2">Reuse the original MentraOS artifact, or choose a replacement. The machine uses its installed framework and verifies the original exact routine source. An optional source revision selects another commit.</p></details>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={override} disabled={previewEntered||busy} onChange={e=>setOverride(e.target.checked)}/> Use a different MentraOS artifact</label>
    {override&&<div className="grid gap-3 sm:grid-cols-2"><label className="block min-w-0 flex-1 space-y-1 text-sm text-[#5d6068]">Channel <select className={TESTING_FIELD} value={channel} disabled={previewEntered||busy} onChange={e=>setChannel(e.target.value as TestBuildSource["channel"])}>{["dev","staging","pr"].map(v=><option key={v}>{v}</option>)}</select></label>
      {channel==="pr"&&<label className="block min-w-0 flex-1 space-y-1 text-sm text-[#5d6068]">PR <input className={TESTING_FIELD} value={pr} disabled={previewEntered||busy} onChange={e=>setPr(e.target.value)}/></label>}
      <label className="block min-w-0 flex-1 space-y-1 text-sm text-[#5d6068]">Build workflow ID <input className={TESTING_FIELD} value={build} disabled={previewEntered||busy} onChange={e=>setBuild(e.target.value)}/></label>
      <label className="block min-w-0 flex-1 space-y-1 text-sm text-[#5d6068]">Publication attempt <input className={TESTING_FIELD} value={publication} disabled={previewEntered||busy} onChange={e=>setPublication(e.target.value)}/></label>
      </div>}
    <div><label className="block min-w-0 flex-1 space-y-1 text-sm text-[#5d6068]">Routine revision (optional) <input className={TESTING_FIELD} value={routineRevision} disabled={previewEntered||busy} placeholder="Reuse original exact source" onChange={e=>setRoutineRevision(e.target.value)}/></label></div>
    <div><label className="block min-w-0 flex-1 space-y-1 text-sm text-[#5d6068]">Reason <input className={TESTING_FIELD} value={reason} disabled={previewEntered||busy} onChange={e=>setReason(e.target.value)}/></label></div>
    {preview&&<RerunPreviewMembers plan={preview.plan}/>}
    <div className="flex flex-wrap items-center gap-2">
    <TestingButton busy={busy} onClick={preview?submit:prepare}>{preview?entered?"Reconcile same submission":"Submit this preview":"Preview rerun"}</TestingButton>
    <TestingButton className="ml-4" disabled={busy} onClick={onClose}>Close</TestingButton>
    {!entered&&<TestingButton className="ml-4" disabled={busy} onClick={()=>{setId(crypto.randomUUID());setPreview(null);setPreviewEntered(false);setMessage("New preview; any prior preview remains unsubmitted.");}}>Start fresh preview</TestingButton>}
    {preview&&<a className={TESTING_LINK} href={`/?testRerun=${encodeURIComponent(preview.rerunId)}`}>View rerun</a>}
    </div>
    {message&&<p role="status">{message}</p>}</div>;
}
export function TestRerunPage({rerunId}:{rerunId:string}) {
  const [reconcileMessage,setReconcileMessage]=useState("");
  const [reconciling,setReconciling]=useState(false);
  const result=useQuery({queryKey:["test-rerun",rerunId],queryFn:()=>api<{previewDigest:string;parent:RerunPlan["parent"];reason:string;source?:TestBuildSource;outcome:string;passed:number;attempts:RerunAttempt[];state:string}>(`/api/admin/test-runs/reruns/${encodeURIComponent(rerunId)}`),refetchInterval:15000});
  if(result.error)return <p role="alert">Rerun unavailable. <TestingButton onClick={()=>result.refetch()}>Retry</TestingButton></p>;
  if(!result.data)return <LoadingIndicator label="Loading rerun" />;
  const value=result.data;
  async function reconcile() {
    setReconciling(true);
    try {await api("/api/admin/test-runs/reruns/submit",{method:"POST",body:{rerunId,previewDigest:value.previewDigest}});await result.refetch();setReconcileMessage("Submission reconciled.");}
    catch(error){setReconcileMessage(error instanceof Error?error.message:"Reconciliation unavailable; retry the same rerun.");}
    finally{setReconciling(false);}
  }
  return <section className={TESTING_PANEL}><a className={TESTING_LINK} href={"suiteId" in value.parent?`/?testSuite=${encodeURIComponent(value.parent.suiteId)}`:frameworkRunHref(value.parent.requestId)}>Original {"suiteId" in value.parent?"suite":"test"}</a>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">Rerun</h2><HistoryStatus outcome={value.outcome}/></div><p>{value.passed}/{value.attempts.length} passed with complete evidence · {value.reason}</p>
    <p className="text-sm">This verdict covers only these attempts. The original result is unchanged.</p>
    {value.attempts.some(a=>a.status==="admission-pending")&&<p><TestingButton busy={reconciling} onClick={reconcile}>{value.state==="preview"?"Submit recorded preview":"Reconcile pending admissions"}</TestingButton></p>}{reconcileMessage&&<p role="status">{reconcileMessage}</p>}
    {value.attempts.map((a, index)=><div key={a.attemptId} className="mt-4 rounded-xl border border-[#e0e4de] p-4"><h3 className="font-semibold">Routine attempt {index + 1}</h3><AttemptLine attempt={a}/><details className="mt-2 text-xs text-[#747780]"><summary className="cursor-pointer">Member identity</summary><code>{a.memberId}</code></details><AttemptHistory suiteId={"suiteId" in value.parent?value.parent.suiteId:undefined} originalRequestId={"requestId" in value.parent?value.parent.requestId:undefined} memberId={a.memberId}/></div>)}</section>;
}

export function RunRerunLinks({requestId}:{requestId:string}) {
  const [open,setOpen]=useState(false);
  const lineage=useQuery({queryKey:["rerun-lineage",requestId],queryFn:()=>api<{original?:{suiteId:string;memberId:string}|null;lineage:{parent:RerunPlan["parent"];memberId:string;rerunId:string;predecessorAttemptId:string}|null}>(`/api/admin/test-runs/reruns/request/${encodeURIComponent(requestId)}/lineage`)});
  if(lineage.error)return <p>Rerun history unavailable. <TestingButton onClick={()=>lineage.refetch()}>Retry</TestingButton></p>;
  if(!lineage.data)return null;
  const value=lineage.data.lineage;
  const original=lineage.data.original;
  const parent=value?.parent??(original?{suiteId:original.suiteId}:{requestId});
  const memberId=value?.memberId??original?.memberId??requestId;
  return <div className="my-3">{value ? <><a className={TESTING_LINK} href={`/?testRerun=${encodeURIComponent(value.rerunId)}`}>Containing rerun</a> · <a className={TESTING_LINK} href={frameworkRunHref(value.predecessorAttemptId)}>Predecessor</a> · <a className={TESTING_LINK} href={"suiteId" in value.parent?`/?testSuite=${encodeURIComponent(value.parent.suiteId)}`:frameworkRunHref(value.parent.requestId)}>Original</a></> : null}
    <TestingButton className="ml-3" onClick={()=>setOpen(true)}>Rerun this test</TestingButton>
    <AttemptHistory suiteId={"suiteId" in parent?parent.suiteId:undefined} originalRequestId={"requestId" in parent?parent.requestId:undefined} memberId={memberId}/>
    {open&&<RerunForm suiteId={"suiteId" in parent?parent.suiteId:undefined} originalRequestId={"requestId" in parent?parent.requestId:undefined} memberIds={[memberId]} onClose={()=>setOpen(false)}/>}</div>;
}

export function ChildReruns({suiteId}:{suiteId:string}) {
  const [before,setBefore]=useState<string|null>(null);
  const result=useQuery({queryKey:["rerun-children",suiteId,before],queryFn:()=>api<{children:{rerunId:string;reason:string;createdAt?:string}[];nextCursor:string|null}>(`/api/admin/test-runs/reruns/suite/${encodeURIComponent(suiteId)}/children${before?`?before=${encodeURIComponent(before)}`:""}`),refetchInterval:15000});
  return <div>{result.error&&<p>Rerun batches unavailable. <TestingButton onClick={()=>result.refetch()}>Retry</TestingButton></p>}{result.data?.children.map(child=><p key={child.rerunId}><a className={TESTING_LINK} href={`/?testRerun=${encodeURIComponent(child.rerunId)}`}>Rerun: {child.reason}</a>{child.createdAt&&<> · {new Date(child.createdAt).toLocaleString()}</>}</p>)}
    {result.data?.nextCursor&&<TestingButton onClick={()=>setBefore(result.data!.nextCursor)}>Older rerun batches</TestingButton>}{before&&<TestingButton className="ml-3" onClick={()=>setBefore(null)}>Latest batches</TestingButton>}</div>;
}
