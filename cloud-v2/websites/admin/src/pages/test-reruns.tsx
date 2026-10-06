import {useState} from "react";
import {useQuery, useQueryClient} from "@tanstack/react-query";
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
  return <p className="my-2 text-sm"><a className="underline" href={attemptHref(attempt)}>{attempt.attemptNumber === 0 ? "Original" : `Attempt ${attempt.attemptNumber}`} · {attempt.status}</a>
    {attempt.status === "pass" && !attempt.publicationComplete && " · Evidence incomplete"}
    {attempt.build && <> · App {attempt.build.headSha.slice(0,10)}{source && <> · Build {source.buildRunId}, publication {source.publicationAttempt}</>}</>}
    {!!attempt.build?.archive && <span className="block text-xs">Artifact {(attempt.build.archive as {sha256:string}).sha256.slice(0,12)}</span>}
    {attempt.definitionRevision && <> · Definition {attempt.definitionRevision.slice(0,10)}</>}
    {attempt.createdAt && <> · {new Date(attempt.createdAt).toLocaleString()}</>}
    {attempt.rerunId && <> · <a className="underline" href={`/?testRerun=${encodeURIComponent(attempt.rerunId)}`}>Rerun batch</a></>}
    {attempt.reason && <span className="block text-[#68746d]">{attempt.reason}</span>}</p>;
}
export function AttemptHistory({suiteId, memberId, originalRequestId}: {suiteId?:string;memberId:string;originalRequestId?:string}) {
  const [open,setOpen]=useState(false), [before,setBefore]=useState<number | null>(null);
  const history=useQuery({queryKey:["rerun-history",suiteId??originalRequestId,memberId,before],enabled:open,
    queryFn:()=>api<{original:RerunAttempt;attempts:RerunAttempt[];nextBefore:number|null}>(`/api/admin/test-runs/reruns/${suiteId?`suite/${encodeURIComponent(suiteId)}/members/${encodeURIComponent(memberId)}`:`request/${encodeURIComponent(originalRequestId!)}`}/history${before ? `?before=${before}` : ""}`),refetchInterval:15000});
  return <details onToggle={e=>setOpen(e.currentTarget.open)}><summary className="cursor-pointer text-sm underline">Attempt history</summary>
    {history.error && <p role="alert">History unavailable. <button onClick={()=>history.refetch()}>Retry</button></p>}
    {history.data && <><AttemptLine attempt={history.data.original}/>{history.data.attempts.map(a=><AttemptLine key={a.attemptId} attempt={a}/>)}
      {history.data.nextBefore && <button onClick={()=>setBefore(history.data!.nextBefore)}>Older attempts</button>}
      {before && <button className="ml-3" onClick={()=>setBefore(null)}>Latest attempts</button>}</>}</details>;
}
type Preview={rerunId:string;previewDigest:string;plan:RerunPlan;state:string};
export function RerunForm({suiteId, originalRequestId, memberIds, onClose}: {suiteId?:string;originalRequestId?:string;memberIds:string[];onClose:()=>void}) {
  const [override,setOverride]=useState(false);
  const [channel,setChannel]=useState<TestBuildSource["channel"]>("dev"), [build,setBuild]=useState(""),[publication,setPublication]=useState("1"),[pr,setPr]=useState(""),[reason,setReason]=useState("");
  const [id,setId]=useState(()=>crypto.randomUUID()),[preview,setPreview]=useState<Preview|null>(null),[message,setMessage]=useState(""),[busy,setBusy]=useState(false),[entered,setEntered]=useState(false),[previewEntered,setPreviewEntered]=useState(false);
  const client=useQueryClient();
  async function prepare() {
    setBusy(true); setMessage("");
    try {
      for(const value of override?[build,publication,...(channel==="pr"?[pr]:[])]:[]) if(!/^[1-9]\d*$/.test(value)||!Number.isSafeInteger(Number(value))) throw new Error("Enter exact positive build/publication coordinates.");
      const source:TestBuildSource|undefined=!override?undefined:channel==="pr"?{channel,prNumber:Number(pr),buildRunId:Number(build),publicationAttempt:Number(publication)}:{channel,buildRunId:Number(build),publicationAttempt:Number(publication)};
      if(!reason.trim()) throw new Error("Enter a reason for this rerun.");
      setPreviewEntered(true);
      const value=await api<Preview>("/api/admin/test-runs/reruns/preview",{method:"POST",body:{rerunId:id,parent:suiteId?{suiteId}:{requestId:originalRequestId},selection:{memberIds},...(source?{source}:{}),reason}});setPreview(value);
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
  return <div className="my-4 rounded-xl border p-4 space-y-3"><h3 className="font-semibold">Rerun {memberIds.length} selected item{memberIds.length!==1?"s":""}</h3>
    <p className="text-sm">Reuse the original MentraOS artifact, or choose a replacement. The machine uses its installed framework and current enrolled definition.</p>
    <label className="block"><input type="checkbox" checked={override} disabled={previewEntered||busy} onChange={e=>setOverride(e.target.checked)}/> Use a different MentraOS artifact</label>
    {override&&<div className="flex flex-wrap gap-3"><label>Channel <select value={channel} disabled={previewEntered||busy} onChange={e=>setChannel(e.target.value as TestBuildSource["channel"])}>{["dev","staging","pr"].map(v=><option key={v}>{v}</option>)}</select></label>
      {channel==="pr"&&<label>PR <input value={pr} disabled={previewEntered||busy} onChange={e=>setPr(e.target.value)}/></label>}
      <label>Build workflow ID <input value={build} disabled={previewEntered||busy} onChange={e=>setBuild(e.target.value)}/></label>
      <label>Publication attempt <input value={publication} disabled={previewEntered||busy} onChange={e=>setPublication(e.target.value)}/></label>
      </div>}
    <div><label>Reason <input value={reason} disabled={previewEntered||busy} onChange={e=>setReason(e.target.value)}/></label></div>
    {preview&&<ul>{preview.plan.members.map(m=><li key={m.memberId}>{m.input.routineId} · {m.input.platform} · App {m.input.build.headSha.slice(0,10)} · Definition {m.input.definitionRevision.slice(0,10)} · {m.hostId}/{m.input.laneId}</li>)}</ul>}
    <button disabled={busy} className="underline" onClick={preview?submit:prepare}>{busy?"Working…":preview?entered?"Reconcile same submission":"Submit this preview":"Preview rerun"}</button>
    <button className="ml-4 underline" disabled={busy} onClick={onClose}>Close</button>
    {!entered&&<button className="ml-4 underline" disabled={busy} onClick={()=>{setId(crypto.randomUUID());setPreview(null);setPreviewEntered(false);setMessage("New preview; any prior preview remains unsubmitted.");}}>Start fresh preview</button>}
    {preview&&<a className="ml-4 underline" href={`/?testRerun=${encodeURIComponent(preview.rerunId)}`}>View rerun</a>}
    {message&&<p role="status">{message}</p>}</div>;
}
export function TestRerunPage({rerunId}:{rerunId:string}) {
  const [reconcileMessage,setReconcileMessage]=useState("");
  const [reconciling,setReconciling]=useState(false);
  const result=useQuery({queryKey:["test-rerun",rerunId],queryFn:()=>api<{previewDigest:string;parent:RerunPlan["parent"];reason:string;source?:TestBuildSource;outcome:string;passed:number;attempts:RerunAttempt[];state:string}>(`/api/admin/test-runs/reruns/${encodeURIComponent(rerunId)}`),refetchInterval:15000});
  if(result.error)return <p role="alert">Rerun unavailable. <button onClick={()=>result.refetch()}>Retry</button></p>;
  if(!result.data)return <p>Loading rerun…</p>;
  const value=result.data;
  async function reconcile() {
    setReconciling(true);
    try {await api("/api/admin/test-runs/reruns/submit",{method:"POST",body:{rerunId,previewDigest:value.previewDigest}});await result.refetch();setReconcileMessage("Submission reconciled.");}
    catch(error){setReconcileMessage(error instanceof Error?error.message:"Reconciliation unavailable; retry the same rerun.");}
    finally{setReconciling(false);}
  }
  return <section className="rounded-2xl border bg-white p-6"><a className="underline" href={"suiteId" in value.parent?`/?testSuite=${encodeURIComponent(value.parent.suiteId)}`:frameworkRunHref(value.parent.requestId)}>Original {"suiteId" in value.parent?"suite":"test"}</a>
    <h2 className="mt-3 text-xl font-bold">Linked rerun · {value.outcome}</h2><p>{value.passed}/{value.attempts.length} passed · {value.reason}</p>
    <p className="text-sm">This verdict covers only these attempts. The original result is unchanged.</p>
    {value.attempts.some(a=>a.status==="admission-pending")&&<p><button className="underline" disabled={reconciling} onClick={reconcile}>{value.state==="preview"?"Submit recorded preview":"Reconcile pending admissions"}</button></p>}{reconcileMessage&&<p role="status">{reconcileMessage}</p>}
    {value.attempts.map(a=><div key={a.attemptId}><h3 className="mt-4 font-semibold">{a.memberId}</h3><AttemptLine attempt={a}/><AttemptHistory suiteId={"suiteId" in value.parent?value.parent.suiteId:undefined} originalRequestId={"requestId" in value.parent?value.parent.requestId:undefined} memberId={a.memberId}/></div>)}</section>;
}

export function RunRerunLinks({requestId}:{requestId:string}) {
  const [open,setOpen]=useState(false);
  const lineage=useQuery({queryKey:["rerun-lineage",requestId],queryFn:()=>api<{original?:{suiteId:string;memberId:string}|null;lineage:{parent:RerunPlan["parent"];memberId:string;rerunId:string;predecessorAttemptId:string}|null}>(`/api/admin/test-runs/reruns/request/${encodeURIComponent(requestId)}/lineage`)});
  if(lineage.error)return <p>Rerun history unavailable. <button onClick={()=>lineage.refetch()}>Retry</button></p>;
  if(!lineage.data)return null;
  const value=lineage.data.lineage;
  const original=lineage.data.original;
  const parent=value?.parent??(original?{suiteId:original.suiteId}:{requestId});
  const memberId=value?.memberId??original?.memberId??requestId;
  return <div className="my-3">{value ? <><a className="underline" href={`/?testRerun=${encodeURIComponent(value.rerunId)}`}>Containing rerun</a> · <a className="underline" href={frameworkRunHref(value.predecessorAttemptId)}>Predecessor</a> · <a className="underline" href={"suiteId" in value.parent?`/?testSuite=${encodeURIComponent(value.parent.suiteId)}`:frameworkRunHref(value.parent.requestId)}>Original</a></> : null}
    <button className="ml-3 underline" onClick={()=>setOpen(true)}>Rerun this test</button>
    <AttemptHistory suiteId={"suiteId" in parent?parent.suiteId:undefined} originalRequestId={"requestId" in parent?parent.requestId:undefined} memberId={memberId}/>
    {open&&<RerunForm suiteId={"suiteId" in parent?parent.suiteId:undefined} originalRequestId={"requestId" in parent?parent.requestId:undefined} memberIds={[memberId]} onClose={()=>setOpen(false)}/>}</div>;
}

export function ChildReruns({suiteId}:{suiteId:string}) {
  const [before,setBefore]=useState<string|null>(null);
  const result=useQuery({queryKey:["rerun-children",suiteId,before],queryFn:()=>api<{children:{rerunId:string;reason:string;createdAt?:string}[];nextCursor:string|null}>(`/api/admin/test-runs/reruns/suite/${encodeURIComponent(suiteId)}/children${before?`?before=${encodeURIComponent(before)}`:""}`),refetchInterval:15000});
  return <div>{result.error&&<p>Rerun batches unavailable. <button onClick={()=>result.refetch()}>Retry</button></p>}{result.data?.children.map(child=><p key={child.rerunId}><a className="underline" href={`/?testRerun=${encodeURIComponent(child.rerunId)}`}>Rerun: {child.reason}</a>{child.createdAt&&<> · {new Date(child.createdAt).toLocaleString()}</>}</p>)}
    {result.data?.nextCursor&&<button className="underline" onClick={()=>setBefore(result.data!.nextCursor)}>Older rerun batches</button>}{before&&<button className="ml-3 underline" onClick={()=>setBefore(null)}>Latest batches</button>}</div>;
}
