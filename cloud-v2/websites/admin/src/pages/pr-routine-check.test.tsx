import {expect, test} from 'bun:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {PrRoutineCheckPage, readPrCheckId, type PrCheckView} from './pr-routine-check'
const id = 'pr-check-' + 'a'.repeat(64)
const view: PrCheckView = {gateId: id, coverageGeneration: 1, attemptGeneration: 2, canCancel: true, cancelling: false,
 check: {status: 'queued', output: {title: 'Routine tests in progress'}}, resultsUrl: '/?testSuite=original',
 members: [{id: 'login.android', title: 'Account login', lane: 'Air 1 Android', status: 'running', activity: 'test: Verify login'}], delivery: {pending: false}}
function render(value: PrCheckView) {
 const client = new QueryClient(); client.setQueryData(['pr-routine-check', id], value)
 return renderToStaticMarkup(<QueryClientProvider client={client}><PrRoutineCheckPage gateId={id}/></QueryClientProvider>)
}
test('gate links validate exactly one identity', () => {
 expect(readPrCheckId('?prCheck=' + id)).toBe(id)
 expect(readPrCheckId('?prCheck=../bad')).toBeNull(); expect(readPrCheckId('?prCheck=' + id + '&prCheck=' + id)).toBeNull()
})
test('active gate shows guarded cancellation, current activity and existing result link', () => {
 const html = render(view)
 expect(html).toContain('Cancel routine tests'); expect(html).toContain('Air 1 Android'); expect(html).toContain('Verify login')
 expect(html).toContain('href="/?testSuite=original"'); expect(html).toContain('Refreshes every 15 seconds')
})
test('cancelling and terminal gate hide Cancel without declaring cleanup complete', () => {
 const stopping = render({...view, canCancel: false, cancelling: true})
 expect(stopping).not.toContain('Cancel routine tests'); expect(stopping).toContain('ordinary cleanup is still settling')
 expect(render({...view, canCancel: false, check: {status: 'completed', output: {title: 'Routine tests did not pass'}}})).not.toContain('Cancel routine tests')
})
