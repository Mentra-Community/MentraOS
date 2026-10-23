import {expect,test} from 'bun:test'
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import {Tooltip} from './tooltip'
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
test('tooltip responds to hover and keyboard focus, dismisses with Escape, and supports disabled controls',async()=>{
 let view!:ReactTestRenderer
 await act(async()=>{view=create(<Tooltip content="A running job continues." disabled><button disabled>Pause</button></Tooltip>)})
 const wrapper=()=>view.root.findAllByType('span')[0]!, tip=()=>view.root.findByProps({role:'tooltip'})
 expect(wrapper().props.tabIndex).toBe(0);expect(tip().props.className).toBe('sr-only')
 expect(view.root.findByType('button').props['aria-describedby']).toBe(tip().props.id)
 await act(async()=>wrapper().props.onMouseEnter());expect(tip().props.className).not.toBe('sr-only')
 await act(async()=>wrapper().props.onMouseLeave());expect(tip().props.className).toBe('sr-only')
 await act(async()=>wrapper().props.onFocus());expect(tip().props.className).not.toBe('sr-only')
 await act(async()=>wrapper().props.onMouseLeave());expect(tip().props.className).not.toBe('sr-only')
 await act(async()=>wrapper().props.onKeyDown({key:'Escape'}));expect(tip().props.className).toBe('sr-only')
 await act(async()=>wrapper().props.onFocus());await act(async()=>wrapper().props.onBlur());expect(tip().props.className).toBe('sr-only')
 await act(async()=>view.unmount())
})
