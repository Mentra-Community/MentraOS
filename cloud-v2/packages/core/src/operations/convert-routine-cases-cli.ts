import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {convertRoutineCases} from './convert-routine-cases'
import {caseDetailArchive} from '../services/routine-case.service'
import {connectMongo,disconnectMongo,withTransaction} from '../connections/mongo.connection'
import {RoutineCaseModel,RoutineCaseActivityModel} from '../models/routine-case.model'
import mongoose from 'mongoose'
import {requestInputDigest} from '../services/test-request.service'
import {routineCaseSchema} from '../types/routine-case.types'

/** Operator supplies the independently backed-up/drained inventory and exact reviewed digests. No source mutation or deletion. */
async function main() {
  const [mode,inputPath,expectedInput,drainPath,expectedDrain,outputPath]=process.argv.slice(2)
  if(!['rehearse','apply'].includes(mode??'')||!inputPath||!drainPath||!outputPath||![expectedInput,expectedDrain].every(v=>/^[a-f0-9]{64}$/.test(v??'')))
    throw Error('Usage: bun convert-routine-cases-cli.ts rehearse|apply inventory.json inventory-sha256 drain.json drain-sha256 receipt.json')
  const read=async(path:string,sha:string)=>{const body=await readFile(path);if(createHash('sha256').update(body).digest('hex')!==sha)throw Error('Reviewed finite input digest changed');return JSON.parse(body.toString())}
  const input=await read(inputPath,expectedInput!),drain=await read(drainPath,expectedDrain!)
  if(process.env.ROUTINE_CASE_API_ENABLED==='true')throw Error('Case writer must remain disabled during finite conversion')
  if(mode==='apply') {
    if(!process.env.MONGO_URL||!process.env.ROUTINE_CASE_SOURCE_MONGO_URL||!process.env.ROUTINE_CASE_SOURCE_DATABASE)throw Error('Target Core and source case database connections must be explicitly provisioned')
    const source=new mongoose.mongo.MongoClient(process.env.ROUTINE_CASE_SOURCE_MONGO_URL,{serverSelectionTimeoutMS:10000})
    try {
      await source.connect()
      const db=source.db(process.env.ROUTINE_CASE_SOURCE_DATABASE)
      if(db.databaseName!==input.database)throw Error('Source case namespace differs from the reviewed inventory')
      const cases=await db.collection('routine_cases').find({},{maxTimeMS:10000}).limit(10001).toArray()
      const occurrences=await db.collection('agent_runs').find({$or:[{miniCase:{$exists:true}},{taskKind:'routine-failure'}]},{maxTimeMS:10000}).limit(10001).toArray()
      const stable=(rows:Array<Record<string,unknown>>)=>JSON.parse(JSON.stringify(rows.sort((a,b)=>String(a.caseId??a.runId??'').localeCompare(String(b.caseId??b.runId??'')))))
      if(requestInputDigest(stable(cases as Array<Record<string,unknown>>))!==requestInputDigest(stable(input.cases))||requestInputDigest(stable(occurrences as Array<Record<string,unknown>>))!==requestInputDigest(stable(input.occurrences)))
        throw Error('Live source changed after drain; reconcile the exact inventory before conversion')
    }finally{await source.close()}
    await connectMongo(process.env.MONGO_URL)
  }
  try {
    const result=await convertRoutineCases(input,drain,caseDetailArchive(),mode==='apply'?{
      async read(caseId){const row=await RoutineCaseModel.findOne({caseId}).read('primary').readConcern('majority').lean();return row?routineCaseSchema.parse(row.payload):null},
      async insert(row,event){await withTransaction(async session=>{
        await RoutineCaseModel.create([{caseId:row.caseId,version:2,revision:row.revision,generation:row.generation,rootKeys:row.occurrences.map(o=>o.rootKey),payload:row}],{session})
        await RoutineCaseActivityModel.create([{caseId:row.caseId,revision:row.revision,...event,actor:'operator:finite-canonical-conversion',at:row.updatedAt,kind:'migration',
          changed:['schema','namespace',...(resultClaim(row.caseId,drain)?['settled-stopped-unlaunched-claim']:[])]}],{session})
      })},
    }:undefined)
    await writeFile(outputPath,JSON.stringify({...result,expectedInputSha256:expectedInput,expectedDrainSha256:expectedDrain,mode,completedAt:new Date().toISOString()},null,2),{mode:0o600})
    console.log(JSON.stringify({mode,caseCount:result.caseCount,occurrenceCount:result.occurrenceCount,inboxCount:result.inboxCount,settledClaimIds:result.settledClaimIds,receipt:outputPath}))
  }finally{if(mode==='apply')await disconnectMongo()}
}
const resultClaim=(id:string,drain:{mini?:{caseId?:string}})=>drain.mini?.caseId===id
if(import.meta.main)main().catch(error=>{console.error(error instanceof Error?error.message:'Case conversion failed');process.exitCode=1})
