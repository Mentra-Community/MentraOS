import {expect,test} from 'bun:test'
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import {CopyRerunLabel} from './copy-rerun-label'

test('copy uses the verified server label and reports ambiguous references without copying',async()=>{
 const originalFetch=globalThis.fetch, originalNavigator=globalThis.navigator
 const copied:string[]=[],requests:string[]=[];let reject=false,view!:ReactTestRenderer
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{async writeText(value:string){copied.push(value)}}}})
 globalThis.fetch=(async(input:unknown)=>{requests.push(String(input));return reject?Response.json({message:'Reference is ambiguous'},{status:422}):Response.json({label:'rerun:gallery:r:original'})}) as typeof fetch
 try {
  await act(async()=>{view=create(<CopyRerunLabel routineId="gallery" kind="r" targetId="original"/>)})
  await act(async()=>{await view.root.findByType('button').props.onClick()})
  expect(requests[0]).toContain('routineId=gallery&kind=r&targetId=original');expect(copied).toEqual(['rerun:gallery:r:original'])
  expect(JSON.stringify(view.toJSON())).toContain('Copied')
  reject=true;await act(async()=>{await view.root.findByType('button').props.onClick()})
  expect(copied).toHaveLength(1);expect(view.root.findByProps({role:'alert'}).children.join('')).toContain('Reference is ambiguous')
 }finally{await act(async()=>view?.unmount());globalThis.fetch=originalFetch;Object.defineProperty(globalThis,'navigator',{configurable:true,value:originalNavigator})}
})
